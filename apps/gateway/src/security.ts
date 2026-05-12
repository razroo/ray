import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { RateLimitConfig } from "@razroo/ray-core";

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

const MAX_FORWARDED_FOR_ENTRIES = 32;
const MAX_IP_ADDRESS_CHARS = 64;
const MAX_BEARER_TOKEN_CHARS = 1_024;
const MAX_RATE_LIMIT_WINDOW_MS = 3_600_000;
const MAX_RATE_LIMIT_REQUESTS = 10_000;
const MAX_RATE_LIMIT_KEYS = 16_384;
const MAX_RATE_LIMIT_KEY_CHARS = 512;

const rateLimitKeyStrategies = new Set<RateLimitConfig["keyStrategy"]>([
  "ip",
  "api-key",
  "ip+api-key",
]);

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
}

function snapshotRateLimitConfig(config: RateLimitConfig): RateLimitConfig {
  assertBoolean(config.enabled, "rateLimit.enabled");
  assertBoolean(config.trustProxyHeaders, "rateLimit.trustProxyHeaders");
  assertPositiveSafeIntegerAtMost(config.windowMs, "rateLimit.windowMs", MAX_RATE_LIMIT_WINDOW_MS);
  assertPositiveSafeIntegerAtMost(
    config.maxRequests,
    "rateLimit.maxRequests",
    MAX_RATE_LIMIT_REQUESTS,
  );
  assertPositiveSafeIntegerAtMost(config.maxKeys, "rateLimit.maxKeys", MAX_RATE_LIMIT_KEYS);

  if (!rateLimitKeyStrategies.has(config.keyStrategy)) {
    throw new TypeError("rateLimit.keyStrategy is not supported");
  }

  return {
    enabled: config.enabled,
    windowMs: config.windowMs,
    maxRequests: config.maxRequests,
    maxKeys: config.maxKeys,
    keyStrategy: config.keyStrategy,
    trustProxyHeaders: config.trustProxyHeaders,
  };
}

function assertRateLimitKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("rate limit key must be a non-empty string");
  }

  if (key.length > MAX_RATE_LIMIT_KEY_CHARS) {
    throw new RangeError(`rate limit key must be at most ${MAX_RATE_LIMIT_KEY_CHARS} characters`);
  }
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, FixedWindowEntry>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = snapshotRateLimitConfig(config);
  }

  take(key: string, now = Date.now()): RateLimitDecision {
    assertRateLimitKey(key);

    let existing = this.entries.get(key);

    if (existing && existing.resetAt <= now) {
      this.entries.delete(key);
      existing = undefined;
    }

    if (!existing) {
      this.ensureCapacity(now);
      const resetAt = now + this.config.windowMs;
      this.entries.set(key, {
        count: 1,
        resetAt,
      });

      return {
        allowed: true,
        limit: this.config.maxRequests,
        remaining: Math.max(this.config.maxRequests - 1, 0),
        resetAt,
      };
    }

    existing.count += 1;

    return {
      allowed: existing.count <= this.config.maxRequests,
      limit: this.config.maxRequests,
      remaining: Math.max(this.config.maxRequests - existing.count, 0),
      resetAt: existing.resetAt,
    };
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < this.config.maxKeys) {
      return;
    }

    this.pruneExpired(now);

    while (this.entries.size >= this.config.maxKeys) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export function parseBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(authorizationHeader)) {
    return authorizationHeader.length === 1 ? parseBearerToken(authorizationHeader[0]) : undefined;
  }

  if (!authorizationHeader) {
    return undefined;
  }

  const parts = authorizationHeader.trim().split(/\s+/);
  const [scheme, token] = parts;

  if (
    parts.length !== 2 ||
    !scheme ||
    scheme.toLowerCase() !== "bearer" ||
    !token ||
    token.length > MAX_BEARER_TOKEN_CHARS
  ) {
    return undefined;
  }

  return token;
}

function digestApiKey(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashApiKeySubject(apiKey: string): string {
  return digestApiKey(apiKey).toString("hex");
}

export function createApiKeyVerifier(
  apiKeys: Set<string>,
): (bearerToken: string | undefined) => boolean {
  const allowedDigests = [...apiKeys].map((apiKey) => digestApiKey(apiKey));

  return (bearerToken) => {
    if (!bearerToken || allowedDigests.length === 0) {
      return false;
    }

    const bearerDigest = digestApiKey(bearerToken);
    let allowed = false;

    for (const allowedDigest of allowedDigests) {
      allowed = timingSafeEqual(bearerDigest, allowedDigest) || allowed;
    }

    return allowed;
  };
}

function normalizeIpAddress(address: string | undefined): string {
  return (address ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/^::ffff:/, "")
    .replace(/\.$/, "");
}

function isPrivateOrLocalIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateOrLocalIpv6(address: string): boolean {
  const firstSegment = address.split(":")[0] ?? "";

  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(firstSegment)
  );
}

function isTrustedProxyPeer(address: string | undefined): boolean {
  const normalized = normalizeIpAddress(address);
  const version = isIP(normalized);

  if (version === 4) {
    return isPrivateOrLocalIpv4(normalized);
  }

  if (version === 6) {
    return isPrivateOrLocalIpv6(normalized);
  }

  return false;
}

function isPrivateOrLocalIpAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isPrivateOrLocalIpv4(address);
  }

  if (version === 6) {
    return isPrivateOrLocalIpv6(address);
  }

  return false;
}

function parseForwardedFor(value: string | string[] | undefined): string | undefined {
  const headers = typeof value === "string" ? [value] : (value ?? []);
  const candidates: string[] = [];

  for (const header of headers) {
    for (const part of header.split(",")) {
      const normalized = normalizeIpAddress(part);

      if (normalized.length > 0 && normalized.length <= MAX_IP_ADDRESS_CHARS && isIP(normalized)) {
        candidates.push(normalized);
      }
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const boundedCandidates = candidates.slice(-MAX_FORWARDED_FOR_ENTRIES);

  for (let index = boundedCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = boundedCandidates[index]!;
    if (!isPrivateOrLocalIpAddress(candidate)) {
      return candidate;
    }
  }

  return boundedCandidates.at(-1);
}

function resolveSocketIp(address: string | undefined): string {
  const normalized = normalizeIpAddress(address);

  return normalized.length <= MAX_IP_ADDRESS_CHARS && isIP(normalized) ? normalized : "unknown";
}

export function resolveClientIp(request: IncomingMessage, trustProxyHeaders: boolean): string {
  const socketIp = resolveSocketIp(request.socket.remoteAddress);

  if (trustProxyHeaders && isTrustedProxyPeer(socketIp)) {
    return parseForwardedFor(request.headers["x-forwarded-for"]) ?? socketIp;
  }

  return socketIp;
}

export function buildRateLimitKey(
  strategy: RateLimitConfig["keyStrategy"],
  request: IncomingMessage,
  apiKey: string | undefined,
  trustProxyHeaders: boolean,
): string {
  const clientIp = resolveClientIp(request, trustProxyHeaders);

  if (strategy === "api-key" && apiKey) {
    return `api-key-sha256:${hashApiKeySubject(apiKey)}`;
  }

  if (strategy === "ip+api-key" && apiKey) {
    return `api-key-sha256:${hashApiKeySubject(apiKey)}:ip:${clientIp}`;
  }

  return `ip:${clientIp}`;
}
