import { kvStore } from "@choksheak/ts-utils/kvStore";
import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import { useSyncExternalStore } from "react";

/**
 * The "shared state" is a React state that shares the same value across the
 * entire app. It is largely similar to the jotai library, but is much smaller
 * and much easier to work with when used for persisting in local storage or
 * indexed db, with an automatic expiration for persisted values.
 *
 * This library aims to be the shortest, simplest, easiest to use, and most
 * efficient implementation of shared global React states with seamless support
 * for client persistence.
 */

/************************************************************************/
/* Global config                                                        */
/************************************************************************/

/**
 * These values are configurable by the user at any time.
 */
export class SharedStateConfig {
  /**
   * Default duration for persistence expiration in milliseconds.
   */
  public static defaultPersistExpiryMs = MS_PER_DAY;

  /**
   * True to load from persistence only on mount, false (default) to load in
   * the top level scope when the shared state is defined.
   */
  public static lazyLoad = false;
}

/************************************************************************/
/* Shared state implementation                                          */
/************************************************************************/

type Subscriber<T> = (next: T, prev: T) => void;

type PersistenceAdapter<T> = {
  save?: (value: T) => Promise<void> | void;
  load?: () => Promise<T | undefined> | T | undefined;
};

class PubSubStore {
  private dataByKey = new Map<string, unknown>();
  private subscribersByKey = new Map<string, Set<Subscriber<unknown>>>();

  // This could be undefined if T includes undefined, else it should never
  // return undefined because the user has to always specify the default value.
  public get<T>(key: string): T {
    return this.dataByKey.get(key) as T;
  }

  public set<T>(key: string, value: T): void {
    const prev = this.dataByKey.get(key) as T;

    // Do nothing if no change.
    if (prev === value) return;

    this.dataByKey.set(key, value);
    this.notify(key, value, prev);
  }

  public setNoNotify<T>(key: string, value: T): void {
    this.dataByKey.set(key, value);
  }

  // Subscribe to changes of a specific key
  public subscribe<T>(key: string, subscriber: Subscriber<T>): () => void {
    let subscribers = this.subscribersByKey.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribersByKey.set(key, subscribers);
    }

    // Type coercion: we store Subscriber<unknown>
    subscribers.add(subscriber as Subscriber<unknown>);

    // Return unsubscribe function
    return () => {
      subscribers.delete(subscriber as Subscriber<unknown>);
      if (subscribers.size === 0) this.subscribersByKey.delete(key);
    };
  }

  private notify<T>(key: string, next: T, prev: T): void {
    const subscribers = this.subscribersByKey.get(key);
    if (!subscribers) return;

    // Make copy to protect against mutation during iteration.
    const copy = Array.from(subscribers.values());
    for (const subscriber of copy) {
      try {
        subscriber(next, prev);
      } catch (e) {
        console.error(`Error invoking subscriber:`, e);
      }
    }
  }
}

const store = new PubSubStore();

export type SharedState<T> = {
  subscribe: (subscriber: () => void) => () => void;
  getSnapshot: () => T;
  initDefaultValueOnce: () => Promise<void> | void;
  initDone: boolean;
  setValue: (next: T | ((prev: T) => T)) => void;
};

let stateKey = 0;

/**
 * Create a new shared state object. Put this code at the top level scope:
 *
 *   const myState = sharedState<number>(0);
 */
export function sharedState<T>(
  defaultValue: T,
  options?: {
    localStorageKey?: string;
    indexedDbKey?: string;
    persistExpiryMs?: number;
    lazyLoad?: boolean;
  },
): SharedState<T> {
  const { localStorageKey, indexedDbKey, persistExpiryMs, lazyLoad } =
    options ?? {};

  const key = String(stateKey++);

  // Use up to 1 persistence adapter per shared state.
  let persistenceAdapter: PersistenceAdapter<T> | undefined;
  const expiryMs = persistExpiryMs ?? SharedStateConfig.defaultPersistExpiryMs;

  if (localStorageKey) {
    persistenceAdapter = new LocalStorageAdapter<T>(localStorageKey, expiryMs);
  } else if (indexedDbKey) {
    persistenceAdapter = new IndexedDbAdapter<T>(indexedDbKey, expiryMs);
  }

  // `subscribe` function required by useSyncExternalStore
  function subscribe(subscriber: () => void): () => void {
    return store.subscribe(key, () => subscriber());
  }

  // `getSnapshot` function — must return same ref if value unchanged
  function getSnapshot(): T {
    return store.get(key);
  }

  function setValue(next: T | ((prev: T) => T)): void {
    if (typeof next === "function") {
      const prev = store.get<T>(key);
      next = (next as (p: T) => T)(prev);
    }

    store.set(key, next);
    void persistenceAdapter?.save?.(next);
  }

  // Always set the default value first to avoid returning undefineds if that
  // is not part of T.
  store.setNoNotify(key, defaultValue);

  const state = {
    subscribe,
    getSnapshot,

    // initial default handling
    initDefaultValueOnce: async () => {
      if (state.initDone) return;
      state.initDone = true;

      const v = await persistenceAdapter?.load?.();
      store.set(key, v !== undefined ? v : defaultValue);
    },
    initDone: false,

    setValue,
  };

  const lazy = lazyLoad !== undefined ? lazyLoad : SharedStateConfig.lazyLoad;

  if (!lazy) {
    void state.initDefaultValueOnce();
  }

  return state;
}

/**
 * React hook for subscribing to a key in the global store.
 *   const [my, setMy] = useSharedState(myState);
 */
export function useSharedState<T>(
  state: SharedState<T>,
): [T, (next: T | ((prev: T) => T)) => void] {
  state.initDefaultValueOnce();

  const value = useSyncExternalStore(state.subscribe, state.getSnapshot);

  return [value, state.setValue];
}

/** E.g. const my = useSharedStateValue(myState) */
export function useSharedStateValue<T>(state: SharedState<T>) {
  return useSharedState(state)[0];
}

/** E.g. const setMy = useSharedStateSetter(myState) */
export function useSharedStateSetter<T>(state: SharedState<T>) {
  return useSharedState(state)[1];
}

/************************************************************************/
/* Persistence adapters                                                 */
/************************************************************************/

/** Save state to local storage. */
type LSBox<T> = { value: T; expiresAt: number };

class LocalStorageAdapter<T> implements PersistenceAdapter<T> {
  public constructor(
    public readonly key: string,
    public readonly expiryMs: number,
  ) {}

  public save(value: T): void {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(
      this.key,
      JSON.stringify({
        value,
        expiresAt: Date.now() + this.expiryMs,
      } satisfies LSBox<T>),
    );
  }

  public load(): T | undefined {
    if (typeof window === "undefined") return undefined;

    const raw = window.localStorage.getItem(this.key);
    if (!raw) return undefined;

    const box = JSON.parse(raw) as LSBox<T>;
    if (!box || !box?.expiresAt || Date.now() >= box.expiresAt) {
      window.localStorage.removeItem(this.key);
      return undefined;
    }

    return box.value;
  }
}

/** Save state to indexed db. */
class IndexedDbAdapter<T> implements PersistenceAdapter<T> {
  public constructor(
    public readonly key: string,
    public readonly expiryMs: number,
  ) {}

  public async save(value: T): Promise<void> {
    if (typeof window === "undefined") return;

    await kvStore.set(this.key, JSON.stringify(value), this.expiryMs);
  }

  public async load(): Promise<T | undefined> {
    if (typeof window === "undefined") return undefined;

    const raw = await kvStore.get<string>(this.key);
    if (raw === undefined) return undefined;

    return JSON.parse(raw);
  }
}
