import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { loadRayConfig, resolveAuthApiKeys, snapshotRayConfig } from "@ray/config";
import {
  RayError,
  toErrorMessage,
  type AsyncQueueSnapshot,
  type CreateInferenceJobRequest,
  type HealthSnapshot,
  type InferenceRequest,
  type RayConfig,
  type ReadinessReason,
  type ReadinessSnapshot,
  type RuntimeMetricsSnapshot,
} from "@razroo/ray-core";
import { RayRuntime, createRayRuntime } from "@ray/runtime";
import { Logger, serializeError } from "@ray/telemetry";
import { DurableInferenceQueue } from "./async-jobs.js";
import {
  FixedWindowRateLimiter,
  buildRateLimitKey,
  createApiKeyVerifier,
  parseBearerToken,
} from "./security.js";

interface CliOptions {
  configPath?: string;
}

const MAX_GATEWAY_CLI_ARGS = 16;
const MAX_GATEWAY_CLI_ARG_BYTES = 8_192;
const MAX_GATEWAY_CONFIG_PATH_CHARS = 4_096;
const MAX_GATEWAY_REQUEST_TARGET_CHARS = 8_192;
const MAX_GATEWAY_HOST_HEADER_CHARS = 512;
const MAX_GATEWAY_CONTENT_TYPE_CHARS = 256;
const GATEWAY_HEADERS_TIMEOUT_MS = 15_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const GATEWAY_MAX_REQUESTS_PER_SOCKET = 1_000;
const GATEWAY_SHUTDOWN_TIMEOUT_MS = 30_000;
const GATEWAY_WARMUP_RETRY_INITIAL_MS = 2_000;
const GATEWAY_WARMUP_RETRY_MAX_MS = 15_000;
const GATEWAY_WARMUP_RETRY_DELAY_MAX_MS = 60_000;
const MAX_RESPONSE_FIELD_DEPTH = 10;
const MAX_RESPONSE_OBJECT_KEYS = 256;
const MAX_RESPONSE_ARRAY_ITEMS = 512;
const MAX_RESPONSE_OBJECT_KEY_CHARS = 128;
const MAX_RESPONSE_STRING_CHARS = 65_536;
const QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS = 1;
const STORAGE_BACKPRESSURE_RETRY_AFTER_SECONDS = 30;
const GATEWAY_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const expectedRequestRejectionCodes = new Set([
  "queue_full",
  "request_timeout",
  "async_queue_full",
  "async_queue_storage_low",
]);

export interface CreateGatewayHandlerOptions {
  config: RayConfig;
  runtime?: RayRuntime;
  jobQueue?: DurableInferenceQueue;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: FixedWindowRateLimiter;
  warmupSnapshot?: () => GatewayWarmupSnapshot | undefined;
}

export interface GatewayServer {
  server: Server;
  runtime: RayRuntime;
  jobQueue?: DurableInferenceQueue;
  logger: Logger;
  warmup?: GatewayWarmupController | undefined;
  sockets?: Set<Socket>;
  activeRequestsBySocket?: Map<Socket, number>;
}

export interface GatewayWarmupRetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface GatewayWarmupSnapshot {
  attempts: number;
  failures: number;
  inFlight: boolean;
  retryScheduled: boolean;
  retryInMs: number;
  succeeded: boolean;
  stopped: boolean;
}

export interface GatewayWarmupController {
  stop(): void;
  snapshot(): GatewayWarmupSnapshot;
}

export interface StartGatewayOptions extends CreateGatewayHandlerOptions {
  configPath?: string;
  warmupRetry?: GatewayWarmupRetryOptions;
}

export interface StopGatewayOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

function assertCliArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_GATEWAY_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_GATEWAY_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_GATEWAY_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_GATEWAY_CLI_ARG_BYTES} bytes`);
    }
  }
}

function attachAsyncQueueMetrics(
  metrics: RuntimeMetricsSnapshot,
  snapshot: AsyncQueueSnapshot,
): RuntimeMetricsSnapshot {
  metrics.gauges["async_queue.enabled"] = snapshot.enabled ? 1 : 0;
  metrics.gauges["async_queue.degraded"] = snapshot.degraded ? 1 : 0;
  metrics.gauges["async_queue.queued"] = snapshot.queued;
  metrics.gauges["async_queue.running"] = snapshot.running;
  metrics.gauges["async_queue.callback_pending"] = snapshot.callbackPending;
  metrics.gauges["async_queue.total_jobs"] = snapshot.totalJobs;
  metrics.gauges["async_queue.max_jobs"] = snapshot.maxJobs;
  metrics.gauges["async_queue.jobs_ratio"] = snapshot.jobsRatio;
  if (snapshot.availableStorageMiB !== undefined) {
    metrics.gauges["async_queue.available_storage_mib"] = snapshot.availableStorageMiB;
  }
  metrics.gauges["async_queue.min_free_storage_mib"] = snapshot.minFreeStorageMiB;
  if (snapshot.storageReserveRatio !== undefined) {
    metrics.gauges["async_queue.storage_reserve_ratio"] = snapshot.storageReserveRatio;
  }
  if (snapshot.storageLow !== undefined) {
    metrics.gauges["async_queue.storage_low"] = snapshot.storageLow ? 1 : 0;
  }
  metrics.gauges["async_queue.completed_ttl_ms"] = snapshot.completedTtlMs;
  metrics.gauges["async_queue.dispatch_concurrency"] = snapshot.dispatchConcurrency;

  return metrics;
}

function attachGatewayWarmupMetrics(
  metrics: RuntimeMetricsSnapshot,
  snapshot: GatewayWarmupSnapshot,
): RuntimeMetricsSnapshot {
  metrics.gauges["gateway.warmup.attempts"] = snapshot.attempts;
  metrics.gauges["gateway.warmup.failures"] = snapshot.failures;
  metrics.gauges["gateway.warmup.in_flight"] = snapshot.inFlight ? 1 : 0;
  metrics.gauges["gateway.warmup.retry_scheduled"] = snapshot.retryScheduled ? 1 : 0;
  metrics.gauges["gateway.warmup.retry_delay_ms"] = snapshot.retryInMs;
  metrics.gauges["gateway.warmup.succeeded"] = snapshot.succeeded ? 1 : 0;
  metrics.gauges["gateway.warmup.stopped"] = snapshot.stopped ? 1 : 0;

  return metrics;
}

function attachAsyncQueueHealth(
  health: HealthSnapshot,
  snapshot: AsyncQueueSnapshot,
): HealthSnapshot {
  health.asyncQueue = snapshot;

  if (health.status === "ok" && snapshot.degraded) {
    health.status = "degraded";
  }

  return health;
}

function resolveReadyzStatusCode(health: HealthSnapshot): number {
  if (
    health.status === "unavailable" ||
    health.provider.status === "unavailable" ||
    health.provider.status === "warming"
  ) {
    return 503;
  }

  return 200;
}

function buildReadyzResponse(health: HealthSnapshot): ReadinessSnapshot {
  const queuePressure = health.runtime?.queue.degraded ?? false;
  const preparationPressure = health.runtime?.preparation.degraded ?? false;
  const memoryPressure = health.runtime?.memory.degraded ?? false;
  const cpuPressure = health.runtime?.cpu?.degraded ?? false;
  const asyncQueuePressure = health.asyncQueue?.degraded ?? false;
  const reasons: ReadinessReason[] = [];

  if (health.provider.status === "unavailable") {
    reasons.push("provider_unavailable");
  } else if (health.provider.status === "warming") {
    reasons.push("provider_warming");
  } else if (health.provider.status === "degraded") {
    reasons.push("provider_degraded");
  }

  if (queuePressure) {
    reasons.push("queue_pressure");
  }

  if (preparationPressure) {
    reasons.push("preparation_pressure");
  }

  if (memoryPressure) {
    reasons.push("memory_pressure");
  }

  if (cpuPressure) {
    reasons.push("cpu_pressure");
  }

  if (asyncQueuePressure) {
    reasons.push("async_queue_pressure");
  }

  return {
    status: health.status,
    service: "ray-gateway",
    providerStatus: health.provider.status,
    queueDepth: health.queueDepth,
    inFlight: health.inFlight,
    pressure: {
      queue: queuePressure,
      preparation: preparationPressure,
      memory: memoryPressure,
      cpu: cpuPressure,
      asyncQueue: asyncQueuePressure,
    },
    reasons,
  };
}

function resolveWarmupRetryDelayOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 1 || value > GATEWAY_WARMUP_RETRY_DELAY_MAX_MS) {
    throw new Error(`${label} must be a finite delay between 1 and 60000 milliseconds`);
  }

  return value;
}

function resolveWarmupRetryOptions(
  options: GatewayWarmupRetryOptions | undefined,
): Required<GatewayWarmupRetryOptions> {
  return {
    initialDelayMs: resolveWarmupRetryDelayOption(
      options?.initialDelayMs,
      GATEWAY_WARMUP_RETRY_INITIAL_MS,
      "warmupRetry.initialDelayMs",
    ),
    maxDelayMs: resolveWarmupRetryDelayOption(
      options?.maxDelayMs,
      GATEWAY_WARMUP_RETRY_MAX_MS,
      "warmupRetry.maxDelayMs",
    ),
  };
}

function resolveWarmupRetryDelayMs(
  attempt: number,
  options: Required<GatewayWarmupRetryOptions>,
): number {
  const multiplier = 2 ** Math.min(Math.max(0, attempt - 1), 4);

  return Math.min(options.maxDelayMs, options.initialDelayMs * multiplier);
}

function destroyGatewaySockets(sockets: Iterable<Socket> | undefined): void {
  for (const socket of sockets ?? []) {
    socket.destroy();
  }
}

function destroyIdleGatewaySockets(gateway: GatewayServer): void {
  if (!gateway.sockets || !gateway.activeRequestsBySocket) {
    return;
  }

  for (const socket of gateway.sockets) {
    if ((gateway.activeRequestsBySocket.get(socket) ?? 0) === 0) {
      socket.destroy();
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function assertConfigPathFlagValue(value: string, flag: string): void {
  if (value.length > MAX_GATEWAY_CONFIG_PATH_CHARS) {
    throw new Error(`${flag} must be at most ${MAX_GATEWAY_CONFIG_PATH_CHARS} characters`);
  }
}

export function parseCliArgs(argv: string[]): CliOptions {
  assertCliArgv(argv);

  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === undefined) {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (current === "--config") {
      const value = requireFlagValue("--config", next);
      assertConfigPathFlagValue(value, "--config");
      options.configPath = value;
      index += 1;
      continue;
    }

    if (current.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current}`);
  }

  return options;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = stringifyJsonResponse(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    ...extraHeaders,
  });
  response.end(body);
}

