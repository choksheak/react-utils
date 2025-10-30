import { DEFAULT_EXPIRY_DELTA_MS } from "@choksheak/ts-utils/kvStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getStorageAdapter,
  InMemoryStorageAdapter,
  StorageAdapter,
  StorageOptions,
} from "./utils/storage";
import { stringifyDeterministicForKeys } from "./utils/stringify";

type FetchFn<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

type CacheEntry<TResult> = {
  value: TResult;
  updatedMs: number;
  expiryMs: number;
  expirationTimeoutId?: ReturnType<typeof setTimeout>;
};

export type SharedQueryOptions<TResult> = {
  staleMs?: number; // ms before data considered stale
  expiryMs?: number; // ms before data is removed from cache
  revalidateOnStale?: boolean; // trigger background re-fetch if stale
} & StorageOptions<TResult>;

const DEFAULT_STALE_MS = 0;

export class SharedQuery<TArgs extends unknown[], TResult> {
  private readonly inflightPromises = new Map<string, Promise<TResult>>();
  private readonly store: StorageAdapter<CacheEntry<TResult>>;

  public constructor(
    public readonly queryName: string,
    private readonly fetchFn: FetchFn<TArgs, TResult>,
    public readonly options?: SharedQueryOptions<CacheEntry<TResult>>,
  ) {
    const expiryMs = this.options?.expiryMs ?? DEFAULT_EXPIRY_DELTA_MS;

    this.store =
      getStorageAdapter(
        {
          ...options,
          // `expiryMs` is used for both the in-memory & persisted expiry.
          storeExpiryMs: expiryMs,
        },
        DEFAULT_EXPIRY_DELTA_MS,
      ) || new InMemoryStorageAdapter(queryName, expiryMs);
  }

  public getQueryKey(args: TArgs): string {
    return this.queryName + ":" + stringifyDeterministicForKeys(args);
  }

  private isStale(entry: CacheEntry<TResult>): boolean {
    const age = Date.now() - entry.updatedMs;
    return age > (this.options?.staleMs ?? DEFAULT_STALE_MS);
  }

  private isExpired(entry: CacheEntry<TResult>): boolean {
    return Date.now() > entry.expiryMs;
  }

  private fetchNoCaching(key: string, ...args: TArgs): Promise<TResult> {
    const inflightPromise = this.inflightPromises.get(key);

    // De-duplicate in-flight requests
    if (inflightPromise) {
      return inflightPromise;
    }

    // Fetch new data
    const promise = this.fetchFn(...args)
      .then((result) => {
        this.setCache(key, result);
        return result;
      })
      .finally(() => {
        this.inflightPromises.delete(key);
      });

    this.inflightPromises.set(key, promise);
    return promise;
  }

  public async getCachedOrFetch(...args: TArgs): Promise<TResult> {
    const key = this.getQueryKey(args);
    const cached = await this.store.load(key);

    if (cached && !this.isExpired(cached)) {
      // Return cached value if not stale.
      if (!this.isStale(cached)) {
        return cached.value;
      }

      // If stale, optionally update the data in the background.
      if (this.options?.revalidateOnStale) {
        void this.fetchNoCaching(key, ...args);
      }

      // Still return stale data immediately.
      return cached.value;
    }

    return await this.fetchNoCaching(key, ...args);
  }

  private async setCache(key: string, value: TResult): Promise<void> {
    const expiryMs = this.options?.expiryMs ?? DEFAULT_EXPIRY_DELTA_MS;

    const entry: CacheEntry<TResult> = {
      value,
      updatedMs: Date.now(),
      expiryMs: Date.now() + expiryMs,

      // Schedule cache invalidation after expiryMs.
      expirationTimeoutId: setTimeout(() => {
        void this.store.delete(key);
      }, expiryMs),
    };

    await this.store.save(key, entry);
  }

  /** Do a new fetch even when the data is already cached. */
  public async updateFromSource(...args: TArgs): Promise<TResult> {
    const key = this.getQueryKey(args);
    return await this.fetchNoCaching(key, ...args);
  }

  /** Delete the currently cached data. */
  public async invalidate(args?: TArgs): Promise<void> {
    if (args) {
      const queryKey = this.getQueryKey(args);
      await this.store.delete(queryKey);
    } else {
      await this.store.clear();
    }
  }

  /** Delete the currently cached data & all inflight promises. */
  public async clearAll(): Promise<void> {
    await this.store.clear();
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
  options?: SharedQueryOptions<CacheEntry<TResult>>,
): SharedQuery<TArgs, TResult> {
  if (seenQueryNames.has(queryName)) {
    throw new Error(`Duplicate shared query "${queryName}"`);
  }
  seenQueryNames.add(queryName);

  return new SharedQuery(queryName, fetchFn, options);
}

export type SharedQueryState<TResult> = {
  data: TResult | null;
  loading: boolean;
  error: Error | null;
};

export function useQuery<TArgs extends unknown[], TResult>(
  query: SharedQuery<TArgs, TResult>,
  args: TArgs,
): SharedQueryState<TResult> {
  const [queryState, setQueryState] = useState<SharedQueryState<TResult>>({
    data: null,
    loading: false,
    error: null,
  });

  const isMounted = useRef(true);

  // Identify args changes using deep equality.
  const queryKey = useMemo(() => query.getQueryKey(args), [args]);

  // The fetch logic wrapped in useCallback to be stable for useEffect
  const execute = useCallback(async () => {
    setQueryState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await query.getCachedOrFetch(...args);

      if (isMounted.current) {
        setQueryState({ data, loading: false, error: null });
      }
    } catch (e) {
      const error =
        e instanceof Error
          ? e
          : new Error("An unknown error occurred during fetch.");

      if (isMounted.current) {
        setQueryState((prev) => ({ ...prev, loading: false, error }));
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

  return queryState;
}
