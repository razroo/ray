import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import type { RayRuntime } from "@ray/runtime";
import { RayError, type HealthSnapshot } from "@razroo/ray-core";
import type { LogFields, Logger } from "@ray/telemetry";
import { createGatewayServer, parseCliArgs } from "./index.js";

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readRawUnfinishedRequestResponse(
  server: Server,
  requestLines: string[],
): Promise<string> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let raw = "";
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    socket.setTimeout(1_000, () => {
      socket.destroy(new Error("Timed out waiting for unfinished request socket to close"));
    });
    socket.on("connect", () => {
      socket.write(requestLines.join("\r\n"));
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", fail);
  });
}

test("gateway bounds HTTP server timeouts for small VPS sockets", () => {
  const gateway = createGatewayServer({
    config: createDefaultConfig("tiny"),
  });

  assert.equal(gateway.server.headersTimeout, 15_000);
  assert.equal(gateway.server.requestTimeout, 30_000);
  assert.equal(gateway.server.keepAliveTimeout, 5_000);
  assert.equal(gateway.server.maxRequestsPerSocket, 1_000);
});

test("gateway parseCliArgs accepts explicit config paths", () => {
  assert.deepEqual(parseCliArgs(["--config", "./examples/config/ray.sub1b.json"]), {
    configPath: "./examples/config/ray.sub1b.json",
  });
});

test("gateway parseCliArgs rejects ambiguous or malformed options", () => {
  assert.throws(() => parseCliArgs(["--config"]), /--config requires a value/);
  assert.throws(() => parseCliArgs(["--config", "--port"]), /--config requires a value/);
  assert.throws(
    () => parseCliArgs(["--confgi", "./examples/config/ray.sub1b.json"]),
    /Unknown option/,
  );
  assert.throws(() => parseCliArgs(["./examples/config/ray.sub1b.json"]), /Unexpected positional/);
  assert.throws(() => parseCliArgs(["--config", `ray${"\0"}.json`]), /NUL bytes/);
  assert.throws(() => parseCliArgs(["--config", "x".repeat(4_097)]), /--config must be at most/);
  assert.throws(() => parseCliArgs(["--config", 42] as unknown as string[]), /argv\[1\]/);
});

test("gateway closes unfinished request bodies on no-body routes", async (t) => {
  const gateway = createGatewayServer({
    config: createDefaultConfig("tiny"),
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await readRawUnfinishedRequestResponse(gateway.server, [
    "GET /livez HTTP/1.1",
    `Host: 127.0.0.1:${address.port}`,
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"status": "ok"/);
});

test("gateway closes unfinished request bodies on not-found routes", async (t) => {
  const gateway = createGatewayServer({
    config: createDefaultConfig("tiny"),
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await readRawUnfinishedRequestResponse(gateway.server, [
    "POST /missing HTTP/1.1",
    `Host: 127.0.0.1:${address.port}`,
    "Content-Type: application/json",
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 404 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "not_found"/);
});

test("gateway rejects oversized declared request bodies before reading bytes", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    server: {
      requestBodyLimitBytes: 16,
    },
  });
  const gateway = createGatewayServer({ config });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let raw = "";
    socket.setTimeout(1_000, () => {
      socket.destroy(new Error("Timed out waiting for early 413 response"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /v1/infer HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Content-Type: application/json",
          "Content-Length: 17",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 413 /);
  assert.match(response, /"code": "body_too_large"/);
});

test("gateway snapshots config at server construction", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    server: {
      requestBodyLimitBytes: 16,
    },
  });
  const gateway = createGatewayServer({ config });
  config.server.requestBodyLimitBytes = 1_000;

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const body = JSON.stringify({ input: "hello" });
  assert.ok(Buffer.byteLength(body) > 16);

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
  });

  assert.equal(response.status, 413);
  const payload = (await response.json()) as { error: { code: string } };
  assert.equal(payload.error.code, "body_too_large");
  assert.equal(gateway.runtime.config.server.requestBodyLimitBytes, 16);
});

test("gateway closes unfinished upload sockets after oversized request rejection", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    server: {
      requestBodyLimitBytes: 16,
    },
  });
  const gateway = createGatewayServer({ config });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let raw = "";
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
    };

    socket.setTimeout(1_000, () => {
      socket.destroy(new Error("Timed out waiting for oversized upload socket to close"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /v1/infer HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Content-Type: application/json",
          "Content-Length: 17",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 413 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "body_too_large"/);
});

test("gateway rejects inference requests without a valid API key when auth is enabled", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
  });
  const gateway = createGatewayServer({
    config,
    env: {
      RAY_API_KEYS: "secret-token",
    },
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: "hello",
    }),
  });

  assert.equal(response.status, 401);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "unauthorized");
});

