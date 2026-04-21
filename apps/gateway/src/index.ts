import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadRayConfig } from "@ray/config";
import { RayError, toErrorMessage, type InferenceRequest } from "@ray/core";
import { createRayRuntime } from "@ray/runtime";
import { Logger, serializeError } from "@ray/telemetry";

interface CliOptions {
  configPath?: string;
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

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
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

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const { config, configPath } = await loadRayConfig({
    cwd: process.cwd(),
    ...(cli.configPath ? { configPath: cli.configPath } : {}),
  });

  const runtime = createRayRuntime(config);
  const logger = new Logger(config.telemetry.serviceName, config.telemetry.logLevel);

  await runtime.warm();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        writeJson(response, 200, {
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

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, runtime.health());
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
        const body = (await readJsonBody(request, config.server.requestBodyLimitBytes)) as InferenceRequest;
        const result = await runtime.infer(body);
        writeJson(response, 200, result);
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
  });

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, config.server.host, resolve);
  });

  logger.info("gateway listening", {
    host: config.server.host,
    port: config.server.port,
    profile: config.profile,
    model: config.model.id,
    configPath: configPath ?? "defaults",
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("gateway shutting down", { signal });
    server.close((error) => {
      if (error) {
        logger.error("gateway shutdown failed", {
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
