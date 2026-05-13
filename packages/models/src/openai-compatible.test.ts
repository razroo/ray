import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type {
  ModelConfig,
  OpenAICompatibleProviderConfig,
  ProviderContext,
} from "@razroo/ray-core";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import {
  BACKEND_ERROR_BODY_LIMIT_BYTES,
  BACKEND_REQUEST_BODY_LIMIT_BYTES,
  BACKEND_RESPONSE_BODY_LIMIT_BYTES,
  adapterRequest,
  buildAdapterHeaders,
  extractAssistantText,
} from "./providers/http.js";

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
        shortJobMaxTokens: 96,
      },
      asyncQueue: {
        enabled: false,
        storageDir: "/tmp/ray-test-async-queue",
        maxJobs: 1_000,
        minFreeStorageMiB: 128,
        completedTtlMs: 86_400_000,
        pollIntervalMs: 50,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
        callbackAllowPrivateNetwork: false,
        callbackAllowedHosts: [],
      },
      cache: {
        enabled: true,
        maxEntries: 32,
        maxBytes: 64 * 1024,
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
        memoryRssThresholdMiB: 512,
        cpuThrottledRatioThreshold: 0.2,
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
        learnedFamilyCapEnabled: true,
        familyHistorySize: 16,
        learnedCapMinSamples: 4,
        draftPercentile: 0.95,
        shortPercentile: 0.9,
        learnedCapHeadroomTokens: 16,
      },
      auth: {
        enabled: false,
        apiKeyEnv: "RAY_API_KEYS",
      },
      rateLimit: {
        enabled: false,
        windowMs: 60_000,
        maxRequests: 60,
        maxKeys: 64,
        keyStrategy: "ip",
        trustProxyHeaders: false,
      },
      tags: {},
    },
    startedAt: Date.now(),
  };
}

test("adapterRequest rejects invalid direct adapter config before dispatch", async () => {
  await assert.rejects(
    () => adapterRequest(null as never, "/health", {}, 500),
    /adapter must be an object/,
  );
  await assert.rejects(
    () => adapterRequest({ baseUrl: "file:///tmp/model.sock", timeoutMs: 500 }, "/health", {}),
    /adapter\.baseUrl/,
  );
  await assert.rejects(
    () => adapterRequest({ baseUrl: "http://127.0.0.1:8080", timeoutMs: Infinity }, "/health", {}),
    /adapter\.timeoutMs/,
  );
  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          apiKeyEnv: "RAY UPSTREAM KEY",
        },
        "/health",
        {},
      ),
    /adapter\.apiKeyEnv must be a valid environment variable name/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          apiKeyEnv: "__proto__",
        },
        "/health",
        {},
      ),
    /adapter\.apiKeyEnv must be a valid environment variable name/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: { "x-bad": 1 as unknown as string },
        },
        "/health",
        {},
      ),
    /adapter\.headers/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: { "x bad": "value" },
        },
        "/health",
        {},
      ),
    /adapter\.headers names must be valid bounded HTTP token strings/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: { "Content-Length": "10" },
        },
        "/health",
        {},
      ),
    /adapter\.headers\.Content-Length must not use a transport-controlled header name/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: { "x-test": "good\r\nbad" },
        },
        "/health",
        {},
      ),
    /adapter\.headers\.x-test must not contain NUL, CR, or LF characters/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
        },
        "/health",
        {},
      ),
    /adapter\.headers must not contain unsafe key "__proto__"/,
  );

  const headers = {};
  Object.defineProperty(headers, "x-ray-test", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          headers: headers as Record<string, string>,
        },
        "/health",
        {},
      ),
    /adapter\.headers must not contain unreadable properties/,
  );

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
        },
        "v1/models",
        {},
      ),
    /adapter\.pathname/,
  );
  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
        },
        "//metadata",
        {},
      ),
    /adapter\.pathname/,
  );
  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
        },
        `/${"x".repeat(2_048)}`,
        {},
      ),
    /adapter\.pathname must be at most 2048 characters/,
  );
});

