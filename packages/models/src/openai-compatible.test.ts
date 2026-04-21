import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ModelConfig, ProviderContext } from "@ray/core";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

function createModel(baseUrl: string, timeoutMs: number): ModelConfig {
  return {
    id: "test-model",
    family: "test",
    quantization: "q4_k_m",
    contextWindow: 4096,
    warmOnBoot: true,
    maxOutputTokens: 128,
    adapter: {
      kind: "openai-compatible",
      baseUrl,
      modelRef: "test-model-ref",
      timeoutMs,
    },
  };
}

function createContext(signal: AbortSignal): ProviderContext {
  return {
    signal,
    requestId: "req_test",
    config: {
      profile: "tiny",
      server: {
        host: "127.0.0.1",
        port: 3000,
        requestBodyLimitBytes: 32_000,
      },
      model: createModel("http://127.0.0.1", 500),
      scheduler: {
        concurrency: 1,
        maxQueue: 8,
        requestTimeoutMs: 500,
        dedupeInflight: true,
        batchWindowMs: 0,
      },
      cache: {
        enabled: true,
        maxEntries: 32,
        ttlMs: 1_000,
        keyStrategy: "input+params",
      },
      telemetry: {
        serviceName: "ray-gateway",
        logLevel: "info",
        includeDebugMetrics: true,
        slowRequestThresholdMs: 500,
      },
      gracefulDegradation: {
        enabled: true,
        queueDepthThreshold: 4,
        maxPromptChars: 2_000,
        degradeToMaxTokens: 64,
      },
      auth: {
        enabled: false,
        apiKeyEnv: "RAY_API_KEYS",
      },
      rateLimit: {
        enabled: false,
        windowMs: 60_000,
        maxRequests: 60,
        keyStrategy: "ip",
        trustProxyHeaders: false,
      },
      tags: {},
    },
    startedAt: Date.now(),
  };
}

test("openai-compatible provider reports readiness and token usage", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-model-ref" }] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const provider = new OpenAICompatibleProvider(
    createModel(`http://127.0.0.1:${address.port}`, 500),
    {
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      modelRef: "test-model-ref",
      timeoutMs: 500,
    },
  );

  const health = await provider.health();
  assert.equal(health.status, "ready");

  const result = await provider.infer(
    {
      input: "hi",
      maxTokens: 32,
      temperature: 0.2,
      topP: 0.9,
      cache: true,
      metadata: {},
    },
    createContext(new AbortController().signal),
  );

  assert.equal(result.output, "hello");
  assert.deepEqual(result.usage?.tokens, {
    prompt: 4,
    completion: 2,
    total: 6,
  });
});

test("openai-compatible provider applies adapter timeout", async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "late" } }],
        }),
      );
    }, 100);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const provider = new OpenAICompatibleProvider(
    createModel(`http://127.0.0.1:${address.port}`, 30),
    {
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      modelRef: "test-model-ref",
      timeoutMs: 30,
    },
  );

  await assert.rejects(
    () =>
      provider.infer(
        {
          input: "hi",
          maxTokens: 32,
          temperature: 0.2,
          topP: 0.9,
          cache: true,
          metadata: {},
        },
        createContext(new AbortController().signal),
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "provider_timeout"
      );
    },
  );
});