test("gateway closes unfinished upload sockets after auth rejection", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
  });
  const gateway = createGatewayServer({
    config,
    env: {
      RAY_API_KEYS: "secret-token",
    },
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let raw = "";
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
    };

    socket.setTimeout(1_000, () => {
      socket.destroy(new Error("Timed out waiting for auth rejection socket to close"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /v1/infer HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Content-Type: application/json",
          "Content-Length: 32",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 401 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "unauthorized"/);
});

test("gateway protects detailed operational endpoints when auth is enabled", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
  });
  const gateway = createGatewayServer({
    config,
    env: {
      RAY_API_KEYS: "secret-token",
    },
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const livez = await fetch(`${baseUrl}/livez`);
  assert.equal(livez.status, 200);

  for (const pathname of ["/health", "/metrics", "/v1/config"]) {
    const rejected = await fetch(`${baseUrl}${pathname}`);
    assert.equal(rejected.status, 401);
  }

  const accepted = await fetch(`${baseUrl}/health`, {
    headers: {
      authorization: "Bearer secret-token",
    },
  });
  assert.equal(accepted.status, 200);
});

test("gateway returns service unavailable when detailed health is unavailable", async (t) => {
  const config = createDefaultConfig("tiny");
  const unavailableHealth: HealthSnapshot = {
    status: "unavailable",
    uptimeMs: 250,
    queueDepth: 0,
    inFlight: 0,
    cacheEntries: 0,
    profile: "tiny",
    modelId: "offline-model",
    provider: {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      details: {
        message: "backend offline",
      },
    },
  };
  const runtime = {
    async health() {
      return unavailableHealth;
    },
  } as unknown as RayRuntime;
  const gateway = createGatewayServer({
    config,
    runtime,
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const livez = await fetch(`${baseUrl}/livez`);
  assert.equal(livez.status, 200);

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as HealthSnapshot;
  assert.equal(body.status, "unavailable");
  assert.equal(body.provider.status, "unavailable");
});

test("gateway logs client request failures as warnings without stacks", async (t) => {
  const config = createDefaultConfig("tiny");
  const warnings: Array<{ message: string; fields: LogFields | undefined }> = [];
  const errors: Array<{ message: string; fields: LogFields | undefined }> = [];
  const logger = {
    debug() {},
    info() {},
    warn(message: string, fields?: LogFields) {
      warnings.push({ message, fields });
    },
    error(message: string, fields?: LogFields) {
      errors.push({ message, fields });
    },
  } as unknown as Logger;
  const gateway = createGatewayServer({
    config,
    logger,
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: "hello",
      cache: "false",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "request rejected");
  const error = warnings[0]?.fields?.error as { code?: string; status?: number; stack?: string };
  assert.equal(error.code, "invalid_request");
  assert.equal(error.status, 400);
  assert.equal(error.stack, undefined);
});

test("gateway serializes unusual health details without failing the response", async (t) => {
  const config = createDefaultConfig("tiny");
  const circular: Record<string, unknown> = {
    label: "health",
    count: 2n,
  };
  circular.self = circular;
  const runtime = {
    async health() {
      return {
        status: "ok",
        uptimeMs: 250,
        queueDepth: 0,
        inFlight: 0,
        cacheEntries: 0,
        profile: "tiny",
        modelId: "test-model",
        provider: {
          status: "ready",
          checkedAt: new Date().toISOString(),
          details: circular,
        },
      } satisfies HealthSnapshot;
    },
  } as unknown as RayRuntime;
  const gateway = createGatewayServer({
    config,
    runtime,
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as HealthSnapshot & {
    provider: { details: { count: string; self: string } };
  };
  assert.equal(body.provider.details.count, "2");
  assert.equal(body.provider.details.self, "[Circular]");
});

test("gateway serializes unusual error details without masking the original status", async (t) => {
  const config = createDefaultConfig("tiny");
  const circular: Record<string, unknown> = {
    count: 3n,
  };
  circular.self = circular;
  const runtime = {
    async infer() {
      throw new RayError("backend returned a weird diagnostic object", {
        code: "provider_weird_diagnostic",
        status: 502,
        details: circular,
      });
    },
  } as unknown as RayRuntime;
  const gateway = createGatewayServer({
    config,
    runtime,
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: "hello",
    }),
  });

  assert.equal(response.status, 502);
  const body = (await response.json()) as {
    error: {
      code: string;
      details: {
        count: string;
        self: string;
      };
    };
  };
  assert.equal(body.error.code, "provider_weird_diagnostic");
  assert.equal(body.error.details.count, "3");
  assert.equal(body.error.details.self, "[Circular]");
});

test("gateway rate limits repeated inference requests", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: "api-key",
      trustProxyHeaders: false,
    },
  });
  const gateway = createGatewayServer({
    config,
    env: {
      RAY_API_KEYS: "secret-token",
    },
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const url = `http://127.0.0.1:${address.port}/v1/infer`;
  const headers = {
    "content-type": "application/json",
    authorization: "Bearer secret-token",
  };

  const first = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: "first",
    }),
  });
  assert.equal(first.status, 200);

  const second = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: "second",
    }),
  });

  assert.equal(second.status, 429);
  assert.equal(second.headers.get("x-ratelimit-limit"), "1");
  const body = (await second.json()) as { error: { code: string } };
  assert.equal(body.error.code, "rate_limited");
});

