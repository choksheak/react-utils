import { DEFAULT_EXPIRY_DELTA_MS } from "@choksheak/ts-utils/kvStore";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { SharedState, sharedState, useSharedState } from "./sharedState";
import { StorageOptions } from "./utils/storage";
import { stringifyDeterministicForKeys } from "./utils/stringify";

export type FetchFn<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

export type QueryStateValue<TResult> = {
  loading: boolean;
  data?: TResult;
  dataUpdatedMs?: number;
  error?: Error;
  errorUpdatedMs?: number;
};

export type UseQueryResult<TResult> = QueryStateValue<TResult> & {
  refetch: () => Promise<TResult>;
  setData: (data: TResult, dataUpdatedMs?: number) => void;
};

/**
 * The full query state is a record of all the fetch results mapped by
 * query key to the state entry.
 */
export type SharedQueryState<TResult> = Record<
  string,
  QueryStateValue<TResult>
>;

export type SharedQueryOptions<TResult> = {
  // ms before data considered stale; 0 means never stale.
  staleMs?: number;
  // ms before data is removed from cache; 0 means never expire.
  expiryMs?: number;
  // Trigger background re-fetch if stale.
  revalidateOnStale?: boolean;
} & StorageOptions<SharedQueryState<TResult>>;

const DEFAULT_STALE_MS = 0;

export class SharedQuery<TArgs extends unknown[], TResult> {
  private readonly inflightPromises = new Map<string, Promise<TResult>>();
  public readonly queryState: SharedState<SharedQueryState<TResult>>;
  public readonly expiryMs: number;
  public readonly staleMs: number;
  public readonly revalidateOnStale: boolean;

  public constructor(
    public readonly queryName: string,
    private readonly fetchFn: FetchFn<TArgs, TResult>,
    options?: SharedQueryOptions<TResult>,
  ) {
    this.expiryMs =
      options?.expiryMs !== undefined
        ? options?.expiryMs
        : DEFAULT_EXPIRY_DELTA_MS;

    this.staleMs =
      options?.staleMs !== undefined ? options?.staleMs : DEFAULT_STALE_MS;

    this.revalidateOnStale = Boolean(options?.revalidateOnStale);

    this.queryState = sharedState<SharedQueryState<TResult>>(
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

  private fetchNoCaching(queryKey: string, ...args: TArgs): Promise<TResult> {
    const inflightPromise = this.inflightPromises.get(queryKey);

    // De-duplicate in-flight requests
    if (inflightPromise) {
      console.log(`Deduplicating inflight fetch for ${queryKey}`);
      return inflightPromise;
    }

    // Fetch new data
    console.log(`Start fetching ${queryKey}`);

    const promise = this.fetchFn(...args)
      .then((result) => {
        console.log(`Successfully fetched ${queryKey}`);
        this.setData(queryKey, result, Date.now());
        return result;
      })
      .catch((e) => {
        console.error(`Failed to fetch ${queryKey}: ${e}`);
        throw e;
      })
      .finally(() => {
        this.inflightPromises.delete(queryKey);
      });

    this.inflightPromises.set(queryKey, promise);
    return promise;
  }

  public async getCachedOrFetch(...args: TArgs): Promise<TResult> {
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
      if (this.revalidateOnStale) {
        console.log(`revalidateOnStale for ${queryKey}`);
        void this.fetchNoCaching(queryKey, ...args);
      }

      // Still return stale data immediately.
      console.log(`Returning stale data for ${queryKey}`);
      return cached.data;
    }

    return await this.fetchNoCaching(queryKey, ...args);
  }

  public async setData(
    queryKey: string,
    data: TResult,
    dataUpdatedMs = Date.now(),
  ): Promise<void> {
    const entry: QueryStateValue<TResult> = {
      loading: false,
      data,
      dataUpdatedMs,
    };

    this.queryState.setValue((prev) => ({ ...prev, [queryKey]: entry }));
  }

  /** Do a new fetch even when the data is already cached. */
  public async updateFromSource(...args: TArgs): Promise<TResult> {
    const key = this.getQueryKey(args);
    return await this.fetchNoCaching(key, ...args);
  }

  /** Delete the currently cached data. */
  public invalidate(args?: TArgs): void {
    if (args) {
      const queryKey = this.getQueryKey(args);

      const record = this.queryState.getSnapshot();
      const clone = { ...record };
      delete clone[queryKey];
      this.queryState.setValue(clone);

      this.inflightPromises.delete(queryKey);
    } else {
      this.clearAll();
    }
  }

  /** Delete the currently cached data & all inflight promises. */
  public clearAll(): void {
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
 */
export function sharedQuery<TArgs extends unknown[], TResult>(
  // The name could have been auto-generated, but we let the user give us a
  // human-readable name that can be identified quickly in the logs.
  queryName: string,
  fetchFn: FetchFn<TArgs, TResult>,
  options?: SharedQueryOptions<TResult>,
): SharedQuery<TArgs, TResult> {
  if (seenQueryNames.has(queryName)) {
    throw new Error(`Duplicate shared query "${queryName}"`);
  }
  seenQueryNames.add(queryName);

  return new SharedQuery(queryName, fetchFn, options);
}

const DEFAULT_QUERY_STATE_ENTRY: QueryStateValue<unknown> = { loading: true };

/**
 * React hook to make use of a shared query inside any React component.
 *
 *     const users = useSharedQuery(usersQuery, ["123"]);
 */
export function useSharedQuery<TArgs extends unknown[], TResult>(
  query: SharedQuery<TArgs, TResult>,
  // Default to use no arguments.
  args: TArgs = [] as unknown as TArgs,
): UseQueryResult<TResult> {
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
      (DEFAULT_QUERY_STATE_ENTRY as QueryStateValue<TResult>);

    return {
      ...state,
      refetch: () => {
        return query.updateFromSource(...args);
      },
      setData: (data: TResult, dataUpdatedMs?: number) => {
        query.setData(queryKey, data, dataUpdatedMs ?? Date.now());
      },
    };
  }, [query, queryKey, queryState]);
}
