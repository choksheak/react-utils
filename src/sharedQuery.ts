/**
 * @packageDocumentation
 *
 * The "shared query" is a data fetching convenience library that helps users
 * to load data, check for staleness and expiration, cache in memory, local
 * storage or indexed db, and be able to manipulate the data anytime.
 *
 * Each shared query creates a new private shared state that handles the data
 * storage. This shared state contains the records for all queries, where each
 * query is a unique set of arguments used to make the query. The number of
 * records and the total byte size of data can be limited so as to ensure the
 * query does not take up too much memory.
 *
 * Think of shared queries as like the open source npm package "react-query",
 * but with strong type-checking and built-in support for persistence.
 *
 * Example:
 * ```
 *   import { sharedQuery, useSharedQuery } from "@choksheak/react-utils/sharedQuery";
 *   import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
 *
 *   // Create a new shared query in the top level scope.
 *   // The query function `queryFn` here does not take any arguments.
 *   //
 *   // Only the queryName and queryFn are required and everything else is
 *   // optional.
 *   //
 *   // The queryName must be unique, otherwise we will throw an
 *   // error. This is because defining the same queryName for two different
 *   // queries implies that the queries are the same, thus violating the idea
 *   // of a "shared" query, and almost certainly points to a bug in the code.
 *   export const usersQuery = sharedQuery({
 *     queryName: "users",
 *     queryFn: listUsers,
 *     persistTo: "indexedDb",
 *     staleMs: MS_PER_DAY,
 *   });
 *
 *   // Example of using a query function with arguments.
 *   export const getUserQuery = sharedQuery({
 *     queryName: "getUser",
 *     queryFn: getUser, // getUser(userId: string) => User
 *     persistTo: "indexedDb",
 *     staleMs: MS_PER_DAY,
 *   });
 *
 *   export const UsersComponent: React.FC = () => {
 *     // Second argument is optional, and is an array of arguments to be
 *     // passed to the `queryFn`.
 *     const users = useSharedQuery(usersQuery);
 *
 *     return (
 *       <>
 *         <h1>List of Users</h1>
 *
 *         <button onclick={users.refetch}>Refresh</button>
 *
 *         {users.loading && <Loader />}
 *
 *         {users.error && !users.data && <p>Error: {String(users.error)}</p>}
 *
 *         <p>Data: {users.data ? JSON.stringify(users.data) : "-"}</p>
 *       </>
 *     );
 *   };
 *
 *   export const AnotherComponent: React.FC = () => {
 *      // This query will be deduped with the one above, sharing the same
 *      // data and the same fetches.
 *      const users = useSharedQuery(usersQuery);
 *      ...
 *   };
 *
 *   export const DisplayOneUser: React.FC<{userId: string}> = ({userId}) => {
 *      // Example of using the query with an argument. Whenever the argument
 *      // changes, the data will be fetched and updated automatically.
 *      const user = useSharedQuery(getUserQuery, userId);
 *
 *      // You can check for user.loading and user.error if needed.
 *
 *      return <>User: {user.data ? JSON.stringify(user.data) : "-"}</>;
 *   };
 * ```
 */

import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import getByteSize from "object-sizeof";
import {
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fetcher } from "./fetcher";
import { sharedState, SharedStateOptions, useSharedState } from "./sharedState";
import { PersistTo } from "./storage";
import { stringifyDeterministicForKeys } from "./stringify";
import { useDeepMemo } from "./useDeepMemo";

/** Type of the queryFn used to fetch the data from source. */
export type QueryFn<TArgs extends unknown[], TData> = (
  ...args: TArgs
) => Promise<TData> | TData;

