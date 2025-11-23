import { kvStore } from "@choksheak/ts-utils/kvStore";

export type StorageAdapter<T> = {
  set: (key: string, value: T) => Promise<void> | void;
  get: (key: string) => Promise<T | undefined> | T | undefined;
  delete: (key: string) => Promise<void> | void;
  clear: () => Promise<void> | void;
};

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
    return new LocalStorageAdapter<T>(localStorageKey, expiryMs);
  }

  if (indexedDbKey) {
    return new IndexedDbAdapter<T>(indexedDbKey, expiryMs);
  }

  return null;
}

/************************************************************************/
/* Storage adapters                                                     */
/************************************************************************/

type ValueWithExpiration<T> = { value: T; expiresAt: number };

/** Save state to memory only - not persisted. */
export class InMemoryStorageAdapter<T> implements StorageAdapter<T> {
  private readonly cache = new Map<string, ValueWithExpiration<T>>();

  public constructor(
    public readonly keyPrefix: string,
    public readonly expiryMs: number,
  ) {}

  public set(key: string, value: T): void {
    const fullKey = this.keyPrefix + ":" + key;
    this.cache.set(fullKey, {
      value,
      expiresAt: Date.now() + this.expiryMs,
    });
  }

  public get(key: string): T | undefined {
    const fullKey = this.keyPrefix + ":" + key;
    const cached = this.cache.get(fullKey);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    return undefined;
  }

  public delete(key: string): void {
    const fullKey = this.keyPrefix + ":" + key;
    this.cache.delete(fullKey);
  }

  public clear(): void {
    this.cache.clear();
  }
}

/** Save state to local storage. */
export class LocalStorageAdapter<T> implements StorageAdapter<T> {
  public constructor(
    public readonly keyPrefix: string,
    public readonly expiryMs: number,
  ) {}

  public set(key: string, value: T): void {
    if (typeof window === "undefined") return;

    const fullKey = this.keyPrefix + ":" + key;
    window.localStorage.setItem(
      fullKey,
      JSON.stringify({
        value,
        expiresAt: this.expiryMs ? Date.now() + this.expiryMs : 0,
      } satisfies ValueWithExpiration<T>),
    );
  }

  public get(key: string): T | undefined {
    if (typeof window === "undefined") return undefined;

    const fullKey = this.keyPrefix + ":" + key;
    const raw = window.localStorage.getItem(fullKey);
    if (!raw) return undefined;

    try {
      const box = JSON.parse(raw) as ValueWithExpiration<T>;
      if (!box || (box.expiresAt && Date.now() >= box.expiresAt)) {
        window.localStorage.removeItem(fullKey);
        return undefined;
      }

      return box.value;
    } catch {
      // Ignore error.
      window.localStorage.removeItem(fullKey);
      return undefined;
    }
  }

  public delete(key: string): void {
    if (typeof window === "undefined") return;

    const fullKey = this.keyPrefix + ":" + key;
    window.localStorage.removeItem(fullKey);
  }

  public clear(): void {
    if (typeof window === "undefined") return;

    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(this.keyPrefix)) {
        window.localStorage.removeItem(key);
      }
    }
  }
}

/** Save state to indexed db. */
export class IndexedDbAdapter<T> implements StorageAdapter<T> {
  public constructor(
    public readonly keyPrefix: string,
    public readonly expiryMs: number,
  ) {}

  public async set(key: string, value: T): Promise<void> {
    if (typeof window === "undefined") return;

    const fullKey = this.keyPrefix + ":" + key;
    await kvStore.set(fullKey, JSON.stringify(value), this.expiryMs);
  }

  public async get(key: string): Promise<T | undefined> {
    if (typeof window === "undefined") return undefined;

    const fullKey = this.keyPrefix + ":" + key;
    const raw = await kvStore.get<string>(fullKey);
    if (raw === undefined) return undefined;

    try {
      return JSON.parse(raw);
    } catch {
      // Ignore error.
      await kvStore.delete(fullKey);
      return undefined;
    }
  }

  public async delete(key: string): Promise<void> {
    if (typeof window === "undefined") return;

    const fullKey = this.keyPrefix + ":" + key;
    await kvStore.delete(fullKey);
  }

  public async clear(): Promise<void> {
    if (typeof window === "undefined") return;

    await kvStore.forEach(async (k) => {
      if (k.startsWith(this.keyPrefix)) {
        await kvStore.delete(k);
      }
    });
  }
}
