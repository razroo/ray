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

