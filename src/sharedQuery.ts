import { DEFAULT_EXPIRY_DELTA_MS } from "@choksheak/ts-utils/kvStore";
import { useCallback, useEffect, useRef } from "react";

import { SharedState, sharedState, useSharedState } from "./sharedState";
import { StorageOptions } from "./utils/storage";
import { stringifyDeterministicForKeys } from "./utils/stringify";

export type FetchFn<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

export type FetchedData<TResult> = {
  value: TResult;
  updatedMs: number;
  expiryMs: number;
};

export type QueryStateValue<TResult> = {
  data: FetchedData<TResult> | null;
  loading: boolean;
  error: Error | null;
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

  private isStale(entry: FetchedData<TResult>): boolean {
    if (this.staleMs === 0) return false; // never stale
    const age = Date.now() - entry.updatedMs;
    return age > this.staleMs;
  }

  private isExpired(entry: FetchedData<TResult>): boolean {
    if (entry.expiryMs === 0) return false; // never expire
    return Date.now() > entry.expiryMs;
  }

  private fetchNoCaching(key: string, ...args: TArgs): Promise<TResult> {
    const inflightPromise = this.inflightPromises.get(key);

    // De-duplicate in-flight requests
    if (inflightPromise) {
      console.log(`Deduplicating inflight fetch for ${key}`);
      return inflightPromise;
    }

    // Fetch new data
    console.log(`Start fetching ${key}`);

    const promise = this.fetchFn(...args)
      .then((result) => {
        console.log(`Successfully fetched ${key}`);
        this.setCache(key, result);
        return result;
      })
      .catch((e) => {
        console.error(`Failed to fetch ${key}: ${e}`);
        throw e;
      })
      .finally(() => {
        this.inflightPromises.delete(key);
      });

    this.inflightPromises.set(key, promise);
    return promise;
  }

  public async getCachedOrFetch(...args: TArgs): Promise<TResult> {
    const key = this.getQueryKey(args);
    const cached = this.queryState.getSnapshot()?.[key];

    if (cached?.data && !this.isExpired(cached.data)) {
      // Return cached value if not stale.
      if (!this.isStale(cached.data)) {
        console.log(`Return fresh data ${key} from cache without fetching`);
        return cached.data.value;
      }

      // If stale, optionally update the data in the background.
      if (this.revalidateOnStale) {
        console.log(`revalidateOnStale for ${key}`);
        void this.fetchNoCaching(key, ...args);
      }

      // Still return stale data immediately.
      console.log(`Returning stale data for ${key}`);
      return cached.data.value;
    }

    return await this.fetchNoCaching(key, ...args);
  }

  private async setCache(key: string, value: TResult): Promise<void> {
    const data: FetchedData<TResult> = {
      value,
      updatedMs: Date.now(),
      expiryMs: this.expiryMs ? Date.now() + this.expiryMs : 0,
    };

    const entry = { data, loading: false, error: null };

    this.queryState.setValue((prev) => ({ ...prev, [key]: entry }));
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

const DEFAULT_QUERY_STATE_ENTRY: QueryStateValue<unknown> = {
  data: null,
  loading: false,
  error: null,
};

export function useQuery<TArgs extends unknown[], TResult>(
  query: SharedQuery<TArgs, TResult>,
  args: TArgs,
): QueryStateValue<TResult> {
  const [queryState, setQueryState] = useSharedState(query.queryState);

  const isMounted = useRef(true);

  // Identify args changes using deep equality.
  // We intentionally chose not to memoize this value because args is likely
  // to be an unstable value (changes on every render).
  const queryKey = query.getQueryKey(args);

  // The fetch logic wrapped in useCallback to be stable for useEffect
  const execute = useCallback(async () => {
    setQueryState((prev) => {
      const clone = { ...prev };
      clone[queryKey] = {
        ...(clone[queryKey] ?? { data: null }),
        loading: true,
        error: null,
      };
      return clone;
    });

    try {
      const value = await query.getCachedOrFetch(...args);

      if (isMounted.current) {
        setQueryState((prev) => {
          const clone = { ...prev };
          clone[queryKey] = {
            data: {
              value,
              updatedMs: Date.now(),
              expiryMs: query.expiryMs,
            },
            loading: false,
            error: null,
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
            ...(clone[queryKey] ?? { data: null }),
            loading: false,
            error,
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

  return (
    queryState[queryKey] ??
    (DEFAULT_QUERY_STATE_ENTRY as QueryStateValue<TResult>)
  );
}
