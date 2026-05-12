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

test("ttl cache rejects invalid capacity and ttl options", () => {
  assert.throws(() => new TtlCache<string>({ maxEntries: 0, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2.5, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2, ttlMs: 0 }), /ttlMs/);
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: Number.POSITIVE_INFINITY }),
    /ttlMs/,
  );
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: 10_000, maxBytes: 0 }),
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
