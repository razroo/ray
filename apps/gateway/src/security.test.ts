import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  FixedWindowRateLimiter,
  buildRateLimitKey,
  createApiKeyVerifier,
  parseBearerToken,
  resolveClientIp,
} from "./security.js";

function fakeRequest(remoteAddress: string, forwardedFor?: string | string[]): IncomingMessage {
  return {
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    socket: {
      remoteAddress,
    },
  } as unknown as IncomingMessage;
}

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

test("fixed-window rate limiter rejects invalid direct config", () => {
  assert.throws(
    () =>
      new FixedWindowRateLimiter({
        enabled: true,
        windowMs: 0,
        maxRequests: 1,
        maxKeys: 2,
        keyStrategy: "ip",
        trustProxyHeaders: false,
      }),
    /rateLimit\.windowMs/,
  );
  assert.throws(
    () =>
      new FixedWindowRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxRequests: Infinity,
        maxKeys: 2,
        keyStrategy: "ip",
        trustProxyHeaders: false,
      }),
    /rateLimit\.maxRequests/,
  );
  assert.throws(
    () =>
      new FixedWindowRateLimiter({
        enabled: true,
        windowMs: 60_000,
        maxRequests: 1,
        maxKeys: 2,
        keyStrategy: "raw" as "ip",
        trustProxyHeaders: false,
      }),
    /rateLimit\.keyStrategy/,
  );
});

test("fixed-window rate limiter snapshots config and bounds direct keys", () => {
  const config = {
    enabled: true,
    windowMs: 60_000,
    maxRequests: 1,
    maxKeys: 2,
    keyStrategy: "ip" as const,
    trustProxyHeaders: false,
  };
  const limiter = new FixedWindowRateLimiter(config);
  config.maxRequests = 100;

  assert.equal(limiter.take("client-a", 0).allowed, true);
  assert.equal(limiter.take("client-a", 0).allowed, false);
  assert.throws(() => limiter.take("x".repeat(513), 0), /rate limit key/);
});

test("fixed-window rate limiter snapshots active key pressure without exposing keys", () => {
  const limiter = new FixedWindowRateLimiter({
    enabled: true,
    windowMs: 1_000,
    maxRequests: 10,
    maxKeys: 2,
    keyStrategy: "ip",
    trustProxyHeaders: true,
  });

  assert.deepEqual(limiter.snapshot(0), {
    enabled: true,
    degraded: false,
    activeKeys: 0,
    maxKeys: 2,
    activeKeysRatio: 0,
    pressureThreshold: 0.9,
    windowMs: 1_000,
    maxRequests: 10,
    keyStrategy: "ip",
    trustProxyHeaders: true,
  });

  limiter.take("ip:198.51.100.1", 0);
  limiter.take("ip:198.51.100.2", 0);

  assert.deepEqual(limiter.snapshot(500), {
    enabled: true,
    degraded: true,
    activeKeys: 2,
    maxKeys: 2,
    activeKeysRatio: 1,
    pressureThreshold: 0.9,
    windowMs: 1_000,
    maxRequests: 10,
    keyStrategy: "ip",
    trustProxyHeaders: true,
  });

  assert.equal(limiter.snapshot(1_000).activeKeys, 0);
});

test("parseBearerToken rejects ambiguous or malformed authorization headers", () => {
  assert.equal(parseBearerToken("Bearer secret-token"), "secret-token");
  assert.equal(parseBearerToken("bearer secret-token"), "secret-token");
  assert.equal(parseBearerToken("Bearer secret-token extra"), undefined);
  assert.equal(parseBearerToken(["Bearer secret-token", "Bearer other-token"]), undefined);
  assert.equal(parseBearerToken("Basic secret-token"), undefined);
  assert.equal(parseBearerToken(`Bearer ${"x".repeat(1_025)}`), undefined);
});

test("createApiKeyVerifier accepts only configured bearer token values", () => {
  const verify = createApiKeyVerifier(new Set(["secret-token", "backup-token"]));

  assert.equal(verify("secret-token"), true);
  assert.equal(verify("backup-token"), true);
  assert.equal(verify("secret-token "), false);
  assert.equal(verify("wrong-token"), false);
  assert.equal(verify(undefined), false);
});

test("buildRateLimitKey hashes API key subjects instead of retaining raw secrets", () => {
  const request = fakeRequest("127.0.0.1");
  const apiKeyOnly = buildRateLimitKey("api-key", request, "secret-token", false);
  const apiKeyAndIp = buildRateLimitKey("ip+api-key", request, "secret-token", false);

  assert.match(apiKeyOnly, /^api-key-sha256:[a-f0-9]{64}$/);
  assert.match(apiKeyAndIp, /^api-key-sha256:[a-f0-9]{64}:ip:127\.0\.0\.1$/);
  assert.equal(apiKeyOnly.includes("secret-token"), false);
  assert.equal(apiKeyAndIp.includes("secret-token"), false);
  assert.equal(
    apiKeyOnly,
    buildRateLimitKey("api-key", fakeRequest("198.51.100.10"), "secret-token", false),
  );
  assert.notEqual(
    apiKeyOnly,
    buildRateLimitKey("api-key", request, "different-secret-token", false),
  );
});

test("resolveClientIp trusts forwarded headers only from local or private proxy peers", () => {
  assert.equal(
    resolveClientIp(fakeRequest("127.0.0.1", "203.0.113.10, 10.0.0.2"), true),
    "203.0.113.10",
  );
  assert.equal(
    resolveClientIp(fakeRequest("172.18.0.4", ["198.51.100.23, 172.18.0.4"]), true),
    "198.51.100.23",
  );
  assert.equal(resolveClientIp(fakeRequest("198.51.100.7", "203.0.113.44"), true), "198.51.100.7");
  assert.equal(resolveClientIp(fakeRequest("127.0.0.1", "203.0.113.10"), false), "127.0.0.1");
});

test("resolveClientIp normalizes trusted proxy headers into bounded IP keys", () => {
  assert.equal(
    resolveClientIp(fakeRequest("::ffff:127.0.0.1", "spoofed, 198.51.100.9, 10.0.0.2"), true),
    "198.51.100.9",
  );
  assert.equal(resolveClientIp(fakeRequest("127.0.0.1", "not-an-ip"), true), "127.0.0.1");
  assert.equal(resolveClientIp(fakeRequest("127.0.0.1", "x".repeat(4_096)), true), "127.0.0.1");
  assert.equal(resolveClientIp(fakeRequest("not-a-real-socket-address"), false), "unknown");

  const key = buildRateLimitKey("ip", fakeRequest("127.0.0.1", "x".repeat(4_096)), undefined, true);
  assert.equal(key, "ip:127.0.0.1");
});