function truncateResponseString(value: string, maxChars = MAX_RESPONSE_STRING_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function truncateResponseKey(value: string): string {
  if (value.length <= MAX_RESPONSE_OBJECT_KEY_CHARS) {
    return value;
  }

  let headChars = MAX_RESPONSE_OBJECT_KEY_CHARS;

  for (;;) {
    const omittedChars = value.length - headChars;
    const suffix = `...[truncated ${omittedChars} chars]`;
    const nextHeadChars = MAX_RESPONSE_OBJECT_KEY_CHARS - suffix.length;

    if (nextHeadChars <= 0) {
      return suffix.slice(0, MAX_RESPONSE_OBJECT_KEY_CHARS);
    }

    if (nextHeadChars === headChars) {
      return `${value.slice(0, headChars)}${suffix}`;
    }

    headChars = nextHeadChars;
  }
}

function sanitizeJsonResponseValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateResponseString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_RESPONSE_FIELD_DEPTH) {
    return "[Truncated]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: truncateResponseString(value.message),
    };

    return serialized;
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_RESPONSE_ARRAY_ITEMS)
        .map((entry) => sanitizeJsonResponseValue(entry, seen, depth + 1));

      if (value.length > MAX_RESPONSE_ARRAY_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_RESPONSE_ARRAY_ITEMS} items]`);
      }

      return items;
    }

    const output: Record<string, unknown> = {};
    let keys: string[];

    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable object: ${truncateResponseString(toErrorMessage(error))}]`;
    }

    for (const key of keys.slice(0, MAX_RESPONSE_OBJECT_KEYS)) {
      const safeKey = truncateResponseKey(key);

      try {
        output[safeKey] = sanitizeJsonResponseValue(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[safeKey] = `[Thrown: ${truncateResponseString(toErrorMessage(error))}]`;
      }
    }

    if (keys.length > MAX_RESPONSE_OBJECT_KEYS) {
      output.__truncatedKeys = keys.length - MAX_RESPONSE_OBJECT_KEYS;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function stringifyJsonResponse(payload: unknown): string {
  try {
    const serialized = JSON.stringify(sanitizeJsonResponseValue(payload, new WeakSet()), null, 2);
    return `${serialized ?? "null"}\n`;
  } catch (error) {
    return `${JSON.stringify(
      {
        error: {
          code: "response_serialization_failed",
          message: "The gateway could not serialize the response payload",
          details: toErrorMessage(error),
        },
      },
      null,
      2,
    )}\n`;
  }
}

function writeJsonWithoutReadingBody(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const closeRequest = closeRequestAfterResponse(request, response);
  writeJson(response, statusCode, payload, {
    ...extraHeaders,
    ...(closeRequest ? { connection: "close" } : {}),
  });
}

function closeRequestAfterResponse(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.complete) {
    return false;
  }

  response.once("finish", () => {
    request.destroy();
  });

  return true;
}

function getDeclaredContentLength(request: IncomingMessage): number | undefined {
  const header = request.headers["content-length"];

  if (typeof header !== "string") {
    return undefined;
  }

  const normalized = header.trim();
  const parsed = Number(normalized);

  return /^\d+$/.test(normalized) && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function createUnsupportedJsonContentTypeError(contentType: string | undefined): RayError {
  return new RayError("Request content type must be application/json", {
    code: "unsupported_media_type",
    status: 415,
    details: {
      ...(contentType !== undefined
        ? { contentType: truncateResponseString(contentType, 128) }
        : {}),
      supported: ["application/json", "application/*+json"],
    },
  });
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const [type, subtype, extra] = mediaType.split("/");

  return (
    type === "application" &&
    extra === undefined &&
    subtype !== undefined &&
    (subtype === "json" || subtype.endsWith("+json"))
  );
}

function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];

  if (typeof contentType !== "string" || contentType.trim().length === 0) {
    throw createUnsupportedJsonContentTypeError(undefined);
  }

  if (contentType.length > MAX_GATEWAY_CONTENT_TYPE_CHARS) {
    throw new RayError(
      `Content-Type header must be at most ${MAX_GATEWAY_CONTENT_TYPE_CHARS} characters`,
      {
        code: "unsupported_media_type",
        status: 415,
        details: {
          actualChars: contentType.length,
          maxChars: MAX_GATEWAY_CONTENT_TYPE_CHARS,
        },
      },
    );
  }

  if (!isJsonContentType(contentType)) {
    throw createUnsupportedJsonContentTypeError(contentType);
  }
}