test("buildAdapterHeaders forwards bounded apiKeyEnv values", () => {
  const envName = "RAY_TEST_UPSTREAM_API_KEY";
  const original = process.env[envName];

  try {
    process.env[envName] = "upstream-token_123";

    assert.deepEqual(
      buildAdapterHeaders({
        baseUrl: "http://127.0.0.1:8080",
        timeoutMs: 500,
        apiKeyEnv: envName,
        headers: { "x-ray-test": "static" },
      }),
      {
        "content-type": "application/json",
        "x-ray-test": "static",
        authorization: "Bearer upstream-token_123",
      },
    );
  } finally {
    if (original === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = original;
    }
  }
});

test("buildAdapterHeaders rejects unsafe apiKeyEnv values before dispatch", () => {
  const envName = "RAY_TEST_UPSTREAM_API_KEY";
  const original = process.env[envName];

  try {
    process.env[envName] = "bad\nkey";

    assert.throws(
      () =>
        buildAdapterHeaders({
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          apiKeyEnv: envName,
        }),
      /RAY_TEST_UPSTREAM_API_KEY must be a bounded bearer token string without whitespace/,
    );

    process.env[envName] = "";

    assert.throws(
      () =>
        buildAdapterHeaders({
          baseUrl: "http://127.0.0.1:8080",
          timeoutMs: 500,
          apiKeyEnv: envName,
        }),
      /RAY_TEST_UPSTREAM_API_KEY must be a bounded bearer token string without whitespace/,
    );
  } finally {
    if (original === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = original;
    }
  }
});

test("adapterRequest rejects oversized request bodies before dispatch", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
        },
        "/v1/chat/completions",
        {
          method: "POST",
          body: "x".repeat(BACKEND_REQUEST_BODY_LIMIT_BYTES + 1),
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_request_too_large");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal(
        (details as { limitBytes?: unknown }).limitBytes,
        BACKEND_REQUEST_BODY_LIMIT_BYTES,
      );
      assert.equal(
        (details as { bodyBytes?: unknown }).bodyBytes,
        BACKEND_REQUEST_BODY_LIMIT_BYTES + 1,
      );

      return true;
    },
  );
  assert.equal(requests, 0);
});

test("adapterRequest rejects unknown-size request bodies before dispatch", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
        },
        "/v1/chat/completions",
        {
          method: "POST",
          body,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_request_body_unbounded");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal((details as { bodyType?: unknown }).bodyType, "ReadableStream");
      assert.equal(
        (details as { limitBytes?: unknown }).limitBytes,
        BACKEND_REQUEST_BODY_LIMIT_BYTES,
      );

      return true;
    },
  );
  assert.equal(requests, 0);
});

test("extractAssistantText tolerates malformed OpenAI content parts", () => {
  const text = extractAssistantText({
    choices: [
      {
        message: {
          content: [
            null as never,
            { type: "output_text" },
            { type: "output_text", text: " hello" },
            { type: "output_text", text: " world " },
          ],
        },
      },
    ],
  });

  assert.equal(text, "hello world");
});

test("extractAssistantText rejects excessive OpenAI content parts", () => {
  assert.throws(
    () =>
      extractAssistantText({
        choices: [
          {
            message: {
              content: Array.from({ length: 513 }, () => ({ text: "x" })),
            },
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_invalid_response");
      assert.equal((error as { status?: number }).status, 502);
      return true;
    },
  );
});

test("openai-compatible provider rejects invalid direct adapter payload config", () => {
  const model = createModel("http://127.0.0.1:8080", 500);
  const adapter = model.adapter as OpenAICompatibleProviderConfig;

  assert.throws(
    () =>
      new OpenAICompatibleProvider(model, {
        ...adapter,
        modelRef: "",
      }),
    /adapter\.modelRef/,
  );
  assert.throws(
    () =>
      new OpenAICompatibleProvider(model, {
        ...adapter,
        warmupRequests: Array.from({ length: 9 }, () => ({ input: "ping" })),
      }),
    /adapter\.warmupRequests/,
  );
  assert.throws(
    () =>
      new OpenAICompatibleProvider(model, {
        ...adapter,
        warmupRequests: [{ input: "ping", maxTokens: 129 }],
      }),
    /adapter\.warmupRequests\[0\]\.maxTokens/,
  );
  assert.throws(
    () =>
      new OpenAICompatibleProvider(model, {
        ...adapter,
        warmupRequests: [JSON.parse('{"__proto__":"polluted","input":"ping"}')],
      }),
    /adapter\.warmupRequests\[0\] must not contain unsafe key "__proto__"/,
  );
  assert.throws(
    () =>
      new OpenAICompatibleProvider(model, {
        ...adapter,
        warmupRequests: [
          {
            templateId: "email.reply_classification.v1",
            templateVariables: JSON.parse('{"replyText":"ok","prototype":"polluted"}'),
          },
        ],
      }),
    /adapter\.warmupRequests\[0\]\.templateVariables must not contain unsafe key "prototype"/,
  );
});

test("adapterRequest caps upstream error response bodies", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("x".repeat(BACKEND_ERROR_BODY_LIMIT_BYTES * 4));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
        },
        "/v1/chat/completions",
        { method: "POST" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_upstream_error");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal((details as { truncated?: unknown }).truncated, true);
      assert.equal(
        (details as { limitBytes?: unknown }).limitBytes,
        BACKEND_ERROR_BODY_LIMIT_BYTES,
      );
      assert.equal(
        Buffer.byteLength((details as { body?: string }).body ?? ""),
        BACKEND_ERROR_BODY_LIMIT_BYTES,
      );

      return true;
    },
  );
});