/** An entry for a persisted state corresponding to one query key. */
export type QueryStateValue<TData> = Readonly<{
  /**
   * When this record was last updated. Used for LRU determination. If you want
   * the data age, please use `dataUpdatedMs` instead.
   */
  lastUpdatedMs: number;

  loading: boolean;
  data?: TData;
  dataUpdatedMs?: number;

  /**
   * Use unknown type for error because we can't assume what type of variable
   * will be thrown from the query function. We also don't want to add this
   * type to QueryStateValue<TError> as it adds complexity to the type.
   */
  error?: unknown;

  errorUpdatedMs?: number;
}>;

/** Return type for useSharedQuery(). */
export type UseQueryResult<TData> = QueryStateValue<TData> &
  Readonly<{
    /**
     * Usually same as `data`, but if you specify `keepLastNonEmptyData: true`,
     * then this will contain the latest data (undefined when args just changed)
     * and data will contain the last non empty data.
     */
    latestData: TData | undefined;

    /**
     * Cancels the inflight query (if any). Returns true if canceled.
     */
    abortCurrentQuery: (reason?: unknown) => boolean;

    /**
     * Manually refresh the data by doing a new query.
     */
    refetch: () => Promise<void>;

    /**
     * If you got the data from somewhere else (e.g. an in-memory data update),
     * just set it directly.
     */
    setData: (data: TData, dataUpdatedMs?: number) => void;

    deleteData: () => void;
  }>;

/**
 * The full query state is a record of all the fetch states mapped by
 * query key to the state entry.
 */
export type SharedQueryState<TData> = Record<string, QueryStateValue<TData>>;

export type QueryTargetWithFn<TArgs extends unknown[], TData> = {
  /**
   * The name could have been auto-generated, but we let the user give us a
   * human-readable name that can be identified quickly in the logs.
   * Note that the queryKey is a string formed by the queryName plus the query
   * arguments.
   */
  queryName: string;

  /** Function to fetch data. */
  queryFn: QueryFn<TArgs, TData>;
};

export type QueryTargetWithUrl = {
  /**
   * The queryName can optionally be specified, else we will fallback to use
   * the url as the queryName.
   */
  queryName?: string;

  /**
   * URL to fetch data using HTTP GET. Note that using this field will cause
   * both TArgs and TData to be undefined (unknown). Therefore you can make up
   * for this by specifying types with useSharedQuery, like this:
   * ```
   * const usersQuery = useSharedQuery<[{ userId?: string[] }], User[]>({
   *   url: "/api/list-users",
   * });
   * ```
   *
   * If `userId` were specified as ["u1", "u2"], the query url would be
   * "/api/list-users?userId=u1&userId=u2".
   *
   * You can also pass the params as a string like "userId=u1&userId=u2".
   * ```
   * const usersQuery = useSharedQuery<[string], User[]>({
   *   url: "/api/list-users",
   * });
   * ```
   */
  url: string;
};

/** Specifies how to fetch the data. */
export type QueryTarget<TArgs extends unknown[], TData> =
  | QueryTargetWithFn<TArgs, TData>
  | QueryTargetWithUrl;

/** Options to configure a shared query. */
export type SharedQueryOptions<TArgs extends unknown[], TData> = QueryTarget<
  TArgs,
  TData
> & {
  /**
   * Function to re-fetch data. Usually this would just be the `queryFn`, but
   * if you need a different behavior for refetching, then specify this.
   */
  refetchFn?: QueryFn<TArgs, TData>;

  /**
   * ms before data considered stale; 0 means always stale.
   */
  staleMs?: number;

  /**
   * ms before data is removed from cache; 0 means never expire.
   */
  expiryMs?: number;

  /**
   * Trigger background re-fetch if stale.
   */
  refetchOnStale?: boolean;

  /**
   * Shortcut to set the localStorageKey or indexedDbKey automatically from
   * queryName. This is important because it avoids requiring the user to
   * specify the same queryName twice everytime.
   */
  persistTo?: PersistTo;

  /**
   * Max number of entries to keep. The oldest entries will be discarded.
   * The last record cannot be discarded. 0 means no limit.
   */
  maxSize?: number;

  /**
   * Max number of bytes to keep. The oldest entries will be discarded.
   * The last record cannot be discarded. 0 means no limit.
   */
  maxBytes?: number;

  /**
   * Keep a copy of the last non-empty data so that when you change the
   * query arguments, you can still display the old data while waiting for the
   * new data to load.
   */
  keepLastNonEmptyData?: boolean;

  /**
   * Customize the logger.
   */
  log?: (...args: unknown[]) => void;
} & SharedStateOptions<SharedQueryState<TData>>;

