import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createGatewayServer } from "./index.js";

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