test("gateway closes unfinished upload sockets after rate-limit rejection", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    rateLimit: {
      enabled: true,
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: "ip",
      trustProxyHeaders: false,
    },
  });
  const gateway = createGatewayServer({ config });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const url = `http://127.0.0.1:${address.port}/v1/infer`;
  const first = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: "first",
    }),
  });
  assert.equal(first.status, 200);

  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let raw = "";
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(raw);
      }
    };

    socket.setTimeout(1_000, () => {
      socket.destroy(new Error("Timed out waiting for rate-limit rejection socket to close"));
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /v1/infer HTTP/1.1",
          `Host: 127.0.0.1:${address.port}`,
          "Content-Type: application/json",
          "Content-Length: 32",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 429 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "rate_limited"/);
});

test("gateway does not rate limit by unverified bearer tokens when auth is disabled", async (t) => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: false,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: "api-key",
      trustProxyHeaders: false,
    },
  });
  const gateway = createGatewayServer({ config });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const url = `http://127.0.0.1:${address.port}/v1/infer`;

  const first = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer caller-selected-a",
    },
    body: JSON.stringify({
      input: "first",
    }),
  });
  assert.equal(first.status, 200);

  const second = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer caller-selected-b",
    },
    body: JSON.stringify({
      input: "second",
    }),
  });

  assert.equal(second.status, 429);
});

test("gateway rate limits async job status polling", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-gateway-status-rate-"));
  const config = mergeConfig(createDefaultConfig("tiny"), {
    asyncQueue: {
      enabled: true,
      storageDir,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: "ip",
      trustProxyHeaders: false,
    },
  });
  const gateway = createGatewayServer({ config });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await closeServer(gateway.server);
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const url = `http://127.0.0.1:${address.port}/v1/jobs/job_missing`;
  const first = await fetch(url);
  assert.equal(first.status, 404);
  assert.equal(first.headers.get("x-ratelimit-limit"), "1");

  const second = await fetch(url);
  assert.equal(second.status, 429);
  const body = (await second.json()) as { error: { code: string } };
  assert.equal(body.error.code, "rate_limited");
});

test("gateway accepts async inference jobs and exposes status retrieval", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-gateway-jobs-"));

  let callbackPayload: unknown;
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    callbackPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));

  const callbackAddress = callbackServer.address();
  if (!callbackAddress || typeof callbackAddress === "string") {
    throw new Error("Expected a TCP callback server address");
  }

  const config = mergeConfig(createDefaultConfig("tiny"), {
    asyncQueue: {
      enabled: true,
      storageDir,
      pollIntervalMs: 20,
      dispatchConcurrency: 1,
      maxAttempts: 2,
      callbackTimeoutMs: 500,
      maxCallbackAttempts: 2,
      callbackAllowedHosts: ["127.0.0.1"],
    },
    model: {
      adapter: {
        kind: "mock",
        latencyMs: 5,
      },
    },
  });
  const gateway = createGatewayServer({ config });
  await gateway.jobQueue?.start();

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await gateway.jobQueue?.stop();
    await closeServer(gateway.server);
    await closeServer(callbackServer);
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const createResponse = await fetch(`http://127.0.0.1:${address.port}/v1/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input: "hello async queue",
      callbackUrl: `http://127.0.0.1:${callbackAddress.port}/callback`,
    }),
  });

  assert.equal(createResponse.status, 202);
  const accepted = (await createResponse.json()) as {
    id: string;
    status: string;
    location: string;
  };
  assert.ok(accepted.status === "queued" || accepted.status === "running");
  assert.equal(createResponse.headers.get("location"), accepted.location);

  let completedJob:
    | {
        status: string;
        result?: {
          output: string;
        };
      }
    | undefined;

  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const jobResponse = await fetch(`http://127.0.0.1:${address.port}${accepted.location}`);
    assert.equal(jobResponse.status, 200);
    const job = (await jobResponse.json()) as {
      status: string;
      result?: {
        output: string;
      };
    };

    if (job.status === "succeeded") {
      completedJob = job;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(completedJob);
  assert.equal(completedJob.status, "succeeded");
  assert.match(completedJob.result?.output ?? "", /hello async queue/);

  const callbackStartedAt = Date.now();
  while (!callbackPayload && Date.now() - callbackStartedAt < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const callback = callbackPayload as {
    job?: {
      id: string;
      status: string;
      result?: {
        output: string;
      };
    };
  };
  assert.equal(callback.job?.id, accepted.id);
  assert.equal(callback.job?.status, "succeeded");
  assert.match(callback.job?.result?.output ?? "", /hello async queue/);
});