test("adapterRequest rejects oversized successful response bodies", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("x".repeat(BACKEND_RESPONSE_BODY_LIMIT_BYTES + 1));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
        },
        "/v1/chat/completions",
        { method: "POST" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_response_too_large");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal(
        (details as { limitBytes?: unknown }).limitBytes,
        BACKEND_RESPONSE_BODY_LIMIT_BYTES,
      );

      return true;
    },
  );
});

test("adapterRequest rejects declared oversized successful responses before reading body", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(BACKEND_RESPONSE_BODY_LIMIT_BYTES + 1),
    });
    response.end("x");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }

  await assert.rejects(
    () =>
      adapterRequest(
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          timeoutMs: 500,
        },
        "/v1/chat/completions",
        { method: "POST" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_response_too_large");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal((details as { bytesRead?: unknown }).bytesRead, 0);
      assert.equal(
        (details as { declaredContentLength?: unknown }).declaredContentLength,
        BACKEND_RESPONSE_BODY_LIMIT_BYTES + 1,
      );

      return true;
    },
  );
});

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

test("openai-compatible provider ignores malformed token usage counters", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: {
            prompt_tokens: -4,
            completion_tokens: 3,
            total_tokens: 1,
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
    prompt: 0,
    completion: 3,
    total: 3,
  });
});

test("openai-compatible provider snapshots adapter config at construction", async (t) => {
  let observedHeader = "";
  let observedModel = "";

  const server = createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions") {
      observedHeader = request.headers["x-ray-test"]?.toString() ?? "";
      const chunks: Buffer[] = [];

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      observedModel =
        (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string }).model ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "snapshotted" } }] }));
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

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adapter: OpenAICompatibleProviderConfig = {
    kind: "openai-compatible",
    baseUrl,
    modelRef: "original-model-ref",
    timeoutMs: 500,
    headers: { "x-ray-test": "original" },
  };
  const provider = new OpenAICompatibleProvider(createModel(baseUrl, 500), adapter);

  adapter.baseUrl = "http://127.0.0.1:1";
  adapter.modelRef = "mutated-model-ref";
  adapter.timeoutMs = 1;
  adapter.headers!["x-ray-test"] = "mutated";

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

  assert.equal(result.output, "snapshotted");
  assert.equal(observedHeader, "original");
  assert.equal(observedModel, "original-model-ref");
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

test("openai-compatible provider bounds model mismatch diagnostics", async (t) => {
  const longModelId = "x".repeat(257);
  const modelIds = Array.from({ length: 12 }, (_entry, index) => ({
    id: `different-model-ref-${index}`,
  }));

  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: longModelId }, ...modelIds] }));
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
    availableModels: modelIds.slice(0, 10).map((entry) => entry.id),
    availableModelsTruncated: true,
  });
});

test("openai-compatible provider finds modelRef beyond mismatch detail cap", async (t) => {
  const modelIds = [
    ...Array.from({ length: 12 }, (_entry, index) => ({
      id: `different-model-ref-${index}`,
    })),
    { id: "test-model-ref" },
  ];

  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: modelIds }));
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
  assert.deepEqual(health.details, {
    probe: "/v1/models",
    modelRef: "test-model-ref",
  });
});
