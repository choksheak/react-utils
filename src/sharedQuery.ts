import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import getByteSize from "object-sizeof";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  SharedState,
  sharedState,
  SharedStateOptions,
  useSharedState,
} from "./sharedState";
import { stringifyDeterministicForKeys } from "./utils/stringify";

export type QueryFn<TArgs extends unknown[], TData> = (
  ...args: TArgs
) => Promise<TData> | TData;

export type QueryStateValue<TData> = {
  /**
   * When this record was last updated. Used for LRU determination. If you want
   * the data age, please use `dataUpdatedMs` instead.
   */
  lastUpdatedMs: number;

  loading: boolean;
  data?: TData;
  dataUpdatedMs?: number;
  error?: Error;
  errorUpdatedMs?: number;
};

export type UseQueryResult<TData> = QueryStateValue<TData> & {
  /**
   * Cancels the inflight query (if any). Returns true if canceled.
   */
  abortCurrentQuery: (reason?: unknown) => boolean;

  /**
   * Manually refresh the data by doing a new query.
   */
  refetch: () => Promise<TData>;

  /**
   * If you got the data from somewhere else (e.g. an in-memory data update),
   * just set it directly.
   */
  setData: (data: TData, dataUpdatedMs?: number) => void;

  deleteData: () => void;
};

export type PersistTo = "localStorage" | "indexedDb";

/**
 * The full query state is a record of all the fetch states mapped by
 * query key to the state entry.
 */
export type SharedQueryState<TData> = Record<string, QueryStateValue<TData>>;

export type SharedQueryOptions<TArgs extends unknown[], TData> = {
  // The name could have been auto-generated, but we let the user give us a
  // human-readable name that can be identified quickly in the logs.
  queryName: string;

  // Function to fetch data.
  queryFn: QueryFn<TArgs, TData>;

  // ms before data considered stale; 0 means always stale.
  staleMs?: number;

  // ms before data is removed from cache; 0 means never expire.
  expiryMs?: number;

  // Trigger background re-fetch if stale.
  refetchOnStale?: boolean;

  // Shortcut to set the localStorageKey or indexedDbKey automatically from
  // queryName. This is important because it avoids requiring the user to
  // specify the same queryName twice everytime.
  persistTo?: PersistTo;

  // Max number of entries to keep. The oldest entries will be discarded.
  // The last record cannot be discarded. 0 means no limit.
  maxSize?: number;

  // Max number of bytes to keep. The oldest entries will be discarded.
  // The last record cannot be discarded. 0 means no limit.
  maxBytes?: number;

  // Customize the logger.
  log?: (...args: unknown[]) => void;
} & SharedStateOptions<SharedQueryState<TData>>;

/** Users can override these values globally. */
export const SharedQueryDefaults = {
  staleMs: 0,
  expiryMs: 30 * MS_PER_DAY,
  persistTo: undefined as PersistTo | undefined,
  maxSize: 100, // 100 is not too large, but please tweak accordingly
  maxBytes: 100_000, // 100kb before GC
  log: (...args: unknown[]) => console.log("[sharedQuery]", ...args),
};

export class SharedQuery<TArgs extends unknown[], TData> {
  private readonly inflightQueries = new Map<
    string,
    { promise: Promise<TData>; abortController: AbortController }
  >();

  public readonly queryState: SharedState<SharedQueryState<TData>>;

  public readonly queryName: string;
  private readonly queryFn: QueryFn<TArgs, TData>;
  public readonly expiryMs: number;
  public readonly staleMs: number;
  public readonly refetchOnStale: boolean;
  public readonly maxSize: number;
  public readonly maxBytes: number;
  public readonly log: (...args: unknown[]) => void;

