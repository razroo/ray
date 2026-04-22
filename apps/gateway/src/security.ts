import type { IncomingMessage } from "node:http";
import type { RateLimitConfig } from "@razroo/ray-core";

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, FixedWindowEntry>();

  constructor(private readonly config: RateLimitConfig) {}

  take(key: string, now = Date.now()): RateLimitDecision {
    const existing = this.entries.get(key);

    if (!existing || existing.resetAt <= now) {
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
}

export function parseBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(authorizationHeader)) {
    return parseBearerToken(authorizationHeader[0]);
  }

  if (!authorizationHeader) {
    return undefined;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);

  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }

  return token;
}

export function resolveClientIp(request: IncomingMessage, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const forwarded = request.headers["x-forwarded-for"];

    if (typeof forwarded === "string") {
      return forwarded.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
    }

    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0]?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
    }
  }

  return request.socket.remoteAddress || "unknown";
}

export function buildRateLimitKey(
  strategy: RateLimitConfig["keyStrategy"],
  request: IncomingMessage,
  apiKey: string | undefined,
  trustProxyHeaders: boolean,
): string {
  const clientIp = resolveClientIp(request, trustProxyHeaders);

  if (strategy === "api-key" && apiKey) {
    return `api-key:${apiKey}`;
  }

  if (strategy === "ip+api-key" && apiKey) {
    return `api-key:${apiKey}:ip:${clientIp}`;
  }

  return `ip:${clientIp}`;
}
