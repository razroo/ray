interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  sizeBytes: number;
}

export interface TtlCacheOptions<T = unknown> {
  maxEntries: number;
  ttlMs: number;
  maxBytes?: number;
  sizeOf?: (value: T, key: string) => number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly options: TtlCacheOptions<T>;
  private totalBytes = 0;

  constructor(options: TtlCacheOptions<T>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }

    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive safe integer");
    }

    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    ) {
      throw new RangeError("maxBytes must be a positive safe integer when provided");
    }

    this.options = {
      maxEntries: options.maxEntries,
      ttlMs: options.ttlMs,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.sizeOf ? { sizeOf: options.sizeOf } : {}),
    };
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(key);
      return undefined;
    }

    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    this.purgeExpired();

    const sizeBytes = this.resolveEntrySize(value, key);

    if (this.store.has(key)) {
      this.deleteEntry(key);
    }

    if (this.options.maxBytes !== undefined && sizeBytes > this.options.maxBytes) {
      return;
    }

    while (
      this.store.size >= this.options.maxEntries ||
      (this.options.maxBytes !== undefined && this.totalBytes + sizeBytes > this.options.maxBytes)
    ) {
      const oldestKey = this.store.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.deleteEntry(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.options.ttlMs,
      sizeBytes,
    });
    this.totalBytes += sizeBytes;
  }

  size(): number {
    this.purgeExpired();
    return this.store.size;
  }

  sizeBytes(): number {
    this.purgeExpired();
    return this.totalBytes;
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  purgeExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key);
      }
    }
  }

  private deleteEntry(key: string): boolean {
    const entry = this.store.get(key);

    if (!entry) {
      return false;
    }

    this.totalBytes -= entry.sizeBytes;
    this.store.delete(key);
    return true;
  }

  private resolveEntrySize(value: T, key: string): number {
    const sizeBytes = this.options.sizeOf
      ? this.options.sizeOf(value, key)
      : estimateCacheEntryBytes(value, key);

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new RangeError("cache entry size must be a non-negative safe integer");
    }

    return sizeBytes;
  }
}

function estimateCacheEntryBytes(value: unknown, key: string): number {
  const keyBytes = Buffer.byteLength(key, "utf8");

  if (typeof value === "string") {
    return keyBytes + Buffer.byteLength(value, "utf8");
  }

  if (Buffer.isBuffer(value)) {
    return keyBytes + value.byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return keyBytes + value.byteLength;
  }

  if (ArrayBuffer.isView(value)) {
    return keyBytes + value.byteLength;
  }

  try {
    return keyBytes + Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return keyBytes;
  }
}
