import { KvStore, KvStoreConfig } from "@choksheak/ts-utils/kvStore";
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
      case "localStorage":
        return new LocalStore(store.key, {
          defaultExpiryMs: expiryMs,
        }).asStorageAdapter<T>();
      case "indexedDb":
        return new KvStore(KvStoreConfig.dbName, {
          storeName: store.key,
          defaultExpiryMs: expiryMs,
        }).asStorageAdapter<T>();
      default:
        store.persistTo satisfies never;
        throw new Error(`Unknown store.adapter ${store.persistTo}`);
    }
  }

  return store as StorageAdapter<T>;
}