function createInvalidGatewayHostHeaderError(): RayError {
  return new RayError("Host header is invalid", {
    code: "invalid_request",
    status: 400,
  });
}

function assertGatewayHostHeaderPort(value: string | undefined): void {
  if (value === undefined) {
    return;
  }

  const parsed = Number(value);

  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw createInvalidGatewayHostHeaderError();
  }
}

function hasInvalidGatewayHostHeaderChar(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) <= 32 || char === "/" || char === "?" || char === "#") {
      return true;
    }

    if (char === "@" || char === "\\") {
      return true;
    }
  }

  return false;
}

function assertGatewayHostHeader(hostHeader: string | undefined): void {
  if (hostHeader === undefined) {
    return;
  }

  if (hostHeader.length === 0) {
    throw new RayError("Host header must be non-empty when provided", {
      code: "invalid_request",
      status: 400,
    });
  }

  if (hostHeader.length > MAX_GATEWAY_HOST_HEADER_CHARS) {
    throw new RayError(`Host header must be at most ${MAX_GATEWAY_HOST_HEADER_CHARS} characters`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxChars: MAX_GATEWAY_HOST_HEADER_CHARS,
        actualChars: hostHeader.length,
      },
    });
  }

  if (hasInvalidGatewayHostHeaderChar(hostHeader) || hostHeader.includes("://")) {
    throw createInvalidGatewayHostHeaderError();
  }

  if (hostHeader.startsWith("[")) {
    const match = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(hostHeader);

    if (!match || isIP(match[1] ?? "") !== 6) {
      throw createInvalidGatewayHostHeaderError();
    }

    assertGatewayHostHeaderPort(match[2]);
    return;
  }

  const parts = hostHeader.split(":");

  if (parts.length > 2) {
    throw createInvalidGatewayHostHeaderError();
  }

  const hostname = parts[0] ?? "";
  const port = parts[1];
  assertGatewayHostHeaderPort(port);

  if (isIP(hostname) === 6) {
    throw createInvalidGatewayHostHeaderError();
  }

  if (isIP(hostname) === 4) {
    return;
  }

  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");

  if (
    normalizedHostname.length === 0 ||
    normalizedHostname.length > 253 ||
    !normalizedHostname.split(".").every((label) => GATEWAY_HOST_LABEL_PATTERN.test(label))
  ) {
    throw createInvalidGatewayHostHeaderError();
  }
}

