import { DEFAULT_EXPIRY_DELTA_MS } from "@choksheak/ts-utils/kvStore";
import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import { useSyncExternalStore } from "react";

import { getStorageAdapter, StorageOptions } from "./utils/storage";

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
   * Default duration for storage expiration in milliseconds. Initial value
   * is 30 days, but can be changed to anything.
   */
  public static storeExpiryMs = MS_PER_DAY * 30;

  /**
   * True to load from storage only on mount, false (default) to load in
   * the top level scope when the shared state is defined.
   */
  public static lazyLoad = false;
}

/************************************************************************/
/* Shared state implementation                                          */
/************************************************************************/

type Subscriber<T> = (next: T, prev: T) => void;

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

const pubSubStore = new PubSubStore();

const STORAGE_KEY = "state";

export type SharedStateOptions<T> = {
  lazyLoad?: boolean;
} & StorageOptions<T>;

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
  options?: SharedStateOptions<T>,
): SharedState<T> {
  const key = String(stateKey++);

  // Use up to 1 storage adapter per shared state.
  const storageAdapter = getStorageAdapter(options, DEFAULT_EXPIRY_DELTA_MS);

  // `subscribe` function required by useSyncExternalStore
  function subscribe(subscriber: () => void): () => void {
    return pubSubStore.subscribe(key, () => subscriber());
  }

  // `getSnapshot` function — must return same ref if value unchanged
  function getSnapshot(): T {
    return pubSubStore.get(key);
  }

  function setValue(next: T | ((prev: T) => T)): void {
    if (typeof next === "function") {
      const prev = pubSubStore.get<T>(key);
      next = (next as (p: T) => T)(prev);
    }

    pubSubStore.set(key, next);
    void storageAdapter?.save(STORAGE_KEY, next);
  }

  // Always set the default value first to avoid returning undefineds if that
  // is not part of T.
  pubSubStore.setNoNotify(key, defaultValue);

  const state = {
    subscribe,
    getSnapshot,

    // initial default handling
    initDefaultValueOnce: async () => {
      if (state.initDone) return;
      state.initDone = true;

      const v = await storageAdapter?.load(STORAGE_KEY);
      pubSubStore.set(key, v !== undefined ? v : defaultValue);
    },
    initDone: false,

    setValue,
  };

  const lazyLoad = options?.lazyLoad;
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

  const value = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    // getServerSnapshot is needed to prevent SSR dev errors in nextjs.
    state.getSnapshot,
  );

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