/** Users can override these values globally. */
export const SharedQueryConfig = {
  /** Refetch on every page load. */
  staleMs: 0,

  /** Keep in cache for a long time. */
  expiryMs: 30 * MS_PER_DAY,

  /** Always refetch automatically if the data is stale. */
  refetchOnStale: true,

  /** No default persistence configured. */
  persistTo: undefined as PersistTo | undefined,

  /** 100 is not too large, but please tweak accordingly. */
  maxSize: 100,

  /** 100kb limit before discarding old records. */
  maxBytes: 100_000,

  /** Default to log to console. */
  log: (...args: unknown[]) => console.log("[sharedQuery]", ...args),
};

export type SharedQueryConfig = typeof SharedQueryConfig;

/** Convenience function to update global defaults. */
export function configureSharedQuery(config: Partial<SharedQueryConfig>) {
  Object.assign(SharedQueryConfig, config);
}

/** Whether this is a normal query or an explicit refetch. */
type QueryType = "query" | "refetch";

// Disallow duplicate query names.
const seenQueryNames = new Set<string>();

/**
 * Create a reusable shared query object that can be used to auto de-duplicate
 * and cache all data fetches, with auto-expiration and staleness checks.
 *
 * Each `queryName` must be unique, and can only be declared once, most often
 * in the top level scope. The queryName is mainly used for logging and also
 * used as the storage key when you use the top-level `persistTo`.
 *
 * Example:
 * ```
 *   export const usersQuery = sharedQuery({
 *     queryName: "users",
 *     queryFn: listUsers,
 *     persistTo: "indexedDb",
 *     staleMs: MS_PER_DAY,
 *   });
 * ```
 */
