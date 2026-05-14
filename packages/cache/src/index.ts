interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  sizeBytes: number;
}

const MAX_CACHE_ENTRIES = 4_096;
const MAX_CACHE_TTL_MS = 86_400_000;
const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_KEY_CHARS = 4_096;
const unsafeCacheOptionKeys = new Set(["__proto__", "constructor", "prototype"]);
const cacheOptionKeys = new Set(["maxEntries", "ttlMs", "maxBytes", "sizeOf"]);

export interface TtlCacheOptions<T = unknown> {
  maxEntries: number;
  ttlMs: number;
  maxBytes?: number;
  sizeOf?: (value: T, key: string) => number;
}

export interface TtlCacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes?: number;
  ttlMs: number;
  evictions: number;
  expirations: number;
  droppedOversizedEntries: number;
  droppedUnmeasurableEntries: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly options: TtlCacheOptions<T>;
  private totalBytes = 0;
  private evictions = 0;
  private expirations = 0;
  private droppedOversizedEntries = 0;
  private droppedUnmeasurableEntries = 0;

  constructor(options: TtlCacheOptions<T>) {
    assertCacheOptions(options);
    assertPositiveSafeIntegerAtMost(options.maxEntries, "maxEntries", MAX_CACHE_ENTRIES);
    assertPositiveSafeIntegerAtMost(options.ttlMs, "ttlMs", MAX_CACHE_TTL_MS);

    const maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
    assertPositiveSafeIntegerAtMost(maxBytes, "maxBytes", MAX_CACHE_BYTES);

    this.options = {
      maxEntries: options.maxEntries,
      ttlMs: options.ttlMs,
      maxBytes,
      ...(options.sizeOf ? { sizeOf: options.sizeOf } : {}),
    };
  }

  get(key: string): T | undefined {
    assertCacheKey(key);
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(key, "expired");
      return undefined;
    }

    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    assertCacheKey(key);
    this.purgeExpired();

    const sizeBytes = this.resolveEntrySize(value, key);

    if (this.store.has(key)) {
      this.deleteEntry(key);
    }

    if (sizeBytes === undefined) {
      this.droppedUnmeasurableEntries += 1;
      return;
    }

    if (this.options.maxBytes !== undefined && sizeBytes > this.options.maxBytes) {
      this.droppedOversizedEntries += 1;
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

      this.deleteEntry(oldestKey, "evicted");
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

  snapshot(): TtlCacheStats {
    this.purgeExpired();
    return {
      entries: this.store.size,
      bytes: this.totalBytes,
      maxEntries: this.options.maxEntries,
      ...(this.options.maxBytes !== undefined ? { maxBytes: this.options.maxBytes } : {}),
      ttlMs: this.options.ttlMs,
      evictions: this.evictions,
      expirations: this.expirations,
      droppedOversizedEntries: this.droppedOversizedEntries,
      droppedUnmeasurableEntries: this.droppedUnmeasurableEntries,
    };
  }

  purgeExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key, "expired");
      }
    }
  }

  private deleteEntry(key: string, reason?: "evicted" | "expired"): boolean {
    const entry = this.store.get(key);

    if (!entry) {
      return false;
    }

    this.totalBytes -= entry.sizeBytes;
    this.store.delete(key);
    if (reason === "evicted") {
      this.evictions += 1;
    } else if (reason === "expired") {
      this.expirations += 1;
    }
    return true;
  }

  private resolveEntrySize(value: T, key: string): number | undefined {
    if (this.options.sizeOf) {
      const sizeBytes = this.options.sizeOf(value, key);

      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new RangeError("cache entry size must be a non-negative safe integer");
      }

      return sizeBytes;
    }

    const sizeBytes = estimateCacheEntryBytes(value, key);

    if (sizeBytes === undefined && this.options.maxBytes !== undefined) {
      return undefined;
    }

    if (sizeBytes === undefined) {
      return Buffer.byteLength(key, "utf8");
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new RangeError("cache entry size must be a non-negative safe integer");
    }

    return sizeBytes;
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertCacheOptions<T>(options: TtlCacheOptions<T>): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("cache options must be an object");
  }

  for (const [key] of objectEntries(options, "cache options")) {
    if (unsafeCacheOptionKeys.has(key)) {
      throw new TypeError(`cache options must not contain unsafe key "${key}"`);
    }

    if (!cacheOptionKeys.has(key)) {
      throw new TypeError(`cache options must not contain unsupported key "${key}"`);
    }
  }

  if (options.sizeOf !== undefined && typeof options.sizeOf !== "function") {
    throw new TypeError("sizeOf must be a function when provided");
  }
}

function assertCacheKey(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("cache key must be a non-empty string");
  }

  if (value.length > MAX_CACHE_KEY_CHARS) {
    throw new RangeError(`cache key must be at most ${MAX_CACHE_KEY_CHARS} characters`);
  }
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function estimateCacheEntryBytes(value: unknown, key: string): number | undefined {
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
    return undefined;
  }
}
