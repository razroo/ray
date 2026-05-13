import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createRayRuntime, type RayRuntime } from "@ray/runtime";
import { RayError, type HealthSnapshot, type RuntimeMetricsSnapshot } from "@razroo/ray-core";
import { Logger, type LogFields } from "@ray/telemetry";
import { DurableInferenceQueue } from "./async-jobs.js";
import { createGatewayServer, parseCliArgs, startGateway, stopGateway } from "./index.js";

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

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  const { port } = address;
  await closeServer(server);
  return port;
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

test("stopGateway force-closes active request sockets before systemd timeout", async (t) => {
  const warnings: Array<{ message: string; fields: LogFields | undefined }> = [];
  let requestStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const server = createServer(() => {
    requestStarted?.();
  });
  const sockets = new Set<ReturnType<typeof createConnection>>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const logger = {
    debug() {},
    info() {},
    warn(message: string, fields?: LogFields) {
      warnings.push({ message, fields });
    },
    error() {},
  } as unknown as Logger;
  const gateway = {
    server,
    runtime: {} as RayRuntime,
    logger,
    sockets,
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close(() => undefined);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const socket = createConnection(address.port, "127.0.0.1");
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await started;

  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  await stopGateway(gateway, { signal: "SIGTERM", timeoutMs: 20 });
  await closed;

  assert.equal(
    warnings[0]?.message,
    "gateway shutdown timeout reached; closing active connections",
  );
  assert.equal(warnings[0]?.fields?.signal, "SIGTERM");
  assert.equal(warnings[0]?.fields?.timeoutMs, 20);
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

test("gateway rejects malformed request targets without leaking sockets", async (t) => {
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
    "GET http://[::1 HTTP/1.1",
    `Host: 127.0.0.1:${address.port}`,
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "invalid_request"/);
});

test("gateway rejects malformed Host headers without leaking sockets", async (t) => {
  const gateway = createGatewayServer({
    config: createDefaultConfig("tiny"),
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const response = await readRawUnfinishedRequestResponse(gateway.server, [
    "GET /livez HTTP/1.1",
    "Host: http://example.com",
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "invalid_request"/);
});

test("gateway accepts bracketed IPv6 Host headers", async (t) => {
  const gateway = createGatewayServer({
    config: createDefaultConfig("tiny"),
  });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.server.close());

  const response = await readRawUnfinishedRequestResponse(gateway.server, [
    "GET /livez HTTP/1.1",
    "Host: [::1]:3000",
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"status": "ok"/);
});

test("gateway rejects oversized request targets before route matching", async (t) => {
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
    `GET /${"x".repeat(8_193)} HTTP/1.1`,
    `Host: 127.0.0.1:${address.port}`,
    "Content-Length: 32",
    "",
    "",
  ]);

  assert.match(response, /^HTTP\/1\.1 414 /);
  assert.match(response, /\r\nconnection: close\r\n/i);
  assert.match(response, /"code": "request_target_too_large"/);
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
  const readyz = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyz.status, 200);

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

test("gateway metrics endpoint refreshes live runtime gauges", async (t) => {
  const config = createDefaultConfig("tiny");
  const runtime = createRayRuntime(config, {
    memoryUsage: () => ({
      rss: 32 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
    cgroupMemory: () => ({
      currentMiB: 640,
      highMiB: 800,
      limitMiB: 1_000,
      pressureRatio: 0.8,
      highEvents: 1,
      maxEvents: 0,
      oomEvents: 0,
      oomKillEvents: 0,
    }),
    cgroupCpu: () => ({
      usageUsec: 3_000_000,
      userUsec: 2_000_000,
      systemUsec: 1_000_000,
      quotaUsec: 50_000,
      periodUsec: 100_000,
      quotaCores: 0.5,
      periods: 300,
      throttledPeriods: 15,
      throttledUsec: 50_000,
      throttledRatio: 0.05,
    }),
  });
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

  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as RuntimeMetricsSnapshot;

  assert.equal(body.gauges["queue.depth"], 0);
  assert.equal(body.gauges["queue.max_depth"], config.scheduler.maxQueue);
  assert.equal(body.gauges["queue.depth_ratio"], 0);
  assert.equal(body.gauges["queue.max_tokens"], config.scheduler.maxQueuedTokens);
  assert.equal(body.gauges["preparation.active"], 0);
  assert.equal(body.gauges["preparation.queued"], 0);
  assert.equal(body.gauges["inference.concurrency"], config.scheduler.concurrency);
  assert.equal(body.gauges["inference.in_flight_ratio"], 0);
  assert.equal(body.gauges["cache.entries"], 0);
  assert.equal(body.gauges["cache.max_entries"], config.cache.maxEntries);
  assert.equal(body.gauges["cache.entries_ratio"], 0);
  assert.equal(body.gauges["cache.bytes"], 0);
  assert.equal(body.gauges["cache.max_bytes"], config.cache.maxBytes);
  assert.equal(body.gauges["cache.bytes_ratio"], 0);
  assert.equal(body.gauges["process.memory.rss_pressure_ratio"], 0.125);
  assert.equal(body.gauges["process.memory.cgroup_current_mib"], 640);
  assert.equal(body.gauges["process.memory.cgroup_high_mib"], 800);
  assert.equal(body.gauges["process.memory.cgroup_limit_mib"], 1_000);
  assert.equal(body.gauges["process.memory.cgroup_pressure_ratio"], 0.8);
  assert.equal(body.gauges["process.memory.cgroup_high_events"], 1);
  assert.equal(body.gauges["process.cpu.cgroup_usage_usec"], 3_000_000);
  assert.equal(body.gauges["process.cpu.cgroup_quota_usec"], 50_000);
  assert.equal(body.gauges["process.cpu.cgroup_period_usec"], 100_000);
  assert.equal(body.gauges["process.cpu.cgroup_quota_cores"], 0.5);
  assert.equal(body.gauges["process.cpu.cgroup_throttled_periods"], 15);
  assert.equal(body.gauges["process.cpu.cgroup_throttled_usec"], 50_000);
  assert.equal(body.gauges["process.cpu.cgroup_throttled_ratio"], 0.05);
  assert.equal(body.gauges["process.cpu.cgroup_throttled_threshold"], 0.2);
  assert.equal(body.gauges["process.cpu.pressure"], 0);
});

test("gateway metrics endpoint exposes async queue saturation", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-gateway-metrics-queue-"));
  const config = mergeConfig(createDefaultConfig("tiny"), {
    asyncQueue: {
      enabled: true,
      storageDir,
      maxJobs: 3,
      dispatchConcurrency: 2,
      minFreeStorageMiB: 64,
    },
  });
  const runtime = createRayRuntime(config);
  const logger = new Logger("test", "error");
  const jobQueue = new DurableInferenceQueue({
    config: config.asyncQueue,
    runtime,
    logger,
    statfsImpl: async () => ({
      bavail: 256,
      bsize: 1024 * 1024,
    }),
  });
  const gateway = createGatewayServer({ config, runtime, jobQueue, logger });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await closeServer(gateway.server);
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as RuntimeMetricsSnapshot;

  assert.equal(body.gauges["async_queue.enabled"], 1);
  assert.equal(body.gauges["async_queue.degraded"], 0);
  assert.equal(body.gauges["async_queue.queued"], 0);
  assert.equal(body.gauges["async_queue.running"], 0);
  assert.equal(body.gauges["async_queue.callback_pending"], 0);
  assert.equal(body.gauges["async_queue.total_jobs"], 0);
  assert.equal(body.gauges["async_queue.max_jobs"], 3);
  assert.equal(body.gauges["async_queue.jobs_ratio"], 0);
  assert.equal(body.gauges["async_queue.available_storage_mib"], 256);
  assert.equal(body.gauges["async_queue.min_free_storage_mib"], 64);
  assert.equal(body.gauges["async_queue.storage_reserve_ratio"], 4);
  assert.equal(body.gauges["async_queue.storage_low"], 0);
  assert.equal(body.gauges["async_queue.completed_ttl_ms"], config.asyncQueue.completedTtlMs);
  assert.equal(body.gauges["async_queue.dispatch_concurrency"], 2);

  const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(healthResponse.status, 200);
  const health = (await healthResponse.json()) as HealthSnapshot;
  assert.equal(health.status, "ok");
  assert.equal(health.asyncQueue?.degraded, false);
  assert.equal(health.asyncQueue?.availableStorageMiB, 256);
  assert.equal(health.asyncQueue?.storageReserveRatio, 4);
  assert.equal(health.asyncQueue?.storageLow, false);
});

test("gateway detailed health degrades when async queue storage is low", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-gateway-health-queue-storage-"));
  const config = mergeConfig(createDefaultConfig("tiny"), {
    asyncQueue: {
      enabled: true,
      storageDir,
      minFreeStorageMiB: 128,
    },
  });
  const runtime = createRayRuntime(config);
  const logger = new Logger("test", "error");
  const jobQueue = new DurableInferenceQueue({
    config: config.asyncQueue,
    runtime,
    logger,
    statfsImpl: async () => ({
      bavail: 64,
      bsize: 1024 * 1024,
    }),
  });
  const gateway = createGatewayServer({ config, runtime, jobQueue, logger });

  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await closeServer(gateway.server);
    await rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const health = (await response.json()) as HealthSnapshot;

  assert.equal(health.status, "degraded");
  assert.equal(health.asyncQueue?.degraded, true);
  assert.equal(health.asyncQueue?.availableStorageMiB, 64);
  assert.equal(health.asyncQueue?.minFreeStorageMiB, 128);
  assert.equal(health.asyncQueue?.storageReserveRatio, 0.5);
  assert.equal(health.asyncQueue?.storageLow, true);

  const readyzResponse = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(readyzResponse.status, 200);
  const readyz = (await readyzResponse.json()) as { status: string; asyncQueue?: unknown };
  assert.equal(readyz.status, "degraded");
  assert.equal(readyz.asyncQueue, undefined);
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

  const readyz = await fetch(`${baseUrl}/readyz`);
  assert.equal(readyz.status, 503);
  const readyzBody = (await readyz.json()) as { status: string; provider?: unknown };
  assert.equal(readyzBody.status, "unavailable");
  assert.equal(readyzBody.provider, undefined);

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as HealthSnapshot;
  assert.equal(body.status, "unavailable");
  assert.equal(body.provider.status, "unavailable");
});

test("startGateway exposes liveness while provider warmup fails in the background", async (t) => {
  const port = await getAvailablePort();
  const config = mergeConfig(createDefaultConfig("tiny"), {
    server: {
      port,
    },
  });
  const errors: Array<{ message: string; fields: LogFields | undefined }> = [];
  let warmCalled = false;
  const runtime = {
    async warm() {
      warmCalled = true;
      throw new Error("backend still booting");
    },
    async health() {
      return {
        status: "unavailable",
        uptimeMs: 0,
        queueDepth: 0,
        inFlight: 0,
        cacheEntries: 0,
        profile: "tiny",
        modelId: "warming-model",
        provider: {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
        },
      } satisfies HealthSnapshot;
    },
  } as unknown as RayRuntime;
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error(message: string, fields?: LogFields) {
      errors.push({ message, fields });
    },
  } as unknown as Logger;

  const gateway = await startGateway({
    config,
    runtime,
    logger,
  });
  t.after(() => gateway.server.close());

  const address = gateway.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const livez = await fetch(`http://127.0.0.1:${address.port}/livez`);
  assert.equal(livez.status, 200);

  const readyz = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(readyz.status, 503);
  assert.equal(warmCalled, true);

  for (let index = 0; index < 10 && errors.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(errors[0]?.message, "provider warmup failed after gateway start");
  assert.match(
    String((errors[0]?.fields?.error as { message?: string } | undefined)?.message),
    /backend still booting/,
  );
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
  const longKey = `k${"x".repeat(140)}`;
  circular[longKey] = "bounded-key";
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
    provider: { details: { count: string; self: string; [key: string]: unknown } };
  };
  assert.equal(body.provider.details.count, "2");
  assert.equal(body.provider.details.self, "[Circular]");
  assert.equal(body.provider.details[`k${"x".repeat(104)}...[truncated 36 chars]`], "bounded-key");
  assert.ok(Object.keys(body.provider.details).every((key) => key.length <= 128));
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