function parseGatewayRequestUrl(request: IncomingMessage): URL {
  const requestTarget = request.url ?? "/";

  if (requestTarget.length === 0) {
    throw new RayError("Request URL must be non-empty", {
      code: "invalid_request",
      status: 400,
    });
  }

  if (requestTarget.length > MAX_GATEWAY_REQUEST_TARGET_CHARS) {
    throw new RayError(
      `Request URL must be at most ${MAX_GATEWAY_REQUEST_TARGET_CHARS} characters`,
      {
        code: "request_target_too_large",
        status: 414,
        details: {
          maxChars: MAX_GATEWAY_REQUEST_TARGET_CHARS,
          actualChars: requestTarget.length,
        },
      },
    );
  }

  const hostHeader = request.headers.host;
  assertGatewayHostHeader(hostHeader);

  try {
    return new URL(requestTarget, `http://${hostHeader ?? "127.0.0.1"}`);
  } catch (error) {
    throw new RayError("Request URL is invalid", {
      code: "invalid_request",
      status: 400,
      details: {
        message: toErrorMessage(error),
      },
    });
  }
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  const declaredContentLength = getDeclaredContentLength(request);

  if (declaredContentLength !== undefined && declaredContentLength > limitBytes) {
    throw new RayError("Request body too large", {
      code: "body_too_large",
      status: 413,
      details: {
        limitBytes,
        declaredContentLength,
      },
    });
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > limitBytes) {
      throw new RayError("Request body too large", {
        code: "body_too_large",
        status: 413,
      });
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (raw.length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RayError("Request body must be valid JSON", {
      code: "invalid_json",
      status: 400,
      details: error,
    });
  }
}

function buildRateLimitHeaders(decision: {
  limit: number;
  remaining: number;
  resetAt: number;
}): Record<string, string> {
  return {
    "x-ratelimit-limit": decision.limit.toString(),
    "x-ratelimit-remaining": decision.remaining.toString(),
    "x-ratelimit-reset": Math.ceil(decision.resetAt / 1_000).toString(),
  };
}

function authorizeProtectedRoute(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreateGatewayHandlerOptions,
  runtime: RayRuntime,
  isValidApiKey: (bearerToken: string | undefined) => boolean,
): string | undefined {
  const bearerToken = parseBearerToken(request.headers.authorization);

  if (!options.config.auth.enabled) {
    return undefined;
  }

  if (!isValidApiKey(bearerToken)) {
    runtime.metrics.recordAuthReject();
    const closeRequest = closeRequestAfterResponse(request, response);
    writeJson(
      response,
      401,
      {
        error: {
          code: "unauthorized",
          message: "A valid Bearer API key is required for this request",
        },
      },
      {
        "www-authenticate": 'Bearer realm="ray"',
        ...(closeRequest ? { connection: "close" } : {}),
      },
    );
    return undefined;
  }

  return bearerToken;
}

function enforceRateLimit(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreateGatewayHandlerOptions,
  runtime: RayRuntime,
  rateLimiter: FixedWindowRateLimiter | undefined,
  bearerToken: string | undefined,
): Record<string, string> | undefined {
  if (!options.config.rateLimit.enabled || !rateLimiter) {
    return undefined;
  }

  const decision = rateLimiter.take(
    buildRateLimitKey(
      options.config.rateLimit.keyStrategy,
      request,
      bearerToken,
      options.config.rateLimit.trustProxyHeaders,
    ),
  );
  const rateLimitHeaders = buildRateLimitHeaders(decision);

  if (!decision.allowed) {
    runtime.metrics.recordRateLimitReject();
    const closeRequest = closeRequestAfterResponse(request, response);
    writeJson(
      response,
      429,
      {
        error: {
          code: "rate_limited",
          message: "The inference rate limit has been exceeded",
        },
      },
      {
        ...rateLimitHeaders,
        "retry-after": Math.max(Math.ceil((decision.resetAt - Date.now()) / 1_000), 1).toString(),
        ...(closeRequest ? { connection: "close" } : {}),
      },
    );
    return undefined;
  }

  return rateLimitHeaders;
}

function serializeRequestError(error: RayError): Record<string, unknown> {
  const base = {
    code: error.code,
    status: error.status,
    message: error.message,
    name: error.name,
  };

  if (isExpectedRequestRejection(error)) {
    return base;
  }

  return {
    ...base,
    ...serializeError(error),
  };
}

function isExpectedRequestRejection(error: RayError): boolean {
  return error.status < 500 || expectedRequestRejectionCodes.has(error.code);
}

function shouldCloseRequestAfterReject(request: IncomingMessage, error: RayError): boolean {
  return (
    !request.complete &&
    (error.code === "body_too_large" ||
      error.code === "invalid_request" ||
      error.code === "request_target_too_large" ||
      error.code === "unsupported_media_type")
  );
}

function resolveRetryAfterSeconds(error: RayError): number | undefined {
  if (error.code === "queue_full" || error.code === "async_queue_full") {
    return QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS;
  }

  if (error.code === "async_queue_storage_low") {
    return STORAGE_BACKPRESSURE_RETRY_AFTER_SECONDS;
  }

  return undefined;
}

function buildRejectedRequestHeaders(
  error: RayError,
  closeRequest: boolean,
): Record<string, string> {
  const retryAfterSeconds = resolveRetryAfterSeconds(error);

  return {
    ...(retryAfterSeconds !== undefined ? { "retry-after": retryAfterSeconds.toString() } : {}),
    ...(closeRequest ? { connection: "close" } : {}),
  };
}

export function createGatewayRequestHandler(options: CreateGatewayHandlerOptions) {
  const config = snapshotRayConfig(options.config);
  const handlerOptions: CreateGatewayHandlerOptions = { ...options, config };
  const runtime = options.runtime ?? createRayRuntime(config);
  const logger =
    options.logger ?? new Logger(config.telemetry.serviceName, config.telemetry.logLevel);
  const jobQueue =
    options.jobQueue ??
    (config.asyncQueue.enabled
      ? new DurableInferenceQueue({
          config: config.asyncQueue,
          runtime,
          logger,
        })
      : undefined);
  const env = options.env ?? process.env;
  const apiKeys = resolveAuthApiKeys(config, env);
  const isValidApiKey = createApiKeyVerifier(apiKeys);
  const rateLimiter =
    options.rateLimiter ??
    (config.rateLimit.enabled ? new FixedWindowRateLimiter(config.rateLimit) : undefined);

  return async (request: IncomingMessage, response: ServerResponse) => {
    let url: URL | undefined;

    try {
      url = parseGatewayRequestUrl(request);

      if (request.method === "GET" && url.pathname === "/") {
        writeJsonWithoutReadingBody(request, response, 200, {
          name: "ray",
          description: "Shrink AI to run on cheap VPS infrastructure.",
          thesis: "A lean inference runtime for small-model hosting on self-hosted single nodes.",
          profile: config.profile,
          model: config.model.id,
          docs: {
            architecture: "/docs/architecture.md",
            roadmap: "/docs/roadmap.md",
            principles: "/docs/principles.md",
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/livez") {
        writeJsonWithoutReadingBody(request, response, 200, {
          status: "ok",
          service: "ray-gateway",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        const health = await runtime.health();
        if (jobQueue) {
          attachAsyncQueueHealth(health, await jobQueue.snapshotWithStorage());
        }
        writeJsonWithoutReadingBody(
          request,
          response,
          resolveReadyzStatusCode(health),
          buildReadyzResponse(health),
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        const health = await runtime.health();
        if (jobQueue) {
          attachAsyncQueueHealth(health, await jobQueue.snapshotWithStorage());
        }
        writeJsonWithoutReadingBody(
          request,
          response,
          health.status === "unavailable" ? 503 : 200,
          health,
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        const metrics = await runtime.collectMetricsSnapshot();
        const warmupSnapshot = handlerOptions.warmupSnapshot?.();
        if (warmupSnapshot) {
          attachGatewayWarmupMetrics(metrics, warmupSnapshot);
        }
        writeJsonWithoutReadingBody(
          request,
          response,
          200,
          jobQueue
            ? attachAsyncQueueMetrics(metrics, await jobQueue.snapshotWithStorage())
            : metrics,
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/config") {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        writeJsonWithoutReadingBody(request, response, 200, runtime.sanitizedConfig());
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/infer") {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        const rateLimitHeaders = enforceRateLimit(
          request,
          response,
          handlerOptions,
          runtime,
          rateLimiter,
          bearerToken,
        );
        if (config.rateLimit.enabled && rateLimitHeaders === undefined) {
          return;
        }

        assertJsonContentType(request);
        const body = (await readJsonBody(
          request,
          config.server.requestBodyLimitBytes,
        )) as InferenceRequest;
        const result = await runtime.infer(body);
        writeJson(response, 200, result, rateLimitHeaders);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs") {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        const rateLimitHeaders = enforceRateLimit(
          request,
          response,
          handlerOptions,
          runtime,
          rateLimiter,
          bearerToken,
        );
        if (config.rateLimit.enabled && rateLimitHeaders === undefined) {
          return;
        }

        if (!jobQueue) {
          writeJsonWithoutReadingBody(request, response, 503, {
            error: {
              code: "async_queue_disabled",
              message: "The async durable queue is disabled in the current config",
            },
          });
          return;
        }

        assertJsonContentType(request);
        const body = (await readJsonBody(
          request,
          config.server.requestBodyLimitBytes,
        )) as CreateInferenceJobRequest;
        const job = await jobQueue.enqueue(body);
        const accepted = jobQueue.toAcceptedResponse(job);
        writeJson(response, 202, accepted, {
          ...(rateLimitHeaders ?? {}),
          location: accepted.location,
        });
        return;
      }

      if (request.method === "GET" && /^\/v1\/jobs\/[^/]+$/.test(url.pathname)) {
        const bearerToken = authorizeProtectedRoute(
          request,
          response,
          handlerOptions,
          runtime,
          isValidApiKey,
        );
        if (config.auth.enabled && bearerToken === undefined) {
          return;
        }

        if (!jobQueue) {
          writeJsonWithoutReadingBody(request, response, 503, {
            error: {
              code: "async_queue_disabled",
              message: "The async durable queue is disabled in the current config",
            },
          });
          return;
        }

        const rateLimitHeaders = enforceRateLimit(
          request,
          response,
          handlerOptions,
          runtime,
          rateLimiter,
          bearerToken,
        );
        if (config.rateLimit.enabled && rateLimitHeaders === undefined) {
          return;
        }

        const jobId = url.pathname.slice("/v1/jobs/".length);
        const job = await jobQueue.get(jobId);

        if (!job) {
          writeJsonWithoutReadingBody(
            request,
            response,
            404,
            {
              error: {
                code: "job_not_found",
                message: "The requested async job was not found",
              },
            },
            rateLimitHeaders,
          );
          return;
        }

        writeJsonWithoutReadingBody(request, response, 200, job, rateLimitHeaders);
        return;
      }

      writeJsonWithoutReadingBody(request, response, 404, {
        error: {
          code: "not_found",
          message: "Route not found",
        },
      });
    } catch (error) {
      const normalized =
        error instanceof RayError
          ? error
          : new RayError(toErrorMessage(error), {
              code: "gateway_error",
              status: 500,
              details: error,
            });

      const logFields = {
        method: request.method,
        path: url?.pathname ?? "[invalid-url]",
        error: serializeRequestError(normalized),
      };

      if (isExpectedRequestRejection(normalized)) {
        logger.warn("request rejected", logFields);
      } else {
        logger.error("request failed", logFields);
      }

      const closeRequest = shouldCloseRequestAfterReject(request, normalized);
      if (closeRequest) {
        closeRequestAfterResponse(request, response);
      }

      writeJson(
        response,
        normalized.status,
        {
          error: {
            code: normalized.code,
            message: normalized.message,
            details: normalized.details,
          },
        },
        buildRejectedRequestHeaders(normalized, closeRequest),
      );
    }
  };
}

export function createGatewayServer(options: CreateGatewayHandlerOptions): GatewayServer {
  const config = snapshotRayConfig(options.config);
  const runtime = options.runtime ?? createRayRuntime(config);
  const logger =
    options.logger ?? new Logger(config.telemetry.serviceName, config.telemetry.logLevel);
  const jobQueue =
    options.jobQueue ??
    (config.asyncQueue.enabled
      ? new DurableInferenceQueue({
          config: config.asyncQueue,
          runtime,
          logger,
        })
      : undefined);
  let warmup: GatewayWarmupController | undefined;
  const handler = createGatewayRequestHandler({
    ...options,
    config,
    runtime,
    logger,
    ...(jobQueue ? { jobQueue } : {}),
    warmupSnapshot: () => warmup?.snapshot(),
  });
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  const activeRequestsBySocket = new Map<Socket, number>();
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = GATEWAY_MAX_REQUESTS_PER_SOCKET;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  server.on("request", (request, response) => {
    const socket = request.socket;
    activeRequestsBySocket.set(socket, (activeRequestsBySocket.get(socket) ?? 0) + 1);

    const releaseRequest = () => {
      response.off("finish", releaseRequest);
      response.off("close", releaseRequest);

      const next = (activeRequestsBySocket.get(socket) ?? 1) - 1;
      if (next <= 0) {
        activeRequestsBySocket.delete(socket);
        return;
      }

      activeRequestsBySocket.set(socket, next);
    };

    response.once("finish", releaseRequest);
    response.once("close", releaseRequest);
  });

  return {
    server,
    runtime,
    logger,
    get warmup() {
      return warmup;
    },
    set warmup(next: GatewayWarmupController | undefined) {
      warmup = next;
    },
    sockets,
    activeRequestsBySocket,
    ...(jobQueue ? { jobQueue } : {}),
  };
}

export async function startGateway(options: StartGatewayOptions): Promise<GatewayServer> {
  const config = snapshotRayConfig(options.config);
  const warmupRetry = resolveWarmupRetryOptions(options.warmupRetry);
  const gateway = createGatewayServer({
    ...options,
    config,
  });

  await gateway.jobQueue?.start();

  try {
    await listenGatewayServer(gateway.server, config.server.port, config.server.host);
  } catch (error) {
    await stopGatewayJobQueueAfterListenFailure(gateway, error);
    throw error;
  }

  gateway.logger.info("gateway listening", {
    host: config.server.host,
    port: config.server.port,
    profile: config.profile,
    model: config.model.id,
    configPath: options.configPath ?? "defaults",
  });

  gateway.warmup = startGatewayWarmup(gateway, warmupRetry);

  return gateway;
}

function startGatewayWarmup(
  gateway: GatewayServer,
  retry: Required<GatewayWarmupRetryOptions>,
): GatewayWarmupController {
  let stopped = false;
  let attempts = 0;
  let failures = 0;
  let inFlight = false;
  let retryInMs = 0;
  let succeeded = false;
  let retryTimer: NodeJS.Timeout | undefined;

  const run = () => {
    if (stopped) {
      return;
    }

    retryTimer = undefined;
    retryInMs = 0;
    attempts += 1;
    inFlight = true;

    void gateway.runtime
      .warm()
      .then(() => {
        inFlight = false;
        succeeded = true;
        if (!stopped && attempts > 1) {
          gateway.logger.info("provider warmup recovered", { attempts });
        }
      })
      .catch((error) => {
        inFlight = false;
        if (stopped) {
          return;
        }

        failures += 1;
        retryInMs = resolveWarmupRetryDelayMs(attempts, retry);
        const fields = {
          attempt: attempts,
          retryInMs,
          error: serializeError(error),
        };

        if (attempts === 1) {
          gateway.logger.error("provider warmup failed after gateway start", fields);
        } else {
          gateway.logger.warn("provider warmup retry failed", fields);
        }

        retryTimer = setTimeout(run, retryInMs);
        retryTimer.unref();
      });
  };

  run();

  return {
    stop() {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryInMs = 0;
    },
    snapshot() {
      return {
        attempts,
        failures,
        inFlight,
        retryScheduled: retryTimer !== undefined,
        retryInMs,
        succeeded,
        stopped,
      };
    },
  };
}

function listenGatewayServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function stopGatewayJobQueueAfterListenFailure(
  gateway: GatewayServer,
  listenError: unknown,
): Promise<void> {
  try {
    await gateway.jobQueue?.stop();
  } catch (error) {
    gateway.logger.error("gateway async queue cleanup failed after listen error", {
      listenError: serializeError(listenError),
      error: serializeError(error),
    });
  }
}

export async function stopGateway(
  gateway: GatewayServer,
  options: StopGatewayOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? GATEWAY_SHUTDOWN_TIMEOUT_MS;
  const signal = options.signal ?? "SIGTERM";
  let forceTimeout: NodeJS.Timeout | undefined;

  gateway.logger.info("gateway shutting down", { signal, timeoutMs });
  gateway.warmup?.stop();

  try {
    const closePromise = new Promise<void>((resolve, reject) => {
      gateway.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    gateway.server.closeIdleConnections();
    destroyIdleGatewaySockets(gateway);

    forceTimeout = setTimeout(() => {
      gateway.logger.warn("gateway shutdown timeout reached; closing active connections", {
        signal,
        timeoutMs,
      });
      gateway.server.closeAllConnections();
      destroyGatewaySockets(gateway.sockets);
    }, timeoutMs);
    forceTimeout.unref();

    await closePromise;
  } finally {
    if (forceTimeout) {
      clearTimeout(forceTimeout);
    }

    await gateway.jobQueue?.stop();
  }
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const { config, configPath } = await loadRayConfig({
    cwd: process.cwd(),
    ...(cli.configPath ? { configPath: cli.configPath } : {}),
  });

  const gateway = await startGateway({
    config,
    ...(configPath ? { configPath } : {}),
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      await stopGateway(gateway, { signal });
      process.exit(0);
    } catch (error) {
      gateway.logger.error("gateway shutdown failed", {
        signal,
        error: serializeError(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        message: "gateway boot failed",
        error: serializeError(error),
      }),
    );
    process.exit(1);
  });
}
