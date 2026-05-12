import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadRayConfig, resolveAuthApiKeys, snapshotRayConfig } from "@ray/config";
import {
  RayError,
  toErrorMessage,
  type AsyncQueueSnapshot,
  type CreateInferenceJobRequest,
  type InferenceRequest,
  type RayConfig,
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
const GATEWAY_HEADERS_TIMEOUT_MS = 15_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const GATEWAY_MAX_REQUESTS_PER_SOCKET = 1_000;
const MAX_RESPONSE_FIELD_DEPTH = 10;
const MAX_RESPONSE_OBJECT_KEYS = 256;
const MAX_RESPONSE_ARRAY_ITEMS = 512;
const MAX_RESPONSE_STRING_CHARS = 65_536;

export interface CreateGatewayHandlerOptions {
  config: RayConfig;
  runtime?: RayRuntime;
  jobQueue?: DurableInferenceQueue;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: FixedWindowRateLimiter;
}

export interface GatewayServer {
  server: Server;
  runtime: RayRuntime;
  jobQueue?: DurableInferenceQueue;
  logger: Logger;
}

export interface StartGatewayOptions extends CreateGatewayHandlerOptions {
  configPath?: string;
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
  metrics.gauges["async_queue.queued"] = snapshot.queued;
  metrics.gauges["async_queue.running"] = snapshot.running;
  metrics.gauges["async_queue.callback_pending"] = snapshot.callbackPending;
  metrics.gauges["async_queue.total_jobs"] = snapshot.totalJobs;
  metrics.gauges["async_queue.max_jobs"] = snapshot.maxJobs;
  metrics.gauges["async_queue.jobs_ratio"] = snapshot.totalJobs / Math.max(1, snapshot.maxJobs);
  if (snapshot.availableStorageMiB !== undefined) {
    metrics.gauges["async_queue.available_storage_mib"] = snapshot.availableStorageMiB;
  }
  metrics.gauges["async_queue.min_free_storage_mib"] = snapshot.minFreeStorageMiB;
  if (snapshot.storageReserveRatio !== undefined) {
    metrics.gauges["async_queue.storage_reserve_ratio"] = snapshot.storageReserveRatio;
  }
  metrics.gauges["async_queue.completed_ttl_ms"] = snapshot.completedTtlMs;
  metrics.gauges["async_queue.dispatch_concurrency"] = snapshot.dispatchConcurrency;

  return metrics;
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

function truncateResponseString(value: string): string {
  if (value.length <= MAX_RESPONSE_STRING_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RESPONSE_STRING_CHARS)}...[truncated ${value.length - MAX_RESPONSE_STRING_CHARS} chars]`;
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
      try {
        output[key] = sanitizeJsonResponseValue(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[key] = `[Thrown: ${truncateResponseString(toErrorMessage(error))}]`;
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

  if (error.status < 500) {
    return base;
  }

  return {
    ...base,
    ...serializeError(error),
  };
}

function shouldCloseRequestAfterReject(request: IncomingMessage, error: RayError): boolean {
  return error.code === "body_too_large" && !request.complete;
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
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
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
        writeJsonWithoutReadingBody(
          request,
          response,
          health.status === "unavailable" ? 503 : 200,
          {
            status: health.status,
            service: "ray-gateway",
          },
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
          health.asyncQueue = await jobQueue.snapshotWithStorage();
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
        path: url.pathname,
        error: serializeRequestError(normalized),
      };

      if (normalized.status >= 500) {
        logger.error("request failed", logFields);
      } else {
        logger.warn("request rejected", logFields);
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
        closeRequest ? { connection: "close" } : {},
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
  const handler = createGatewayRequestHandler({
    ...options,
    config,
    runtime,
    logger,
    ...(jobQueue ? { jobQueue } : {}),
  });
  const server = createServer(handler);
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = GATEWAY_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = GATEWAY_MAX_REQUESTS_PER_SOCKET;

  return {
    server,
    runtime,
    logger,
    ...(jobQueue ? { jobQueue } : {}),
  };
}

export async function startGateway(options: StartGatewayOptions): Promise<GatewayServer> {
  const config = snapshotRayConfig(options.config);
  const gateway = createGatewayServer({
    ...options,
    config,
  });

  await gateway.jobQueue?.start();

  await new Promise<void>((resolve) => {
    gateway.server.listen(config.server.port, config.server.host, resolve);
  });

  gateway.logger.info("gateway listening", {
    host: config.server.host,
    port: config.server.port,
    profile: config.profile,
    model: config.model.id,
    configPath: options.configPath ?? "defaults",
  });

  void gateway.runtime.warm().catch((error) => {
    gateway.logger.error("provider warmup failed after gateway start", {
      error: serializeError(error),
    });
  });

  return gateway;
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
    gateway.logger.info("gateway shutting down", { signal });
    try {
      await new Promise<void>((resolve, reject) => {
        gateway.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await gateway.jobQueue?.stop();
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
