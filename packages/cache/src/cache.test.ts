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

test("ttl cache rejects invalid capacity and ttl options", () => {
  assert.throws(() => new TtlCache<string>({ maxEntries: 0, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2.5, ttlMs: 10_000 }), /maxEntries/);
  assert.throws(() => new TtlCache<string>({ maxEntries: 2, ttlMs: 0 }), /ttlMs/);
  assert.throws(
    () => new TtlCache<string>({ maxEntries: 2, ttlMs: Number.POSITIVE_INFINITY }),
    /ttlMs/,
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
