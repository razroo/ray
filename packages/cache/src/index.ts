interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCacheOptions {
  maxEntries: number;
  ttlMs: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(private readonly options: TtlCacheOptions) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    this.purgeExpired();

    if (this.store.has(key)) {
      this.store.delete(key);
    }

    while (this.store.size >= this.options.maxEntries) {
      const oldestKey = this.store.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.options.ttlMs,
    });
  }

  size(): number {
    this.purgeExpired();
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  purgeExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
