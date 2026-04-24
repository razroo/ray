import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter } from "./security.js";

test("fixed-window rate limiter evicts the oldest key when capped", () => {
  const limiter = new FixedWindowRateLimiter({
    enabled: true,
    windowMs: 60_000,
    maxRequests: 1,
    maxKeys: 2,
    keyStrategy: "ip",
    trustProxyHeaders: false,
  });

  assert.equal(limiter.take("client-a", 0).allowed, true);
  assert.equal(limiter.take("client-b", 0).allowed, true);
  assert.equal(limiter.take("client-c", 0).allowed, true);
  assert.equal(limiter.take("client-a", 0).allowed, true);
});