export function sharedQuery<TArgs extends unknown[], TData>(
  // The name could have been auto-generated, but we let the user give us a
  // human-readable name that can be identified quickly in the logs.
  options: SharedQueryOptions<TArgs, TData>,
) {
  // If queryName is not specified, fallback to use url as the queryName.
  const url = (options as QueryTargetWithUrl).url || "";
  const queryName = options.queryName || url;

  if (!queryName) {
    throw new Error(`Either queryName or url must be specified.`);
  }

  if (seenQueryNames.has(queryName)) {
    throw new Error(`Duplicate shared query name "${queryName}"`);
  }
  seenQueryNames.add(queryName);

  const inflightQueries = new Map<
    string,
    { promise: Promise<TData>; abortController: AbortController }
  >();

  /**
   * Keep track of the mounted query keys. This handles the case where an
   * earlier-started query returns later, and when it returns, it was already
   * unmounted, thus making it eligible for clean up right after fetch.
   */
  const mountedKeys = new Map<string, number>();

  let queryFn: QueryFn<TArgs, TData>;

  if ((options as QueryTargetWithFn<TArgs, TData>).queryFn) {
    queryFn = (options as QueryTargetWithFn<TArgs, TData>).queryFn;
  } else if (url) {
    // Auto-generate the queryFn as a HTTP GET request using the url.
    queryFn = (...args: TArgs): Promise<TData> => {
      // If args are given, treat the first argument as a search param.
      let params = "";
      const firstArg = args?.[0];

      if (firstArg) {
        if (typeof firstArg === "string") {
          params = firstArg;
        } else if (typeof firstArg === "object") {
          const entries: [string, string][] = [];

          for (const [k, v] of Object.entries(firstArg)) {
            if (v === undefined) continue;

            // Allow the same param to be specified multiple times.
            if (Array.isArray(v)) {
              for (const item of v) {
                if (item === undefined) continue;

                // The field values can only be primitives, not objects.
                entries.push([k, String(item)]);
              }
            } else {
              // The field values can only be primitives, not objects.
              entries.push([k, String(v)]);
            }
          }

          params = new URLSearchParams(entries).toString();
        }

        if (params) {
          if (url.includes("?")) {
            // Append more search params to existing ones.
            params = "&" + params;
          } else {
            // Set the full search params string.
            params = "?" + params;
          }
        }
      }

      return fetcher
        .url(url + params)
        .get()
        .json();
    };
  } else {
    throw new Error(`Either queryFn or url must be specified`);
  }

  const refetchFn = options.refetchFn;

  const staleMs = options?.staleMs ?? SharedQueryConfig.staleMs;
  const expiryMs = options?.expiryMs ?? SharedQueryConfig.expiryMs;

  const refetchOnStale =
    options?.refetchOnStale ?? SharedQueryConfig.refetchOnStale;

  // Apply shortcut when using `persistTo`.
  // Specifying the `store` will take precedence over `persistTo`.
  const store = options.store;

  if (store) {
    // Wrap the isValid to account for the query state wrapper.
    if ("persistTo" in store && store.isValid) {
      const isValid = store.isValid;

      options = {
        ...options,
        store: {
          ...store,
          isValid: (u) => {
            // Supposed type of u: SharedQueryState<TData>
            if (!u || typeof u !== "object") {
              return false;
            }

            // Since each stored key could contain multiple values, and isValid
            // checks for each value, we need to check every value to make sure
            // they are valid.
            // Supposed type of v: QueryStateValue<TData>
            for (const v of Object.values(u)) {
              if (
                !v ||
                typeof v !== "object" ||
                !("data" in v) ||
                !("dataUpdatedMs" in v) ||
                !("lastUpdatedMs" in v) ||
                typeof v.dataUpdatedMs !== "number" ||
                typeof v.lastUpdatedMs !== "number" ||
                !isValid(v.data)
              ) {
                return false;
              }
            }

            return true;
          },
        },
      };
    }
  } else {
    const persistTo = options.persistTo ?? SharedQueryConfig.persistTo;

    if (persistTo) {
      options = {
        ...options,
        store: {
          persistTo,
          key: queryName,
          expiryMs,
        },
      };
    }
  }

  const maxSize = options?.maxSize ?? SharedQueryConfig.maxSize;
  const maxBytes = options?.maxBytes ?? SharedQueryConfig.maxBytes;

  const keepLastNonEmptyData = Boolean(options?.keepLastNonEmptyData);

  const log = options?.log ?? SharedQueryConfig.log;

  const queryState = sharedState<SharedQueryState<TData>>(
    {}, // defaultValue
    options,
  );

  function isStale(dataUpdatedMs: number): boolean {
    if (staleMs === 0) return true; // always stale

    const ageMs = Date.now() - dataUpdatedMs;
    return ageMs > staleMs;
  }

  function isExpired(dataUpdatedMs: number): boolean {
    if (expiryMs === 0) return false; // never expire

    const ageMs = Date.now() - dataUpdatedMs;
    return ageMs > expiryMs;
  }

  function enforceSizeLimit(): void {
    // Skip if there are no limits.
    if (!maxSize && !maxBytes) {
      return;
    }

    const oldState = queryState.getSnapshot();
    const oldSize = Object.keys(oldState).length;

    // Cannot do GC if size is 1 or less.
    if (oldSize <= 1) {
      return;
    }

    const oldByteSize = getByteSize(oldState);

    let numToCut = maxSize ? oldSize - maxSize : 0;
    let bytesToCut = maxBytes ? oldByteSize - maxBytes : 0;

    // Log to indicate why trimming was not needed.
    if (numToCut <= 0 && bytesToCut <= 0) {
      log(
        `No need to trim data for ${queryName}: size=${oldSize} (limit=${maxSize}), byteSize=${oldByteSize.toLocaleString()} (limit=${maxBytes.toLocaleString()})`,
      );
      return;
    }

    // Log to inform user that trimming is needed.
    log(
      `Need to trim ${queryName}: numToCut=${numToCut}, bytesToCut=${bytesToCut}`,
    );

    const newState = { ...oldState }; // shallow clone
    let needUpdate = false;

    const deleteKeyIfNotMounted = (key: string, expired: boolean) => {
      // Mounted keys cannot be cleaned up as they are visible in the UI.
      if (mountedKeys.has(key)) {
        log(`Cannot clean up ${key} as it is mounted`);
        return;
      }

      const byteSize = getByteSize(key) + getByteSize(newState[key]);
      log(
        `Cleaning up unmounted${expired ? ", expired" : ""} ${key} (byteSize=${byteSize.toLocaleString()})`,
      );

      numToCut--;
      bytesToCut -= byteSize;

      delete newState[key];
      needUpdate = true;
    };

    let entriesByTimeAscending = Object.entries(newState).sort(
      (entry1, entry2) => entry1[1].lastUpdatedMs - entry2[1].lastUpdatedMs,
    );

    // Clean up all expired entries. Note that the auto-expiration in the
    // storage adapter only applies to the entire state, which contains all
    // the different query keys and their values. Each query key has its own
    // timestamp and we need to apply our own expiration here.
    for (const [key] of entriesByTimeAscending) {
      // Anything after this is not expired yet.
      if (!isExpired(newState[key].lastUpdatedMs)) {
        break;
      }

      deleteKeyIfNotMounted(key, true);
    }

    if (numToCut > 0 || bytesToCut > 0) {
      if (needUpdate) {
        entriesByTimeAscending = Object.entries(newState).sort(
          (entry1, entry2) => entry1[1].lastUpdatedMs - entry2[1].lastUpdatedMs,
        );
      }

      // Clean up starting from oldest entry first.
      for (const [key] of entriesByTimeAscending) {
        deleteKeyIfNotMounted(key, false);

        if (numToCut <= 0 && bytesToCut <= 0) {
          break;
        }
      }
    }

    // Log to indicate why trimming was not needed.
    if (!needUpdate) {
      log(
        `No trimmable entries found for ${queryName}: size=${oldSize} (limit=${maxSize}), byteSize=${oldByteSize.toLocaleString()} (limit=${maxBytes.toLocaleString()})`,
      );
      return;
    }

    // Update the state.
    queryState.setValue(newState);

    // Log to inform user that the data was trimmed.
    log(
      `Trimmed data for ${queryName}: size=[${oldSize} -> ${Object.keys(newState).length}] (limit=${maxSize}), byteSize=[${oldByteSize.toLocaleString()} -> ${getByteSize(newState).toLocaleString()}] (limit=${maxBytes.toLocaleString()})`,
    );
  }

  function setData(
    queryKey: string,
    data: TData,
    dataUpdatedMs = Date.now(),
  ): void {
    const entry: QueryStateValue<TData> = {
      lastUpdatedMs: Date.now(),
      loading: false,
      data,
      dataUpdatedMs,
    };

    queryState.setValue((prev) => ({ ...prev, [queryKey]: entry }));

    enforceSizeLimit();
  }

  async function startFetching(
    queryKey: string,
    queryType: QueryType,
    args: TArgs,
  ) {
    log(`Start fetching ${queryKey}, queryType=${queryType}`);

    try {
      const data = await (queryType === "refetch" && refetchFn
        ? refetchFn(...args)
        : queryFn(...args));

      log(`Successfully fetched ${queryKey}`);
      setData(queryKey, data, Date.now());
      return data;
    } catch (e) {
      log(`Failed to fetch ${queryKey} for queryType=${queryType}: ${e}`);
      throw e;
    } finally {
      inflightQueries.delete(queryKey);
    }
  }

  function dedupedFetch(
    queryKey: string,
    queryType: QueryType,
    ...args: TArgs
  ): Promise<TData> {
    const inflightQuery = inflightQueries.get(queryKey);

    // De-duplicate in-flight requests. Note that queries and refetches are
    // also deduped because they should technically be trying to fetch the same
    // data.
    if (inflightQuery) {
      log(
        `Deduplicating inflight fetch for ${queryKey}, queryType=${queryType}`,
      );
      return inflightQuery.promise;
    }

    // Fetch new data
    const promise = startFetching(queryKey, queryType, args);
    const abortController = new AbortController();

    inflightQueries.set(queryKey, { promise, abortController });

    return promise;
  }

  const obj = {
    queryName,
    queryFn,
    refetchFn,
    expiryMs,
    staleMs,
    refetchOnStale,
    maxSize,
    maxBytes,
    keepLastNonEmptyData,
    log,
    queryState,

    /** Returns a key to identify requests based on the given args. */
    getQueryKey(args: TArgs): string {
      return queryName + ":" + stringifyDeterministicForKeys(args);
    },

    /**
     * Get the AbortController to abort the inflight query (if any).
     *
     * Note that once you get the controller, you can also get the signal easily
     * using `controller.signal`. So if you need both the controller and the
     * signal, just use this function.
     */
    getAbortController(args: TArgs): AbortController | null {
      const queryKey = obj.getQueryKey(args);
      return obj.getAbortControllerByKey(queryKey);
    },

    getAbortControllerByKey(queryKey: string): AbortController | null {
      return inflightQueries.get(queryKey)?.abortController ?? null;
    },

    /**
     * Get the AbortSignal to check for query abortions.
     *
     * Example:
     * ```
     *   const getUserQuery = sharedQuery({
     *     queryName: "getUser",
     *     queryFn: (userId: string) => {
     *       // Get the signal for this current execution.
     *       const signal = getUserQuery.getAbortSignal([userId]);
     *
     *       // Pass the signal to fetch so that it can be aborted.
     *       const response = await fetch(`/users/${userId}`, { signal });
     *
     *       // Check for errors.
     *       if (!response.ok) {
     *         throw new Error(response.statusText);
     *       }
     *
     *       // Return the data.
     *       return await response.json();
     *     },
     *   });
     * ```
     */
    getAbortSignal(args: TArgs): AbortSignal | null {
      const queryKey = obj.getQueryKey(args);
      return obj.getAbortSignalByKey(queryKey);
    },

    getAbortSignalByKey(queryKey: string): AbortSignal | null {
      return obj.getAbortControllerByKey(queryKey)?.signal ?? null;
    },

    /** For cached data, we need to return the correct timestamps as well. */
    async getCachedOrFetch(...args: TArgs): Promise<QueryStateValue<TData>> {
      // Important: wait for data to be loaded from cache first before trying to
      // fetch from server. This fixes a bad bug where the data is big, and the
      // code here starts a server fetch before the cache data loaded.
      const startMs = Date.now();
      await queryState.readyPromise;
      const waitedMs = Date.now() - startMs;

      const queryKey = obj.getQueryKey(args);
      const cached = queryState.getSnapshot()?.[queryKey];

      if (waitedMs) {
        log(`${queryKey}: Waited for ${waitedMs}ms before data is ready`);
      }

      if (cached?.data && !isExpired(cached.dataUpdatedMs ?? 0)) {
        // Return cached value if not stale.
        if (!isStale(cached.dataUpdatedMs ?? 0)) {
          log(`Return fresh data ${queryKey} from cache without fetching`);
          return cached;
        }

        // If stale, optionally update the data in the background.
        if (refetchOnStale) {
          log(`refetchOnStale for ${queryKey}`);
          void dedupedFetch(queryKey, "query", ...args);
        }

        // Still return stale data immediately.
        log(`Returning stale data for ${queryKey}`);
        return cached;
      }

      const data = await dedupedFetch(queryKey, "query", ...args);
      const now = Date.now();

      return {
        // Don't keep old error.
        lastUpdatedMs: now,
        loading: false,
        data,
        dataUpdatedMs: now,
      };
    },

    /** Get the entire stored entry for a query key. */
    getQueryValue(queryKey: string): QueryStateValue<TData> | undefined {
      return queryState.getSnapshot()?.[queryKey];
    },

    /** Get the current stored data for a query key. */
    getData(queryKey: string): TData | undefined {
      const stateValue: QueryStateValue<TData> | undefined =
        queryState.getSnapshot()?.[queryKey];

      // Check for expiration.
      if (stateValue?.lastUpdatedMs) {
        if (isExpired(stateValue.lastUpdatedMs)) {
          obj.deleteData(queryKey);
          return undefined;
        }
      }

      return stateValue?.data;
    },

    /** Set the data directly if the user obtained it from somewhere else. */
    setData,

    /**
     * Do a new fetch even when the data is already cached, but don't fetch if
     * another fetch is already inflight.
     */
    async updateFromSource(...args: TArgs): Promise<TData> {
      const key = obj.getQueryKey(args);
      return await dedupedFetch(key, "query", ...args);
    },

    /**
     * Perform an explicit refetch. If `options.refetchFn` was not specified,
     * then this would be identical to calling `obj.updateFromSource()`.
     */
    async refetch(...args: TArgs): Promise<TData> {
      const key = obj.getQueryKey(args);
      return await dedupedFetch(key, "refetch", ...args);
    },

    /** Delete the cached data for one set of arguments. */
    deleteData(queryKey: string): void {
      const record = queryState.getSnapshot();
      const clone = { ...record };
      delete clone[queryKey];
      queryState.setValue(clone);

      const inflight = inflightQueries.get(queryKey);
      if (inflight) {
        inflightQueries.delete(queryKey);
        inflight.abortController.abort("Deleted");
      }
    },

    /** Delete all currently cached data & all inflight promises. */
    clear(): void {
      queryState.delete();

      for (const { abortController } of Array.from(inflightQueries.values())) {
        abortController.abort("Cleared");
      }

      inflightQueries.clear();
    },

    /** Keep track of mounted keys. */
    mount(queryKey: string): void {
      mountedKeys.set(queryKey, (mountedKeys.get(queryKey) ?? 0) + 1);
    },

    /** Clean up mounted keys. */
    unmount(queryKey: string): void {
      const count = mountedKeys.get(queryKey);
      if (count === 1) {
        mountedKeys.delete(queryKey);
      } else {
        mountedKeys.set(queryKey, (count ?? 0) - 1);
      }
    },

    /**
     * Discard the oldest entries if the size exceeds the limit. The last
     * remaining record cannot be deleted no matter what the limit is.
     */
    enforceSizeLimit,
  } as const;

  return obj;
}