  public constructor(options: SharedQueryOptions<TArgs, TData>) {
    this.queryName = options.queryName;

    this.queryFn = options.queryFn;

    this.expiryMs =
      options?.expiryMs !== undefined
        ? options?.expiryMs
        : SharedQueryDefaults.expiryMs;

    this.staleMs =
      options?.staleMs !== undefined
        ? options?.staleMs
        : SharedQueryDefaults.staleMs;

    this.refetchOnStale = Boolean(options?.refetchOnStale);

    // Apply shortcut when using `persistTo`.
    const persistTo = options.persistTo ?? SharedQueryDefaults.persistTo;

    if (persistTo === "localStorage") {
      options.localStorageKey = options.queryName;
    } else if (persistTo === "indexedDb") {
      options.indexedDbKey = options.queryName;
    }

    this.maxSize = options?.maxSize ?? SharedQueryDefaults.maxSize;
    this.maxBytes = options?.maxBytes ?? SharedQueryDefaults.maxBytes;

    this.log = options?.log ?? SharedQueryDefaults.log;

    this.queryState = sharedState<SharedQueryState<TData>>(
      {},
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
  public getAbortControllerByKey(queryKey: string): AbortController | null {
    return this.inflightQueries.get(queryKey)?.abortController ?? null;
  }

  public getAbortController(args: TArgs): AbortController | null {
    const queryKey = this.getQueryKey(args);
    return this.getAbortControllerByKey(queryKey);
  }

  /** Get the AbortSignal to check for query abortions. */
  public getAbortSignalByKey(queryKey: string): AbortSignal | null {
    return this.getAbortControllerByKey(queryKey)?.signal ?? null;
  }

  public getAbortSignal(args: TArgs): AbortSignal | null {
    return this.getAbortController(args)?.signal ?? null;
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

  /** Set the data directly if the user obtained it from somewhere else. */
  public async setData(
    queryKey: string,
    data: TData,
    dataUpdatedMs = Date.now(),
  ): Promise<void> {
    const entry: QueryStateValue<TData> = {
      lastUpdatedMs: Date.now(),
      loading: false,
      data,
      dataUpdatedMs,
    };

    this.queryState.setValue((prev) => ({ ...prev, [queryKey]: entry }));

    this.enforceSizeLimit();
  }

  /** Do a new fetch even when the data is already cached. */
  public async updateFromSource(...args: TArgs): Promise<TData> {
    const key = this.getQueryKey(args);
    return await this.dedupedFetch(key, ...args);
  }

  /** Delete the cached data for one set of arguments. */
  public deleteData(args: TArgs): void {
    const queryKey = this.getQueryKey(args);

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

    let newState = oldState;
    let needUpdate = false;

    // Limit by number of records.
    if (this.maxSize) {
      const numToCut = oldSize - this.maxSize;

      if (numToCut > 0) {
        this.log(
          `enforceSizeLimit for ${this.queryName} needed due to size ${oldSize} > ${this.maxSize}`,
        );

        newState = { ...newState }; // shallow clone
        needUpdate = true;

        Object.entries(newState)
          .sort(
            (entry1, entry2) =>
              // Sort descending.
              entry2[1].lastUpdatedMs - entry1[1].lastUpdatedMs,
          )
          .slice(-numToCut)
          .forEach(([key]) => {
            delete newState[key];
          });
      }
    }

    // Limit by byte size.
    if (this.maxBytes && Object.keys(newState).length > 1) {
      // Recompute only if changed by above code.
      const currentByteSize = needUpdate ? getByteSize(newState) : oldByteSize;

      let bytesToCut = currentByteSize - this.maxBytes;

      if (bytesToCut > 0) {
        this.log(
          `enforceSizeLimit for ${this.queryName} needed due to byte size ${currentByteSize.toLocaleString()} > ${this.maxBytes.toLocaleString()}`,
        );

        // Shallow clone only if not already cloned above.
        if (!needUpdate) {
          newState = { ...newState };
          needUpdate = true;
        }

        const entriesByTimeAscending = Object.entries(newState).sort(
          (entry1, entry2) => entry1[1].lastUpdatedMs - entry2[1].lastUpdatedMs,
        );

        for (
          let i = 0;
          // Leave the last record entriesByTimeAscending[len-1] untouched.
          i < entriesByTimeAscending.length - 1 && bytesToCut > 0;
          i++
        ) {
          const key = entriesByTimeAscending[i][0];
          const thisSize = getByteSize(key) + getByteSize(newState[key]);
          delete newState[key];
          bytesToCut -= thisSize;
        }
      }
    }

    // Update the state.
    if (needUpdate) {
      this.queryState.setValue(newState);

      // Log to inform user that the data was trimmed.
      this.log(
        `Trimmed data for ${this.queryName}: size=(${oldSize} -> ${Object.keys(newState).length}) (limit=${this.maxSize}), byteSize=(${oldByteSize.toLocaleString()} -> ${getByteSize(newState).toLocaleString()}) (limit=${this.maxBytes.toLocaleString()})`,
      );

      return;
    }

    // Log to indicate why trimming was not needed.
    this.log(
      `No need to trim data for ${this.queryName}: size=${oldSize} (limit=${this.maxSize}), byteSize=${oldByteSize.toLocaleString()} (limit=${this.maxBytes.toLocaleString()})`,
    );
  }
}

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

const DEFAULT_QUERY_STATE_ENTRY: QueryStateValue<unknown> = {
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
  const [queryState, setQueryState] = useSharedState(query.queryState);

  const isMounted = useRef(true);

  // Identify args changes using deep equality.
  // We intentionally chose not to memoize this value because args is likely
  // to be an unstable value (changes on every render).
  const queryKey = query.getQueryKey(args);

  // The fetch logic wrapped in useCallback to be stable for useEffect
  const execute = useCallback(async () => {
    query.log(`Begin executing shared query ${queryKey}`);

    setQueryState((prev) => {
      const clone = { ...prev };

      clone[queryKey] = {
        ...(clone[queryKey] ?? {}),
        lastUpdatedMs: Date.now(),
        loading: true,
      };

      return clone;
    });

    try {
      const data = await query.getCachedOrFetch(...args);

      if (isMounted.current) {
        setQueryState((prev) => {
          const clone = { ...prev };
          const now = Date.now();

          clone[queryKey] = {
            // Don't keep old error.
            lastUpdatedMs: now,
            loading: false,
            data,
            dataUpdatedMs: now,
          };

          return clone;
        });
      }
    } catch (e) {
      const error =
        e instanceof Error
          ? e
          : new Error(`An unknown error occurred during fetch: ${e}`);

      if (isMounted.current) {
        setQueryState((prev) => {
          const clone = { ...prev };
          const now = Date.now();

          clone[queryKey] = {
            // Keep old data.
            ...(clone[queryKey] ?? {}),
            lastUpdatedMs: now,
            loading: false,
            error,
            errorUpdatedMs: now,
          };

          return clone;
        });
      }
    }
  }, [queryKey]);

  useEffect(() => {
    isMounted.current = true;

    void execute();

    return () => {
      isMounted.current = false;
    };
  }, [execute]);

  return useMemo(() => {
    const state =
      queryState[queryKey] ??
      (DEFAULT_QUERY_STATE_ENTRY as QueryStateValue<TData>);

    return {
      ...state,
      abortCurrentQuery: (reason?: unknown) => {
        const controller = query.getAbortControllerByKey(queryKey);
        controller?.abort(reason);
        return Boolean(controller);
      },
      refetch: () => {
        return query.updateFromSource(...args);
      },
      setData: (data: TData, dataUpdatedMs?: number) => {
        query.setData(queryKey, data, dataUpdatedMs ?? Date.now());
      },
      deleteData: () => {
        query.deleteData(args);
      },
    };
  }, [query, queryKey, queryState]);
}
