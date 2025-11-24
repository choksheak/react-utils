import { kvStore } from "@choksheak/ts-utils/kvStore";
import { LocalStore } from "@choksheak/ts-utils/localStore";
import { StorageAdapter } from "@choksheak/ts-utils/storageAdapter";

/** List of all available pre-built persistence options. */
export type PersistTo = "localStorage" | "indexedDb";

export type StoreOptions = {
  persistTo: PersistTo;

  // Storage key to act as a namespace to store the data.
  key: string;

  // How long to wait before the value is considered expired.
  expiryMs?: number;
};

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

            return adapter.get(key);
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

            return await kvStore.get(keyPrefix + key);
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
