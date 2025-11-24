import { kvStore } from "@choksheak/ts-utils/kvStore";
import { LocalStore } from "@choksheak/ts-utils/localStore";
import { StorageAdapter } from "@choksheak/ts-utils/storageAdapter";

/** List of all available pre-built persistence options. */
export type PersistTo = "localStorage" | "indexedDb";

/** Options to configure a pre-built store adapter. */
export type StoreOptions = {
  /** Choose which pre-built store adapter to use. */
  persistTo: PersistTo;

  /** Storage key to act as a namespace to store the data. */
  key: string;

  /** How long to wait before the value is considered expired. */
  expiryMs?: number;

  /** Returns true if the given value supposed to be of type T is valid. */
  isValid?: (u: unknown) => boolean;
};

/** Either use a pre-built store, or a custom one you provide. */
export type StorageOptions<T> = {
  /**
   * You can either specify the storage adapter directly to use a custom
   * store, or specify the properties to use the pre-built ones.
   */
  store?: StorageAdapter<T> | StoreOptions;
};

export function getStorageAdapter<T>(
  options: StorageOptions<T> | undefined,
  defaultStoreExpiryMs: number,
): StorageAdapter<T> | null {
  const { store } = options ?? {};

  if (!store) {
    return null;
  }

  if (
    "persistTo" in store &&
    typeof store.persistTo === "string" &&
    "key" in store &&
    typeof store.key === "string"
  ) {
    const expiryMs = store.expiryMs || defaultStoreExpiryMs;
    const isValid = store.isValid;

    switch (store.persistTo) {
      case "localStorage": {
        const adapter = new LocalStore(store.key, {
          defaultExpiryMs: expiryMs,
        });

        // Handle SSR.
        return {
          set: (key: string, value: T): void => {
            if (typeof window === "undefined") return; // handle SSR

            // Also apply the custom expiryMs on every item in this store.
            adapter.set(key, value);
          },
          get: (key: string): T | undefined => {
            if (typeof window === "undefined") return undefined; // handle SSR

            const value = adapter.get<T>(key);

            if (isValid && !isValid(value)) {
              console.warn(
                `localStorage adapter: Auto-discard invalid value for ${key}: ${JSON.stringify(value)}`,
              );
              adapter.delete(key);
              return undefined;
            }

            return value;
          },
          delete: (key: string): void => {
            if (typeof window === "undefined") return; // handle SSR

            adapter.delete(key);
          },
          clear: (): void => {
            if (typeof window === "undefined") return; // handle SSR

            adapter.clear();
          },
        };
      }

      case "indexedDb": {
        // Use the key prefix as a unique namespace for this store.
        const keyPrefix = store.key + ":";
        const isValid = store.isValid;

        // Prefix all keys using `keyPrefix` so that we can keep all data in
        // the same store in the same DB. If we keep the data in different
        // DB stores, then GC will not be able to clean up abandoned stores.
        return {
          set: async (key: string, value: T): Promise<void> => {
            if (typeof window === "undefined") return; // handle SSR

            // Also apply the custom expiryMs on every item in this store.
            await kvStore.set(keyPrefix + key, value, expiryMs);
          },
          get: async (key: string): Promise<T | undefined> => {
            if (typeof window === "undefined") return undefined; // handle SSR

            const fullKey = keyPrefix + key;
            const value = await kvStore.get<T>(fullKey);

            if (isValid && !isValid(value)) {
              console.warn(
                `indexedDb adapter: Auto-discard invalid value for ${key}: ${JSON.stringify(value)}`,
              );
              await kvStore.delete(fullKey);
              return undefined;
            }

            return value;
          },
          delete: async (key: string): Promise<void> => {
            if (typeof window === "undefined") return; // handle SSR

            await kvStore.delete(keyPrefix + key);
          },
          clear: async (): Promise<void> => {
            if (typeof window === "undefined") return; // handle SSR

            await kvStore.clear();
          },
        };
      }

      default:
        store.persistTo satisfies never;
        throw new Error(`Unknown store.adapter ${store.persistTo}`);
    }
  }

  return store as StorageAdapter<T>;
}
