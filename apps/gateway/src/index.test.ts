import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createGatewayServer } from "./index.js";

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
