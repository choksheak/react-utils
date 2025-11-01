import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  SharedState,
  sharedState,
  SharedStateOptions,
  useSharedState,
} from "./sharedState";
import { stringifyDeterministicForKeys } from "./utils/stringify";

export type FetchFn<TArgs extends unknown[], TData> = (
  ...args: TArgs
) => Promise<TData> | TData;

export type QueryStateValue<TData> = {
  loading: boolean;
  data?: TData;
  dataUpdatedMs?: number;
  error?: Error;
  errorUpdatedMs?: number;
};

export type UseQueryResult<TData> = QueryStateValue<TData> & {
  refetch: () => Promise<TData>;
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
  queryFn: FetchFn<TArgs, TData>;

  // ms before data considered stale; 0 means never stale.
  staleMs?: number;

  // ms before data is removed from cache; 0 means never expire.
  expiryMs?: number;

  // Trigger background re-fetch if stale.
  refetchOnStale?: boolean;

  // Shortcut to set the localStorageKey or indexedDbKey automatically from
  // queryName. This is important because it avoids requiring the user to
  // specify the same queryName twice everytime.
  persistTo?: PersistTo;
} & SharedStateOptions<SharedQueryState<TData>>;

/** Users can override these values globally. */
export const SharedQueryDefaults = {
  staleMs: 0,
  expiryMs: 30 * MS_PER_DAY,
  persistTo: undefined as PersistTo | undefined,
};

export class SharedQuery<TArgs extends unknown[], TData> {
  private readonly inflightPromises = new Map<string, Promise<TData>>();
  public readonly queryState: SharedState<SharedQueryState<TData>>;

  public readonly queryName: string;
  private readonly queryFn: FetchFn<TArgs, TData>;
  public readonly expiryMs: number;
  public readonly staleMs: number;
  public readonly refetchOnStale: boolean;

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

    this.queryState = sharedState<SharedQueryState<TData>>(
      {},
      {
        ...options,
        // Fallback to use expiryMs for the storeExpiryMs.
        storeExpiryMs: options?.storeExpiryMs || this.expiryMs,
      },
    );
  }

  public getQueryKey(args: TArgs): string {
    return this.queryName + ":" + stringifyDeterministicForKeys(args);
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
        console.log(
          `Return fresh data ${queryKey} from cache without fetching`,
        );
        return cached.data;
      }

      // If stale, optionally update the data in the background.
      if (this.refetchOnStale) {
        console.log(`refetchOnStale for ${queryKey}`);
        void this.dedupedFetch(queryKey, ...args);
      }

      // Still return stale data immediately.
      console.log(`Returning stale data for ${queryKey}`);
      return cached.data;
    }

    return await this.dedupedFetch(queryKey, ...args);
  }

  private dedupedFetch(queryKey: string, ...args: TArgs): Promise<TData> {
    const inflightPromise = this.inflightPromises.get(queryKey);

    // De-duplicate in-flight requests
    if (inflightPromise) {
      console.log(`Deduplicating inflight fetch for ${queryKey}`);
      return inflightPromise;
    }

    // Fetch new data
    const promise = this.startFetching(queryKey, args);

    this.inflightPromises.set(queryKey, promise);
    return promise;
  }

  private async startFetching(queryKey: string, args: TArgs) {
    console.log(`Start fetching ${queryKey}`);

    try {
      const data = await this.queryFn(...args);

      console.log(`Successfully fetched ${queryKey}`);
      this.setData(queryKey, data, Date.now());
      return data;
    } catch (e) {
      console.error(`Failed to fetch ${queryKey}: ${e}`);
      throw e;
    } finally {
      this.inflightPromises.delete(queryKey);
    }
  }

  /** Set the data directly if the user obtained it from somewhere else. */
  public async setData(
    queryKey: string,
    data: TData,
    dataUpdatedMs = Date.now(),
  ): Promise<void> {
    const entry: QueryStateValue<TData> = {
      loading: false,
      data,
      dataUpdatedMs,
    };

    this.queryState.setValue((prev) => ({ ...prev, [queryKey]: entry }));
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

    this.inflightPromises.delete(queryKey);
  }

  /** Delete all currently cached data & all inflight promises. */
  public clear(): void {
    this.queryState.delete();
    this.inflightPromises.clear();
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

const DEFAULT_QUERY_STATE_ENTRY: QueryStateValue<unknown> = { loading: true };

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
    console.log(`Begin executing shared query ${queryKey}`);

    setQueryState((prev) => {
      const clone = { ...prev };
      clone[queryKey] = {
        ...(clone[queryKey] ?? {}),
        loading: true,
      };
      return clone;
    });

    try {
      const data = await query.getCachedOrFetch(...args);

      if (isMounted.current) {
        setQueryState((prev) => {
          const clone = { ...prev };
          clone[queryKey] = {
            // Don't keep old error.
            loading: false,
            data,
            dataUpdatedMs: Date.now(),
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
          clone[queryKey] = {
            // Keep old data.
            ...(clone[queryKey] ?? {}),
            loading: false,
            error,
            errorUpdatedMs: Date.now(),
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
