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
 * Example:
 * ```
 *   import { sharedQuery, useSharedQuery } from "@choksheak/react-utils/sharedQuery";
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
 *   // Note that the query will only start fetching on mount in React.
 *   // But you can do `usersQuery.getCachedOrFetch()` here to prefetch the
 *   // data if necessary.
 *   usersQuery.getCachedOrFetch();
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
 *      const user = useSharedQuery(getUserQuery, [userId]);
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

import {
  SharedState,
  sharedState,
  SharedStateOptions,
  useSharedState,
} from "./sharedState";
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
     * Return the last non-empty data if you want to display the last loaded data
     * while waiting for the new data to load.
     */
    lastNonEmptyData: TData | undefined;

    /**
     * Cancels the inflight query (if any). Returns true if canceled.
     */
    abortCurrentQuery: (reason?: unknown) => boolean;

    /**
     * Manually refresh the data by doing a new query.
     */
    refetch: () => void;

    /**
     * If you got the data from somewhere else (e.g. an in-memory data update),
     * just set it directly.
     */
    setData: (data: TData, dataUpdatedMs?: number) => void;

    deleteData: () => void;
  }>;

/** List of all available persistence options. */
export type PersistTo = "localStorage" | "indexedDb";

/**
 * The full query state is a record of all the fetch states mapped by
 * query key to the state entry.
 */
export type SharedQueryState<TData> = Record<string, QueryStateValue<TData>>;

/** Options to configure a shared query. */
export type SharedQueryOptions<TArgs extends unknown[], TData> = {
  /**
   * The name could have been auto-generated, but we let the user give us a
   * human-readable name that can be identified quickly in the logs.
   * Note that the queryKey is a string formed by the queryName plus the query
   * arguments.
   */
  queryName: string;

  /**
   * Function to fetch data.
   */
  queryFn: QueryFn<TArgs, TData>;

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
export const SharedQueryDefaults = {
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

/** Please use sharedQuery() instead. */
export class SharedQuery<TArgs extends unknown[], TData> {
  private readonly inflightQueries = new Map<
    string,
    { promise: Promise<TData>; abortController: AbortController }
  >();

  public readonly queryState: SharedState<SharedQueryState<TData>>;

  /**
   * Keep track of the mounted query keys. This handles the case where an
   * earlier-started query returns later, and when it returns, it was already
   * unmounted, thus making it eligible for clean up right after fetch.
   */
  private readonly mountedKeys = new Map<string, number>();

  public readonly queryName: string;
  private readonly queryFn: QueryFn<TArgs, TData>;
  public readonly expiryMs: number;
  public readonly staleMs: number;
  public readonly refetchOnStale: boolean;
  public readonly maxSize: number;
  public readonly maxBytes: number;
  public readonly keepLastNonEmptyData: boolean;
  public readonly log: (...args: unknown[]) => void;

  public constructor(options: SharedQueryOptions<TArgs, TData>) {
    this.queryName = options.queryName;
    this.queryFn = options.queryFn;

    this.staleMs = options?.staleMs ?? SharedQueryDefaults.staleMs;
    this.expiryMs = options?.expiryMs ?? SharedQueryDefaults.expiryMs;

    this.refetchOnStale =
      options?.refetchOnStale ?? SharedQueryDefaults.refetchOnStale;

    // Apply shortcut when using `persistTo`.
    // Specifying the storage keys will take precedence over `persistTo`.
    if (!options.localStorageKey && !options.indexedDbKey) {
      const persistTo = options.persistTo ?? SharedQueryDefaults.persistTo;

      if (persistTo === "localStorage") {
        options.localStorageKey = options.queryName;
      } else if (persistTo === "indexedDb") {
        options.indexedDbKey = options.queryName;
      }
    }

    this.maxSize = options?.maxSize ?? SharedQueryDefaults.maxSize;
    this.maxBytes = options?.maxBytes ?? SharedQueryDefaults.maxBytes;

    this.keepLastNonEmptyData = Boolean(options?.keepLastNonEmptyData);

    this.log = options?.log ?? SharedQueryDefaults.log;

    this.queryState = sharedState<SharedQueryState<TData>>(
      {}, // defaultValue
      {
        ...options,
        // Fallback to use expiryMs for the storeExpiryMs.
        storeExpiryMs: options?.storeExpiryMs || this.expiryMs,
      },
    );
  }

  /** Returns a key to identify requests based on the given args. */
  public getQueryKey(args: TArgs): string {
    return this.queryName + ":" + stringifyDeterministicForKeys(args);
  }

  /**
   * Get the AbortController to abort the inflight query (if any).
   *
   * Note that once you get the controller, you can also get the signal easily
   * using `controller.signal`. So if you need both the controller and the
   * signal, just use this function.
   */
  public getAbortController(args: TArgs): AbortController | null {
    const queryKey = this.getQueryKey(args);
    return this.getAbortControllerByKey(queryKey);
  }

  public getAbortControllerByKey(queryKey: string): AbortController | null {
    return this.inflightQueries.get(queryKey)?.abortController ?? null;
  }

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
  public getAbortSignal(args: TArgs): AbortSignal | null {
    const queryKey = this.getQueryKey(args);
    return this.getAbortSignalByKey(queryKey);
  }

  public getAbortSignalByKey(queryKey: string): AbortSignal | null {
    return this.getAbortControllerByKey(queryKey)?.signal ?? null;
  }

  private isStale(dataUpdatedMs: number): boolean {
    if (this.staleMs === 0) return true; // always stale

    const ageMs = Date.now() - dataUpdatedMs;
    return ageMs > this.staleMs;
  }

  private isExpired(dataUpdatedMs: number): boolean {
    if (this.expiryMs === 0) return false; // never expire

    const ageMs = Date.now() - dataUpdatedMs;
    return ageMs > this.expiryMs;
  }

  public async getCachedOrFetch(...args: TArgs): Promise<TData> {
    const queryKey = this.getQueryKey(args);
    const cached = this.queryState.getSnapshot()?.[queryKey];

    if (cached?.data && !this.isExpired(cached.dataUpdatedMs ?? 0)) {
      // Return cached value if not stale.
      if (!this.isStale(cached.dataUpdatedMs ?? 0)) {
        this.log(`Return fresh data ${queryKey} from cache without fetching`);
        return cached.data;
      }

      // If stale, optionally update the data in the background.
      if (this.refetchOnStale) {
        this.log(`refetchOnStale for ${queryKey}`);
        void this.dedupedFetch(queryKey, ...args);
      }

      // Still return stale data immediately.
      this.log(`Returning stale data for ${queryKey}`);
      return cached.data;
    }

    return await this.dedupedFetch(queryKey, ...args);
  }

  private dedupedFetch(queryKey: string, ...args: TArgs): Promise<TData> {
    const inflightQuery = this.inflightQueries.get(queryKey);

    // De-duplicate in-flight requests
    if (inflightQuery) {
      this.log(`Deduplicating inflight fetch for ${queryKey}`);
      return inflightQuery.promise;
    }

    // Fetch new data
    const promise = this.startFetching(queryKey, args);
    const abortController = new AbortController();

    this.inflightQueries.set(queryKey, { promise, abortController });

    return promise;
  }

  private async startFetching(queryKey: string, args: TArgs) {
    this.log(`Start fetching ${queryKey}`);

    try {
      const data = await this.queryFn(...args);

      this.log(`Successfully fetched ${queryKey}`);
      this.setData(queryKey, data, Date.now());
      return data;
    } catch (e) {
      this.log(`Failed to fetch ${queryKey}: ${e}`);
      throw e;
    } finally {
      this.inflightQueries.delete(queryKey);
    }
  }

  /** Get the entire stored entry for a query key. */
  public getQueryValue(queryKey: string): QueryStateValue<TData> | undefined {
    return this.queryState.getSnapshot()?.[queryKey];
  }

  /** Get the current stored data for a query key. */
  public getData(queryKey: string): TData | undefined {
    return this.queryState.getSnapshot()?.[queryKey]?.data;
  }

  /** Set the data directly if the user obtained it from somewhere else. */
  public setData(
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

    this.queryState.setValue((prev) => ({ ...prev, [queryKey]: entry }));

    this.enforceSizeLimit();
  }

  /**
   * Do a new fetch even when the data is already cached, but don't fetch if
   * another fetch is already inflight.
   */
  public async updateFromSource(...args: TArgs): Promise<TData> {
    const key = this.getQueryKey(args);
    return await this.dedupedFetch(key, ...args);
  }

  /** Delete the cached data for one set of arguments. */
  public deleteData(queryKey: string): void {
    const record = this.queryState.getSnapshot();
    const clone = { ...record };
    delete clone[queryKey];
    this.queryState.setValue(clone);

    const inflight = this.inflightQueries.get(queryKey);
    if (inflight) {
      this.inflightQueries.delete(queryKey);
      inflight.abortController.abort("Deleted");
    }
  }

  /** Delete all currently cached data & all inflight promises. */
  public clear(): void {
    this.queryState.delete();

    for (const { abortController } of Array.from(
      this.inflightQueries.values(),
    )) {
      abortController.abort("Cleared");
    }

    this.inflightQueries.clear();
  }

  /** Keep track of mounted keys. */
  public mount(queryKey: string): void {
    this.mountedKeys.set(queryKey, (this.mountedKeys.get(queryKey) ?? 0) + 1);
  }

  /** Clean up mounted keys. */
  public unmount(queryKey: string): void {
    const count = this.mountedKeys.get(queryKey);
    if (count === 1) {
      this.mountedKeys.delete(queryKey);
    } else {
      this.mountedKeys.set(queryKey, (count ?? 0) - 1);
    }
  }

  /**
   * Discard the oldest entries if the size exceeds the limit. The last
   * remaining record cannot be deleted no matter what the limit is.
   */
  public enforceSizeLimit(): void {
    // Skip if there are no limits.
    if (!this.maxSize && !this.maxBytes) {
      return;
    }

    const oldState = this.queryState.getSnapshot();
    const oldSize = Object.keys(oldState).length;

    // Cannot do GC if size is 1 or less.
    if (oldSize <= 1) {
      return;
    }

    const oldByteSize = getByteSize(oldState);

    let numToCut = this.maxSize ? oldSize - this.maxSize : 0;
    let bytesToCut = this.maxBytes ? oldByteSize - this.maxBytes : 0;

    // Log to indicate why trimming was not needed.
    if (numToCut <= 0 && bytesToCut <= 0) {
      this.log(
        `No need to trim data for ${this.queryName}: size=${oldSize} (limit=${this.maxSize}), byteSize=${oldByteSize.toLocaleString()} (limit=${this.maxBytes.toLocaleString()})`,
      );
      return;
    }

    // Log to inform user that trimming is needed.
    this.log(
      `Need to trim ${this.queryName}: numToCut=${numToCut}, bytesToCut=${bytesToCut}`,
    );

    const newState = { ...oldState }; // shallow clone
    let needUpdate = false;

    const entriesByTimeAscending = Object.entries(newState).sort(
      (entry1, entry2) => entry1[1].lastUpdatedMs - entry2[1].lastUpdatedMs,
    );

    for (const [key] of entriesByTimeAscending) {
      // Mounted keys cannot be cleaned up as they are visible in the UI.
      if (this.mountedKeys.has(key)) {
        this.log(`Cannot clean up ${key} as it is mounted`);
        continue;
      }

      const byteSize = getByteSize(key) + getByteSize(newState[key]);
      this.log(
        `Cleaning up unmounted ${key} (byteSize=${byteSize.toLocaleString()})`,
      );

      numToCut--;
      bytesToCut -= byteSize;

      delete newState[key];
      needUpdate = true;

      if (numToCut <= 0 && bytesToCut <= 0) {
        break;
      }
    }

    // Log to indicate why trimming was not needed.
    if (!needUpdate) {
      this.log(
        `No trimmable entries found for ${this.queryName}: size=${oldSize} (limit=${this.maxSize}), byteSize=${oldByteSize.toLocaleString()} (limit=${this.maxBytes.toLocaleString()})`,
      );
      return;
    }

    // Update the state.
    this.queryState.setValue(newState);

    // Log to inform user that the data was trimmed.
    this.log(
      `Trimmed data for ${this.queryName}: size=[${oldSize} -> ${Object.keys(newState).length}] (limit=${this.maxSize}), byteSize=[${oldByteSize.toLocaleString()} -> ${getByteSize(newState).toLocaleString()}] (limit=${this.maxBytes.toLocaleString()})`,
    );
  }
}

// Disallow duplicate query names.
const seenQueryNames = new Set<string>();

/**
 * Create a reusable shared query object that can be used to auto de-duplicate
 * and cache all data fetches, with auto-expiration and staleness checks.
 *
 * Each `queryName` must be unique, and can only be declared once, most often
 * in the top level scope. The queryName is used for logging only.
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
): SharedQuery<TArgs, TData> {
  if (seenQueryNames.has(options.queryName)) {
    throw new Error(`Duplicate shared query "${options.queryName}"`);
  }
  seenQueryNames.add(options.queryName);

  return new SharedQuery(options);
}

// Using any so that we don't need to typecast later.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFAULT_QUERY_STATE_ENTRY: Readonly<QueryStateValue<any>> = {
  lastUpdatedMs: 0,
  loading: true,
};

/**
 * React hook to make use of a shared query inside any React component.
 *
 * Example:
 * ```
 *   const users = useSharedQuery(usersQuery, ["123"]);
 * ```
 */
export function useSharedQuery<TArgs extends unknown[], TData>(
  query: SharedQuery<TArgs, TData>,
  // Default to use no arguments.
  args: TArgs = [] as unknown as TArgs,
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
    async (forceRefresh: boolean) => {
      query.log(`Begin executing shared query ${queryKey}`);

      setQueryStateValue((prev) => ({
        // Keep old data and error.
        ...prev,
        lastUpdatedMs: Date.now(),
        loading: true,
      }));

      try {
        const data = await (forceRefresh
          ? query.updateFromSource(...stableArgs)
          : query.getCachedOrFetch(...stableArgs));

        if (isMounted.current) {
          const now = Date.now();

          setQueryStateValue({
            // Don't keep old error.
            lastUpdatedMs: now,
            loading: false,
            data,
            dataUpdatedMs: now,
          });
        }
      } catch (e) {
        if (isMounted.current) {
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
      lastNonEmptyData,
      // This works only if the user-given queryFn supports abort. If not,
      // this function doesn't do anything, since we don't have any means to
      // abort the running queryFn.
      abortCurrentQuery: (reason?: unknown) => {
        const controller = query.getAbortControllerByKey(queryKey);
        controller?.abort(reason);
        return Boolean(controller);
      },
      refetch: () => {
        void execute(true);
      },
      setData: (data: TData, dataUpdatedMs?: number) => {
        const now = Date.now();
        setQueryStateValue((prev) => ({
          ...prev,
          data,
          dataUpdatedMs: dataUpdatedMs ?? now,
          lastUpdatedMs: now,
          loading: false,
        }));
      },
      deleteData: () => {
        setQueryState((prev) => {
          const clone = { ...prev };
          delete clone[queryKey];
          return clone;
        });
      },
    } satisfies UseQueryResult<TData>;
  }, [
    execute,
    lastNonEmptyData,
    query,
    queryKey,
    queryStateValue,
    setQueryState,
    setQueryStateValue,
  ]);
}
