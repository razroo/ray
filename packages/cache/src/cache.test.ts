import test from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "./index.js";

test("ttl cache returns stored values", () => {
  const cache = new TtlCache<string>({ maxEntries: 2, ttlMs: 10_000 });
  cache.set("a", "one");

  assert.equal(cache.get("a"), "one");
  assert.equal(cache.size(), 1);
});

test("ttl cache evicts the oldest entry once full", () => {
  const cache = new TtlCache<string>({ maxEntries: 2, ttlMs: 10_000 });
  cache.set("a", "one");
  cache.set("b", "two");
  cache.set("c", "three");

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "two");
  assert.equal(cache.get("c"), "three");
});

test("ttl cache evicts the oldest entries to stay within byte budget", () => {
  const cache = new TtlCache<string>({
    maxEntries: 10,
    ttlMs: 10_000,
    maxBytes: 10,
    sizeOf: (value) => value.length,
  });

  cache.set("a", "12345");
  cache.set("b", "12345");
  cache.set("c", "12345");

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), "12345");
  assert.equal(cache.get("c"), "12345");
  assert.equal(cache.sizeBytes(), 10);
});

test("ttl cache snapshots retained size and churn counters", () => {
  const cache = new TtlCache<unknown>({
    maxEntries: 2,
    ttlMs: 10_000,
    maxBytes: 12,
  });
  const circular: Record<string, unknown> = {
    value: "cached",
  };
  circular.self = circular;

  cache.set("a", "12345");
  cache.set("b", "12345");
  cache.set("c", "12345");
  cache.set("oversized", "x".repeat(20));
  cache.set("unmeasurable", circular);

  const snapshot = cache.snapshot();
  assert.equal(snapshot.entries, 2);
  assert.equal(snapshot.bytes, 12);
  assert.equal(snapshot.maxEntries, 2);
  assert.equal(snapshot.maxBytes, 12);
  assert.equal(snapshot.ttlMs, 10_000);
  assert.equal(snapshot.evictions, 1);
  assert.equal(snapshot.expirations, 0);
  assert.equal(snapshot.droppedOversizedEntries, 1);
  assert.equal(snapshot.droppedUnmeasurableEntries, 1);
});

test("ttl cache counts expired entries during snapshots", async () => {
  const cache = new TtlCache<string>({
    maxEntries: 2,
    ttlMs: 5,
  });

  cache.set("a", "one");
  cache.set("b", "two");
  await new Promise((resolve) => setTimeout(resolve, 10));

  const snapshot = cache.snapshot();
  assert.equal(snapshot.entries, 0);
  assert.equal(snapshot.bytes, 0);
  assert.equal(snapshot.evictions, 0);
  assert.equal(snapshot.expirations, 2);
  assert.equal(snapshot.droppedOversizedEntries, 0);
  assert.equal(snapshot.droppedUnmeasurableEntries, 0);
});

test("ttl cache applies a default byte budget", () => {
  const cache = new TtlCache<string>({
    maxEntries: 10,
    ttlMs: 10_000,
  });

  cache.set("small", "cached");
  cache.set("too-large", "x".repeat(2 * 1024 * 1024 + 1));

  const snapshot = cache.snapshot();
  assert.equal(cache.get("small"), "cached");
  assert.equal(cache.get("too-large"), undefined);
  assert.equal(snapshot.maxBytes, 2 * 1024 * 1024);
  assert.equal(snapshot.droppedOversizedEntries, 1);
});

test("ttl cache does not retain single entries above byte budget", () => {
  const cache = new TtlCache<string>({
    maxEntries: 10,
    ttlMs: 10_000,
    maxBytes: 8,
    sizeOf: (value) => value.length,
  });

  cache.set("a", "cached");
  cache.set("a", "too-large");

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size(), 0);
  assert.equal(cache.sizeBytes(), 0);
});

test("ttl cache does not retain unmeasurable entries with a byte budget", () => {
  const cache = new TtlCache<Record<string, unknown>>({
    maxEntries: 10,
    ttlMs: 10_000,
    maxBytes: 1_024,
  });
  const circular: Record<string, unknown> = {
    value: "cached",
  };
  circular.self = circular;

  cache.set("a", { value: "cached" });
  cache.set("a", circular);

  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size(), 0);
  assert.equal(cache.sizeBytes(), 0);
});

test("ttl cache rejects invalid capacity and ttl options", () => {
  assert.throws(() => new TtlCache<string>(null as never), /cache options must be an object/);
  assert.throws(
    () =>
      new TtlCache<string>({
        maxEntries: 2,
        ttlMs: 10_000,
        extra: "not-supported",
      } as never),
    /cache options must not contain unsupported key "extra"/,
  );
  assert.throws(
    () => new TtlCache<string>(JSON.parse('{"maxEntries":2,"ttlMs":10000,"__proto__":"polluted"}')),
    /cache options must not contain unsafe key "__proto__"/,
  );
  assert.throws(
    () =>
      new TtlCache<string>({
        maxEntries: 2,
        ttlMs: 10_000,
        sizeOf: "not-a-function" as never,
      }),
    /sizeOf must be a function/,
  );
  assert.throws(() => new TtlCache<string>({ maxEntries: 0, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2.5, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 4_097, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2, ttlMs: 0 }), /ttlMs/);
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: Number.POSITIVE_INFINITY }),
    /ttlMs/,
  );
  assert.throws(() => new TtlCache<string>({ maxEntries: 2, ttlMs: 86_400_001 }), /ttlMs/);
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: 10_000, maxBytes: 0 }),
    /maxBytes/,
  );
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: 10_000, maxBytes: 256 * 1024 * 1024 + 1 }),
    /maxBytes/,
  );
  assert.throws(
    () =>
      new TtlCache<string>({
        maxEntries: 2,
        ttlMs: 10_000,
        maxBytes: 10,
        sizeOf: () => -1,
      }).set("a", "one"),
    /cache entry size/,
  );
  assert.throws(
    () =>
      new TtlCache<string>({
        maxEntries: 2,
        ttlMs: 10_000,
        maxBytes: 10,
        sizeOf: () => undefined as unknown as number,
      }).set("a", "one"),
    /cache entry size/,
  );
});

test("ttl cache rejects malformed or oversized keys before measuring values", () => {
  let measured = false;
  const cache = new TtlCache<string>({
    maxEntries: 2,
    ttlMs: 10_000,
    maxBytes: 10,
    sizeOf: () => {
      measured = true;
      return 1;
    },
  });

  assert.throws(() => cache.set("", "one"), /cache key must be a non-empty string/);
  assert.throws(() => cache.get(123 as never), /cache key must be a non-empty string/);
  assert.throws(
    () => cache.set("x".repeat(4_097), "one"),
    /cache key must be at most 4096 characters/,
  );

  assert.equal(measured, false);
  assert.equal(cache.size(), 0);
});

test("ttl cache snapshots options at construction", () => {
  const options = { maxEntries: 2, ttlMs: 10_000 };
  const cache = new TtlCache<string>(options);
  options.maxEntries = 10;

  cache.set("a", "one");
  cache.set("b", "two");
  cache.set("c", "three");

  assert.equal(cache.size(), 2);
  assert.equal(cache.get("a"), undefined);
});