export type SharedQuery<TArgs extends unknown[], TData> = ReturnType<
  typeof sharedQuery<TArgs, TData>
>;

// Using any so that we don't need to typecast later.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFAULT_QUERY_STATE_ENTRY: Readonly<QueryStateValue<any>> = {
  lastUpdatedMs: 0,
  loading: true,
};

/**
 * React hook to make use of a shared query inside any React component. The
 * args do not need to be specified if no args are needed, i.e. this would work
 * ```
 *   const allUsers = useSharedQuery(listUsersQuery);
 * ```
 *
 * Example:
 * ```
 *   const users = useSharedQuery(usersQuery, "userid123");
 * ```
 */
export function useSharedQuery<TArgs extends unknown[], TData>(
  query: SharedQuery<TArgs, TData>,
  // Optional: Default to use no arguments.
  ...args: TArgs
): UseQueryResult<TData> {
  // We don't expect users to provide a stable `args`, so stabilize it here.
  const stableArgs = useDeepMemo(args);

  const [queryState, setQueryState] = useSharedState(query.queryState);

  const isMounted = useRef(true);

  const queryKey = useMemo(
    () => query.getQueryKey(stableArgs),
    [query, stableArgs],
  );

  // Init with empty object.
  const queryStateValue: QueryStateValue<TData> =
    queryState[queryKey] ?? DEFAULT_QUERY_STATE_ENTRY;

  const setQueryStateValue = useCallback(
    (next: SetStateAction<QueryStateValue<TData>>) => {
      setQueryState((prev) => {
        const clone = { ...prev };
        clone[queryKey] =
          typeof next === "function"
            ? next(clone[queryKey] ?? DEFAULT_QUERY_STATE_ENTRY)
            : next;
        return clone;
      });
    },
    [queryKey, setQueryState],
  );

  // Keep the last non-empty data loaded in case you want to show a placeholder
  // during new loads.
  const [lastNonEmptyData, setLastNonEmptyData] = useState<TData | undefined>();

  useEffect(() => {
    if (query.keepLastNonEmptyData && queryStateValue.data !== undefined) {
      setLastNonEmptyData(queryStateValue.data);
    }
  }, [query.keepLastNonEmptyData, queryStateValue.data]);

  // The fetch logic wrapped in useCallback to be stable for useEffect
  const execute = useCallback(
    async (isRefetch: boolean) => {
      query.log(
        `Begin executing shared query ${queryKey}, isRefetch=${isRefetch}`,
      );

      if (!isMounted.current) return;

      setQueryStateValue((prev) => ({
        // Keep old data and error.
        ...prev,
        lastUpdatedMs: Date.now(),
        loading: true,
      }));

      try {
        let state: QueryStateValue<TData>;

        if (isRefetch) {
          const data = await query.refetch(...stableArgs);
          const now = Date.now();

          state = {
            // Don't keep old error.
            lastUpdatedMs: now,
            loading: false,
            data,
            dataUpdatedMs: now,
          };
        } else {
          state = await query.getCachedOrFetch(...stableArgs);
        }

        if (!isMounted.current) return;

        // Make sure to reset loading to false.
        setQueryStateValue({ ...state, loading: false });
      } catch (e) {
        if (!isMounted.current) return;

        const now = Date.now();

        setQueryStateValue((prev) => ({
          // Keep old data.
          ...prev,
          lastUpdatedMs: now,
          loading: false,
          error: e,
          errorUpdatedMs: now,
        }));
      }
    },
    [query, queryKey, setQueryStateValue, stableArgs],
  );

  useEffect(() => {
    isMounted.current = true;
    query.mount(queryKey);

    void execute(false);

    return () => {
      isMounted.current = false;
      query.unmount(queryKey);
    };
  }, [execute, query, queryKey]);

  return useMemo(() => {
    return {
      ...queryStateValue,

      // Fill with lastNonEmptyData when data is undefined.
      data:
        queryStateValue.data !== undefined
          ? queryStateValue.data
          : lastNonEmptyData,
      latestData: queryStateValue.data,

      // This works only if the user-given queryFn supports abort. If not,
      // this function doesn't do anything, since we don't have any means to
      // abort the running queryFn.
      abortCurrentQuery: (reason?: unknown): boolean => {
        const controller = query.getAbortControllerByKey(queryKey);
        controller?.abort(reason);
        return Boolean(controller);
      },
      refetch: (): Promise<void> => {
        return execute(true);
      },
      setData: (data: TData, dataUpdatedMs?: number): void => {
        query.setData(queryKey, data, dataUpdatedMs);
      },
      deleteData: (): void => {
        query.deleteData(queryKey);
      },
    } satisfies UseQueryResult<TData>;
  }, [execute, lastNonEmptyData, query, queryKey, queryStateValue]);
}
