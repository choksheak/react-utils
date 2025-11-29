/**
 * @packageDocumentation
 *
 * The "shared state" is a React state that shares the same value across the
 * entire app. Users declare a shared state constant that can be reused across
 * multiple components with the same underlying value.
 *
 * Shared states provide persistence to local storage and/or indexed DB out of
 * the box, by using "@choksheak/ts-utils". Note that no matter if the shared
 * state uses persistence or not, it will always maintain a copy of the state
 * in memory. Persisted values can be configured with an automatic expiration
 * duration.
 *
 * This module is largely similar to the open source "jotai" npm library. You
 * can use shared states to replace "jotai" in your code, and optionally make
 * use of the persistence mechanism. A quick migration guide from jotai is:
 *
 * ```
 *   atom()          -->  sharedState()
 *   useAtom()       -->  useSharedState()
 *   useAtomValue()  -->  useSharedStateValue()
 *   useSetAtom()    -->  useSharedStateSetter()
 * ```
 *
 * Example:
 * ```
 *   import { sharedState, useSharedState } from "@choksheak/react-utils/sharedState";
 *
 *   // Create a new shared state in the top level scope.
 *   // The first argument is the default value, which is required.
 *   // The second argument is an options object, and is optional (defaults
 *   // to storing in memory only without any persistence).
 *   const usersState = sharedState(
 *     [], { store: { persistTo: "indexedDb", key: "users" }}
 *   );
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
 */

import { StorageAdapter } from "@choksheak/ts-utils/storageAdapter";
import { MS_PER_DAY } from "@choksheak/ts-utils/timeConstants";
import { Dispatch, SetStateAction, useSyncExternalStore } from "react";

import { getStorageAdapter, StorageOptions } from "./storage";

/************************************************************************/
/* Global config                                                        */
/************************************************************************/

/**
 * These values are configurable by the user at any time.
 */
export const SharedStateConfig = {
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

export type SharedStateConfig = typeof SharedStateConfig;

/** Convenience function to update global defaults. */
export function configureSharedState(config: Partial<SharedStateConfig>) {
  Object.assign(SharedStateConfig, config);
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

/** Options to configure a shared state. */
export type SharedStateOptions<T> = {
  lazyLoad?: boolean;
} & StorageOptions<T>;

let stateKey = 0;

/** Please use sharedState() instead. */
export class SharedState<T> {
  private readonly pubSubKey: string;
  private readonly storageAdapter: StorageAdapter<T> | null;
  public readonly setValueBounded: Dispatch<SetStateAction<T>>;
  public initStarted = false;
  public initDone = false;

  // Allow users to await for the completion of data init.
  public readonly readyPromise: Promise<void>;
  private readonly resolveReadyPromise: () => void;

  public constructor(
    private readonly defaultValue: T,
    options?: SharedStateOptions<T>,
  ) {
    let readyResolve: () => void = () => {};

    this.readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    this.resolveReadyPromise = readyResolve;

    this.pubSubKey = String(stateKey++);

    // Use max of 1 storage adapter per shared state.
    this.storageAdapter = getStorageAdapter(
      options,
      SharedStateConfig.storeExpiryMs,
    );

    // Same as this.setValue, but binding the `this` reference.
    this.setValueBounded = (next: SetStateAction<T>) => {
      this.setValue(next);
    };

    // Always set the default value first to avoid returning undefineds if that
    // is not part of T.
    pubSubStore.setNoNotify(this.pubSubKey, defaultValue);

    const lazyLoad = options?.lazyLoad;
    const lazy = lazyLoad !== undefined ? lazyLoad : SharedStateConfig.lazyLoad;

    if (!lazy) {
      void this.initDefaultValueOnce();
    }
  }

  /** `subscribe` function required by useSyncExternalStore. */
  public subscribe(subscriber: () => void): () => void {
    return pubSubStore.subscribe(this.pubSubKey, () => subscriber());
  }

  /** Returns true if there is a backing store. */
  public hasStore(): boolean {
    return Boolean(this.storageAdapter);
  }

  /**
   * Set a value directly into the store. Does nothing if there is no
   * backing store.
   *
   * Warning: If you want to set the value properly, you should use
   * `setValue()` instead which also updates the in-memory copy.
   */
  public async setInStore(value: T): Promise<void> {
    return await this.storageAdapter?.set(STORAGE_KEY, value);
  }

  /**
   * Get a value directly from the store. Returns undefined if there is no
   * backing store.
   */
  public async getFromStore(): Promise<T | undefined> {
    return await this.storageAdapter?.get(STORAGE_KEY);
  }

  /**
   * Get the value of the shared state.
   *  `getSnapshot` function — must return same ref if value unchanged.
   * Note that this would return the default value if data init from store is
   * not completed yet.
   */
  public getSnapshot(): T {
    return pubSubStore.get(this.pubSubKey);
  }

  /** Set the value of the shared state. */
  public setValue(next: SetStateAction<T>): void {
    if (typeof next === "function") {
      const prev = pubSubStore.get<T>(this.pubSubKey);
      next = (next as (p: T) => T)(prev);
    }

    pubSubStore.set(this.pubSubKey, next);
    void this.setInStore(next);
  }

  /**
   * Remove the value of the shared state. Actually this just sets the value
   * back to the given default value.
   */
  public delete() {
    pubSubStore.set(this.pubSubKey, this.defaultValue);
    void this.storageAdapter?.set(STORAGE_KEY, this.defaultValue);
  }

  /** Initial default handling. */
  public async initDefaultValueOnce() {
    if (this.initDone || this.initStarted) return;
    this.initStarted = true;

    const stored = await this.getFromStore();
    const value = stored !== undefined ? stored : this.defaultValue;

    pubSubStore.set(this.pubSubKey, value);

    this.initDone = true;
    this.resolveReadyPromise();
  }
}

/**
 * Create a new shared state object. Put this code at the top level scope:
 *
 * Example:
 * ```
 *   const counterState = sharedState<number>(0);
 * ```
 */
export function sharedState<T>(
  defaultValue: T,
  options?: SharedStateOptions<T>,
): SharedState<T> {
  return new SharedState(defaultValue, options);
}

/**
 * React hook for subscribing to a key in the global store.
 *
 * Example:
 * ```
 *   const [counter, setCounter] = useSharedState(counterState);
 * ```
 */
export function useSharedState<T>(
  state: SharedState<T>,
): [T, Dispatch<SetStateAction<T>>] {
  state.initDefaultValueOnce();

  const value = useSyncExternalStore(
    (onStoreChange) => state.subscribe(onStoreChange),
    () => state.getSnapshot(),
    // getServerSnapshot is needed to prevent SSR dev errors in nextjs.
    () => state.getSnapshot(),
  );

  return [value, state.setValueBounded];
}

/**
 * Same as useSharedState(), but returns the value only.
 *
 * Example:
 * ```
 *   const counter = useSharedStateValue(counterState);
 * ```
 */
export function useSharedStateValue<T>(state: SharedState<T>) {
  return useSharedState(state)[0];
}

/**
 * Same as useSharedState(), but returns the setter only.
 *
 * Example:
 * ```
 *   const setCounter = useSharedStateSetter(counterState);
 * ```
 */
export function useSharedStateSetter<T>(state: SharedState<T>) {
  return useSharedState(state)[1];
}
