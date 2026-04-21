import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadRayConfig, resolveAuthApiKeys } from "@ray/config";
import { RayError, toErrorMessage, type InferenceRequest, type RayConfig } from "@ray/core";
import { RayRuntime, createRayRuntime } from "@ray/runtime";
import { Logger, serializeError } from "@ray/telemetry";
import { FixedWindowRateLimiter, buildRateLimitKey, parseBearerToken } from "./security.js";

interface CliOptions {
  configPath?: string;
}

export interface CreateGatewayHandlerOptions {
  config: RayConfig;
  runtime?: RayRuntime;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: FixedWindowRateLimiter;
}

export interface GatewayServer {
  server: Server;
  runtime: RayRuntime;
  logger: Logger;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--config" && typeof next === "string") {
      options.configPath = next;
      index += 1;
    }
  }

  return options;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    ...extraHeaders,
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
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

export function createGatewayRequestHandler(options: CreateGatewayHandlerOptions) {
  const runtime = options.runtime ?? createRayRuntime(options.config);
  const logger =
    options.logger ??
    new Logger(options.config.telemetry.serviceName, options.config.telemetry.logLevel);
  const env = options.env ?? process.env;
  const apiKeys = resolveAuthApiKeys(options.config, env);
  const rateLimiter =
    options.rateLimiter ??
    (options.config.rateLimit.enabled
      ? new FixedWindowRateLimiter(options.config.rateLimit)
      : undefined);

  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        writeJson(response, 200, {
          name: "ray",
          description: "Shrink AI to run on cheap VPS infrastructure.",
          thesis: "A lean inference runtime for small-model hosting on self-hosted single nodes.",
          profile: options.config.profile,
          model: options.config.model.id,
          docs: {
            architecture: "/docs/architecture.md",
            roadmap: "/docs/roadmap.md",
            principles: "/docs/principles.md",
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, await runtime.health());
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        writeJson(response, 200, runtime.metricsSnapshot());
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/config") {
        writeJson(response, 200, runtime.sanitizedConfig());
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/infer") {
        const bearerToken = parseBearerToken(request.headers.authorization);

        if (options.config.auth.enabled && (!bearerToken || !apiKeys.has(bearerToken))) {
          runtime.metrics.recordAuthReject();
          writeJson(
            response,
            401,
            {
              error: {
                code: "unauthorized",
                message: "A valid Bearer API key is required for inference requests",
              },
            },
            {
              "www-authenticate": 'Bearer realm="ray"',
            },
          );
          return;
        }

        let rateLimitHeaders: Record<string, string> | undefined;

        if (options.config.rateLimit.enabled && rateLimiter) {
          const decision = rateLimiter.take(
            buildRateLimitKey(
              options.config.rateLimit.keyStrategy,
              request,
              bearerToken,
              options.config.rateLimit.trustProxyHeaders,
            ),
          );
          rateLimitHeaders = buildRateLimitHeaders(decision);

          if (!decision.allowed) {
            runtime.metrics.recordRateLimitReject();
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
                "retry-after": Math.max(
                  Math.ceil((decision.resetAt - Date.now()) / 1_000),
                  1,
                ).toString(),
              },
            );
            return;
          }
        }

        const body = (await readJsonBody(
          request,
          options.config.server.requestBodyLimitBytes,
        )) as InferenceRequest;
        const result = await runtime.infer(body);
        writeJson(response, 200, result, rateLimitHeaders);
        return;
      }

      writeJson(response, 404, {
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

      logger.error("request failed", {
        method: request.method,
        path: url.pathname,
        error: serializeError(normalized),
      });

      writeJson(response, normalized.status, {
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        },
      });
    }
  };
}

export function createGatewayServer(options: CreateGatewayHandlerOptions): GatewayServer {
  const runtime = options.runtime ?? createRayRuntime(options.config);
  const logger =
    options.logger ??
    new Logger(options.config.telemetry.serviceName, options.config.telemetry.logLevel);
  const handler = createGatewayRequestHandler({
    ...options,
    runtime,
    logger,
  });

  return {
    server: createServer(handler),
    runtime,
    logger,
  };
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const { config, configPath } = await loadRayConfig({
    cwd: process.cwd(),
    ...(cli.configPath ? { configPath: cli.configPath } : {}),
  });

  const gateway = createGatewayServer({ config });

  await gateway.runtime.warm();

  await new Promise<void>((resolve) => {
    gateway.server.listen(config.server.port, config.server.host, resolve);
  });

  gateway.logger.info("gateway listening", {
    host: config.server.host,
    port: config.server.port,
    profile: config.profile,
    model: config.model.id,
    configPath: configPath ?? "defaults",
  });

  const shutdown = (signal: NodeJS.Signals) => {
    gateway.logger.info("gateway shutting down", { signal });
    gateway.server.close((error) => {
      if (error) {
        gateway.logger.error("gateway shutdown failed", {
          signal,
          error: serializeError(error),
        });
        process.exit(1);
      }

      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
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
