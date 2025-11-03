/**
 * The "shared state" is a React state that shares the same value across the
 * entire app. It is largely similar to the jotai library, but is much smaller
 * and much easier to work with when used for persisting in local storage or
 * indexed db, with an automatic expiration for persisted values.
 *
 * This library aims to be the shortest, simplest, easiest to use, and most
 * efficient implementation of shared global React states with seamless support
 * for client persistence.
 *
 * Example:
 * ```
 *   // Create a new shared state in the top level scope.
 *   // The first argument is the default value, which is required.
 *   // The second argument is an options object, and is optional (defaults
 *   // to storing in memory only without any persistence).
 *   const usersState = sharedState([], { indexedDbKey: "users" });
 *
 *   export const UsersComponent: React.FC = () => {
 *     // Get both the value and the setter.
 *     const [users, setUsers] = useSharedState(usersState);
 *     ...
 *   };
 *
 *   export const ReadOnlyComponent: React.FC = () => {
 *     // Get the value only.
 *     const users = useSharedStateValue(usersState);
 *     ...
 *   };
 *
 *   export const WriteOnlyComponent: React.FC = () => {
 *     // Get the setter only.
 *     const setUsers = useSharedStateSetter(usersState);
 *     ...
 *   };
 * ```
 *
 * @packageDocumentation
 */

import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import { useSyncExternalStore } from "react";

import {
  getStorageAdapter,
  StorageAdapter,
  StorageOptions,
} from "./utils/storage";

/************************************************************************/
/* Global config                                                        */
/************************************************************************/

/**
 * These values are configurable by the user at any time.
 */
export const SharedStateDefaults = {
  /**
   * Default duration for storage expiration in milliseconds. Initial value
   * is 30 days, but can be changed to anything.
   */
  storeExpiryMs: 30 * MS_PER_DAY,

  /**
   * True to load from storage only on mount, false (default) to load in
   * the top level scope when the shared state is defined.
   */
  lazyLoad: false,
};

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

  public delete(key: string): void {
    this.dataByKey.delete(key);
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

let stateKey = 0;

export class SharedState<T> {
  private readonly pubSubKey: string;
  private readonly storageAdapter: StorageAdapter<T> | null;
  public readonly setValueBounded: (next: T | ((prev: T) => T)) => void;
  public initDone = false;

  public constructor(
    private readonly defaultValue: T,
    options?: SharedStateOptions<T>,
  ) {
    this.pubSubKey = String(stateKey++);

    // Use max of 1 storage adapter per shared state.
    this.storageAdapter = getStorageAdapter(
      options,
      SharedStateDefaults.storeExpiryMs,
    );

    // Same as this.setValue, but binding the `this` reference.
    this.setValueBounded = (arg) => this.setValue(arg);

    // Always set the default value first to avoid returning undefineds if that
    // is not part of T.
    pubSubStore.setNoNotify(this.pubSubKey, defaultValue);

    const lazyLoad = options?.lazyLoad;
    const lazy =
      lazyLoad !== undefined ? lazyLoad : SharedStateDefaults.lazyLoad;

    if (!lazy) {
      void this.initDefaultValueOnce();
    }
  }

  // `subscribe` function required by useSyncExternalStore
  public subscribe(subscriber: () => void): () => void {
    return pubSubStore.subscribe(this.pubSubKey, () => subscriber());
  }

  // Get the value of the shared state.
  // `getSnapshot` function — must return same ref if value unchanged
  public getSnapshot(): T {
    return pubSubStore.get(this.pubSubKey);
  }

  // Set the value of the shared state.
  public setValue(next: T | ((prev: T) => T)): void {
    if (typeof next === "function") {
      const prev = pubSubStore.get<T>(this.pubSubKey);
      next = (next as (p: T) => T)(prev);
    }

    pubSubStore.set(this.pubSubKey, next);
    void this.storageAdapter?.save(STORAGE_KEY, next);
  }

  // Remove the value of the shared state. Actually this just sets the value
  // back to the given default value.
  public delete() {
    pubSubStore.set(this.pubSubKey, this.defaultValue);
    void this.storageAdapter?.save(STORAGE_KEY, this.defaultValue);
  }

  // Initial default handling
  public async initDefaultValueOnce() {
    if (this.initDone) return;
    this.initDone = true;

    const v = await this.storageAdapter?.load(STORAGE_KEY);
    pubSubStore.set(this.pubSubKey, v !== undefined ? v : this.defaultValue);
  }
}

/**
 * Create a new shared state object. Put this code at the top level scope:
 *
 *   const myState = sharedState<number>(0);
 */
export function sharedState<T>(
  defaultValue: T,
  options?: SharedStateOptions<T>,
): SharedState<T> {
  return new SharedState(defaultValue, options);
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
    (onStoreChange) => state.subscribe(onStoreChange),
    () => state.getSnapshot(),
    // getServerSnapshot is needed to prevent SSR dev errors in nextjs.
    () => state.getSnapshot(),
  );

  return [value, state.setValueBounded];
}

/** E.g. const my = useSharedStateValue(myState) */
export function useSharedStateValue<T>(state: SharedState<T>) {
  return useSharedState(state)[0];
}

/** E.g. const setMy = useSharedStateSetter(myState) */
export function useSharedStateSetter<T>(state: SharedState<T>) {
  return useSharedState(state)[1];
}
