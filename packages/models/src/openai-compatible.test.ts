import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type {
  ModelConfig,
  OpenAICompatibleProviderConfig,
  ProviderContext,
} from "@razroo/ray-core";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";

function createModel(
  baseUrl: string,
  timeoutMs: number,
  adapterOverride?: Partial<OpenAICompatibleProviderConfig>,
): ModelConfig {
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
      ...(adapterOverride ?? {}),
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
        maxQueuedTokens: 128,
        maxInflightTokens: 64,
        requestTimeoutMs: 500,
        dedupeInflight: true,
        batchWindowMs: 0,
        affinityLookahead: 8,
      },
      asyncQueue: {
        enabled: false,
        storageDir: "/tmp/ray-test-async-queue",
        pollIntervalMs: 50,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
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
      promptCompiler: {
        enabled: true,
        collapseWhitespace: true,
        dedupeRepeatedLines: true,
        familyMetadataKeys: ["promptFamily", "taskTemplate"],
      },
      adaptiveTuning: {
        enabled: false,
        sampleSize: 8,
        queueLatencyThresholdMs: 250,
        minCompletionTokensPerSecond: 16,
        maxOutputReductionRatio: 0.5,
        minOutputTokens: 32,
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

test("openai-compatible provider forwards warmup requests and per-request seed", async (t) => {
  const completionBodies: Array<Record<string, unknown>> = [];

  const server = createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      completionBodies.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
        }),
      );
      return;
    }

    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-model-ref" }] }));
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
    createModel(`http://127.0.0.1:${address.port}`, 500, {
      warmupRequests: [
        {
          system: "Warm the email-body prefix cache.",
          input: "Draft a concise follow-up email body.",
          maxTokens: 2,
          seed: 7,
          stop: ["\n\n"],
          responseFormat: { type: "text" },
        },
      ],
    }),
    {
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      modelRef: "test-model-ref",
      timeoutMs: 500,
      warmupRequests: [
        {
          system: "Warm the email-body prefix cache.",
          input: "Draft a concise follow-up email body.",
          maxTokens: 2,
          seed: 7,
          stop: ["\n\n"],
          responseFormat: { type: "text" },
        },
      ],
    },
  );

  await provider.warm();
  await provider.infer(
    {
      input: "hi",
      system: "You are a short-form email writer.",
      maxTokens: 32,
      temperature: 0.2,
      topP: 0.9,
      seed: 42,
      stop: ["END"],
      responseFormat: { type: "json_object" },
      cache: true,
      metadata: {},
    },
    createContext(new AbortController().signal),
  );

  assert.equal(completionBodies.length, 2);
  const warmupBody = completionBodies[0];
  const inferBody = completionBodies[1];

  assert.ok(warmupBody);
  assert.ok(inferBody);
  assert.equal(warmupBody.seed, 7);
  assert.equal(warmupBody.max_tokens, 2);
  assert.deepEqual(warmupBody.stop, ["\n\n"]);
  assert.deepEqual(warmupBody.response_format, { type: "text" });
  assert.equal(warmupBody.user, "ray_warmup");
  assert.deepEqual(inferBody.messages, [
    { role: "system", content: "You are a short-form email writer." },
    { role: "user", content: "hi" },
  ]);
  assert.equal(inferBody.seed, 42);
  assert.deepEqual(inferBody.stop, ["END"]);
  assert.deepEqual(inferBody.response_format, { type: "json_object" });
  assert.equal(inferBody.user, "req_test");
});

test("openai-compatible provider reports modelRef mismatch as unavailable", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "different-model-ref" }] }));
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
  assert.equal(health.status, "unavailable");
  assert.deepEqual(health.details, {
    probe: "/v1/models",
    message: 'Configured modelRef "test-model-ref" is not exposed by the backend',
    availableModels: ["different-model-ref"],
  });
});
