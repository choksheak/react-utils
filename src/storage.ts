import { KvStore, KvStoreConfig } from "@choksheak/ts-utils/kvStore";
import { LocalStore } from "@choksheak/ts-utils/localStore";
import { StorageAdapter } from "@choksheak/ts-utils/storageAdapter";

export type StorageOptions<T> = {
  // If specified, this will be used and all other fields will be ignored.
  store?: StorageAdapter<T>;

  // Storage key in local storage for this data.
  localStorageKey?: string;

  // Storage key in indexed db for this data.
  indexedDbKey?: string;

  // How long to wait before the value is considered expired.
  storeExpiryMs?: number;
};

export function getStorageAdapter<T>(
  options: StorageOptions<T> | undefined,
  defaultStoreExpiryMs: number,
): StorageAdapter<T> | null {
  const { localStorageKey, indexedDbKey, storeExpiryMs, store } = options ?? {};

  if (store) {
    return store;
  }

  const expiryMs = storeExpiryMs || defaultStoreExpiryMs;

  if (localStorageKey) {
    return new LocalStore(localStorageKey, {
      defaultExpiryMs: expiryMs,
    }).asStorageAdapter<T>();
  }

  if (indexedDbKey) {
    return new KvStore(KvStoreConfig.dbName, {
      storeName: indexedDbKey,
      defaultExpiryMs: expiryMs,
    }).asStorageAdapter<T>();
  }

  return null;
}
