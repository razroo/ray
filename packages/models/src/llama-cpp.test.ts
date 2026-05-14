import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type {
  LlamaCppProviderConfig,
  ModelConfig,
  ProviderContext,
  ProviderRequestPreparation,
} from "@razroo/ray-core";
import { LlamaCppProvider } from "./providers/llama-cpp.js";
import { BACKEND_RESPONSE_BODY_LIMIT_BYTES } from "./providers/http.js";

function createModel(
  baseUrl: string,
  timeoutMs: number,
  adapterOverride?: Partial<LlamaCppProviderConfig>,
): ModelConfig {
  return {
    id: "test-model",
    family: "qwen2.5",
    quantization: "q4_k_m",
    contextWindow: 8192,
    warmOnBoot: true,
    maxOutputTokens: 192,
    adapter: {
      kind: "llama.cpp",
      baseUrl,
      modelRef: "test-model-ref",
      timeoutMs,
      cachePrompt: true,
      ...(adapterOverride ?? {}),
    },
  };
}

function createContext(model: ModelConfig, signal: AbortSignal): ProviderContext {
  return {
    signal,
    requestId: "req_test",
    config: {
      profile: "sub1b",
      server: {
        host: "127.0.0.1",
        port: 3000,
        requestBodyLimitBytes: 64_000,
      },
      model,
      scheduler: {
        concurrency: 1,
        maxQueue: 8,
        maxQueuedTokens: 256,
        maxInflightTokens: 128,
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
        memoryCgroupPressureRatioThreshold: 0.9,
        cpuThrottledRatioThreshold: 0.2,
        memoryPsiSomeAvg10Threshold: 10,
        memoryPsiFullAvg10Threshold: 1,
        cpuPsiSomeAvg10Threshold: 50,
        cpuPsiFullAvg10Threshold: 5,
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

test("llama.cpp provider rejects invalid direct adapter config", () => {
  const model = createModel("http://127.0.0.1:8081", 500);
  const adapter = model.adapter as LlamaCppProviderConfig;

  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        modelRef: "",
      }),
    /adapter\.modelRef/,
  );
  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        extra: "not-supported",
      } as LlamaCppProviderConfig),
    /adapter must not contain unsupported key "extra"/,
  );
  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        warmupRequests: Array.from({ length: 9 }, () => ({ input: "ping" })),
      }),
    /adapter\.warmupRequests/,
  );
  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        promptScaffoldCacheEntries: Infinity,
      }),
    /adapter\.promptScaffoldCacheEntries/,
  );
  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        slotSnapshotTimeoutMs: 501,
      }),
    /adapter\.slotSnapshotTimeoutMs/,
  );
  assert.throws(
    () =>
      new LlamaCppProvider(model, {
        ...adapter,
        cachePrompt: "true" as unknown as boolean,
      }),
    /adapter\.cachePrompt/,
  );
});

test("llama.cpp provider uses native completion diagnostics and exact tokenization", async (t) => {
  const seenPaths: string[] = [];
  let completionBody: Record<string, unknown> | undefined;

  const server = createServer(async (request, response) => {
    seenPaths.push(request.url ?? "/");

    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          slots_idle: 1,
          slots_processing: 0,
          slots: [{ id: 0, state: "idle" }],
        }),
      );
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 2,
          chat_template: "{{ bos_token }}{{ messages }}",
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          prompt: "<s>system\nuser\nassistant",
        }),
      );
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          tokens: [1, 2, 3, 4],
        }),
      );
      return;
    }

    if (request.url === "/completion") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      completionBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "hello world",
          tokens_cached: 3,
          tokens_evaluated: 4,
          generation_settings: {
            id_slot: 0,
            n_ctx: 8192,
          },
          timings: {
            prompt_n: 4,
            prompt_ms: 30,
            predicted_n: 5,
            predicted_ms: 50,
            predicted_per_second: 100,
            total_ms: 80,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);

  const health = await provider.health();
  assert.equal(health.status, "ready");
  assert.equal(health.details?.slotsIdle, 1);
  assert.equal(health.details?.contextWindow, 8192);
  assert.equal(health.detectedCapabilities?.applyTemplate, "available");
  assert.equal(health.detectedCapabilities?.chatTemplate, "available");
  assert.equal(health.detectedCapabilities?.backendModel, "qwen2.5-0.6b-q4");
  assert.equal(health.detectedCapabilities?.totalSlots, 2);

  const preparation = await provider.prepare(
    {
      input: "Draft an email",
      system: "Write only the email body.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
    },
    context,
  );

  assert.equal(preparation.promptTokens, 4);

  const result = await provider.infer(
    {
      input: "Draft an email",
      system: "Write only the email body.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
    },
    {
      ...context,
      preparation,
    },
  );

  assert.equal(result.output, "hello world");
  assert.deepEqual(result.usage?.tokens, {
    prompt: 4,
    completion: 5,
    total: 9,
  });
  assert.equal(result.diagnostics?.requestShape, "llama.cpp-completion");
  assert.equal(result.diagnostics?.promptFormat, "llama.cpp-template");
  assert.equal(result.diagnostics?.promptFormatReason, "llama.cpp native template applied");
  assert.equal(result.diagnostics?.backendModel, "qwen2.5-0.6b-q4");
  assert.equal(result.diagnostics?.totalSlots, 2);
  assert.equal(result.diagnostics?.tokensCached, 3);
  assert.equal(result.diagnostics?.slotId, 0);
  assert.equal(result.diagnostics?.timings?.ttftMs, 40);
  assert.equal(completionBody?.cache_prompt, true);
  assert.equal(completionBody?.id_slot, -1);
  assert.ok(seenPaths.includes("/apply-template"));
  assert.ok(seenPaths.includes("/tokenize"));
  assert.ok(seenPaths.includes("/completion"));
});

test("llama.cpp provider ignores malformed native completion metadata", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/completion") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "ok",
          tokens_cached: -3,
          tokens_evaluated: -4,
          truncated: "yes",
          generation_settings: {
            id_slot: -1,
            n_ctx: -2048,
          },
          timings: {
            prompt_n: -4,
            prompt_ms: -30,
            prompt_per_second: -50,
            predicted_n: -5,
            predicted_ms: -60,
            predicted_per_second: -100,
            total_ms: -90,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Hello",
    maxTokens: 32,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
  };
  const preparation = {
    request,
    promptTokens: 4,
    providerState: {
      prompt: "Hello",
    },
  } satisfies ProviderRequestPreparation;
  const result = await provider.infer(request, {
    ...context,
    preparation,
  });

  assert.equal(result.output, "ok");
  assert.deepEqual(result.usage?.tokens, {
    prompt: 4,
    completion: 0,
    total: 4,
  });
  assert.equal(result.diagnostics?.slotId, undefined);
  assert.equal(result.diagnostics?.tokensCached, undefined);
  assert.equal(result.diagnostics?.tokensEvaluated, undefined);
  assert.equal(result.diagnostics?.truncated, undefined);
  assert.equal(result.diagnostics?.contextWindow, model.contextWindow);
  assert.equal(result.diagnostics?.timings?.promptMs, undefined);
  assert.equal(result.diagnostics?.timings?.completionMs, undefined);
  assert.equal(result.diagnostics?.timings?.totalMs, 0);
  assert.equal(result.diagnostics?.timings?.promptTokensPerSecond, undefined);
  assert.equal(result.diagnostics?.timings?.completionTokensPerSecond, undefined);
});

test("llama.cpp provider caps oversized health response bodies", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(BACKEND_RESPONSE_BODY_LIMIT_BYTES + 1));
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.match(String(health.details?.healthError ?? ""), /configured size limit/);
  assert.equal(health.detectedCapabilities?.totalSlots, 1);
});

test("llama.cpp provider rejects declared oversized health responses before reading body", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(BACKEND_RESPONSE_BODY_LIMIT_BYTES + 1),
      });
      response.end("x");
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.match(String(health.details?.healthError ?? ""), /configured size limit/);
  assert.equal(health.detectedCapabilities?.totalSlots, 1);
});

test("llama.cpp provider reports malformed health JSON with provider diagnostics", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.match(String(health.details?.healthError ?? ""), /health endpoint returned invalid JSON/);
  assert.equal(health.detectedCapabilities?.totalSlots, 1);
});

test("llama.cpp provider reports health probe timeouts with provider diagnostics", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      request.on("close", () => response.destroy());
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 25);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.match(String(health.details?.healthError ?? ""), /did not respond within 25ms/);
  assert.equal(health.detectedCapabilities?.totalSlots, 1);
});

test("llama.cpp provider refuses to follow backend health redirects", async (t) => {
  const envName = "RAY_LLAMA_CPP_HEALTH_REDIRECT_TEST_KEY";
  const previousEnvValue = process.env[envName];
  process.env[envName] = "health-redirect-secret";
  t.after(() => {
    if (previousEnvValue === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previousEnvValue;
    }
  });

  let redirectedRequests = 0;
  let redirectedAuthorization: string | undefined;
  const redirectedServer = createServer((request, response) => {
    redirectedRequests += 1;
    redirectedAuthorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });

  await new Promise<void>((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));
  t.after(() => redirectedServer.close());

  const redirectedAddress = redirectedServer.address();
  if (!redirectedAddress || typeof redirectedAddress === "string") {
    throw new Error("Expected a TCP server address");
  }

  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(307, {
        "content-type": "application/json",
        location: `http://127.0.0.1:${redirectedAddress.port}/health?include_slots=1`,
      });
      response.end(JSON.stringify({ status: "redirected" }));
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          default_generation_settings: {
            n_ctx: 8192,
            model: "qwen2.5-0.6b-q4",
          },
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500, {
    apiKeyEnv: envName,
  });
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.match(String(health.details?.healthError ?? ""), /redirected with 307/);
  assert.equal(health.detectedCapabilities?.totalSlots, 1);
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedAuthorization, undefined);
});

test("llama.cpp provider falls back when native prompt templating is unavailable", async (t) => {
  const seenPaths: string[] = [];
  let completionBody: Record<string, unknown> | undefined;

  const server = createServer(async (request, response) => {
    seenPaths.push(request.url ?? "/");

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3, 4, 5] }));
      return;
    }

    if (request.url === "/completion") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      completionBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "A concise fallback completion.",
          timings: {
            prompt_n: 5,
            predicted_n: 4,
            predicted_ms: 40,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Write one sentence.",
    system: "Keep it direct.",
    maxTokens: 32,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
  };

  const preparation = await provider.prepare(request, context);
  const result = await provider.infer(request, {
    ...context,
    preparation,
  });

  assert.equal(result.output, "A concise fallback completion.");
  assert.equal(result.diagnostics?.promptFormat, "ray-chat-fallback");
  assert.equal(result.diagnostics?.promptFormatReason, "llama.cpp /apply-template unavailable");
  assert.match(String(completionBody?.prompt ?? ""), /System:\nKeep it direct\./);
  assert.match(String(completionBody?.prompt ?? ""), /User:\nWrite one sentence\./);
  assert.ok(seenPaths.includes("/apply-template"));
});

test("llama.cpp provider keeps metadata prompt-format variants isolated", async (t) => {
  const completionPrompts: string[] = [];

  const server = createServer(async (request, response) => {
    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          chat_template: "{{ messages }}",
          default_generation_settings: {
            n_ctx: 4096,
            model: "test-model-ref",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<native>Metadata sensitive</native>" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/completion") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      completionPrompts.push(String(body.prompt ?? ""));

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "ok",
          timings: {
            prompt_n: 3,
            predicted_n: 1,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const baseRequest = {
    input: "Metadata sensitive",
    maxTokens: 32,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
  };
  const nativeRequest = {
    ...baseRequest,
    metadata: {},
  };
  const fallbackRequest = {
    ...baseRequest,
    metadata: {
      rayPromptFormat: "ray-chat-fallback",
    },
  };

  const nativePreparation = await provider.prepare(nativeRequest, context);
  const fallbackPreparation = await provider.prepare(fallbackRequest, context);
  const nativeState = nativePreparation.providerState as { prompt?: string };
  const fallbackState = fallbackPreparation.providerState as { prompt?: string };

  assert.equal(nativePreparation.diagnostics?.promptFormat, "llama.cpp-template");
  assert.equal(fallbackPreparation.diagnostics?.promptFormat, "ray-chat-fallback");
  assert.equal(nativeState.prompt, "<native>Metadata sensitive</native>");
  assert.match(fallbackState.prompt ?? "", /User:\nMetadata sensitive/);

  await provider.infer(fallbackRequest, {
    ...context,
    preparation: nativePreparation,
  });

  assert.match(completionPrompts[0] ?? "", /User:\nMetadata sensitive/);
  assert.doesNotMatch(completionPrompts[0] ?? "", /<native>/);
});

test("llama.cpp provider falls back to chat completions for json_object requests", async (t) => {
  const seenPaths: string[] = [];

  const server = createServer(async (request, response) => {
    seenPaths.push(request.url ?? "/");

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json prompt" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"intent":"positive"}',
              },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);

  const preparation = await provider.prepare(
    {
      input: "Classify the reply",
      system: "Return only compact JSON.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
      responseFormat: {
        type: "json_object",
      },
    },
    context,
  );

  const result = await provider.infer(
    {
      input: "Classify the reply",
      system: "Return only compact JSON.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
      responseFormat: {
        type: "json_object",
      },
    },
    {
      ...context,
      preparation,
    },
  );

  assert.equal(result.output, '{"intent":"positive"}');
  assert.equal(result.diagnostics?.requestShape, "openai-chat");
  assert.deepEqual(result.usage?.tokens, {
    prompt: 3,
    completion: 4,
    total: 7,
  });
  assert.ok(seenPaths.includes("/v1/chat/completions"));
  assert.ok(!seenPaths.includes("/completion"));
});

test("llama.cpp provider requires JSON-mode probes to return objects", async (t) => {
  let chatCompletionCalls = 0;

  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1,
          chat_template: "{{ messages }}",
          default_generation_settings: {
            n_ctx: 4096,
            model: "test-model-ref",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json mode probe</s>" }));
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/completion") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "warm",
          timings: {
            prompt_n: 3,
            predicted_n: 1,
          },
        }),
      );
      return;
    }

    if (request.url === "/v1/chat/completions") {
      chatCompletionCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "true",
              },
            },
          ],
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);

  await provider.warm();
  const health = await provider.health();

  assert.equal(chatCompletionCalls, 1);
  assert.equal(health.detectedCapabilities?.jsonMode, "unavailable");
});

test("llama.cpp provider rejects oversized chat-completion output", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json prompt" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "x".repeat(8_193),
              },
            },
          ],
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Classify the reply",
    system: "Return only compact JSON.",
    maxTokens: 1,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
    responseFormat: {
      type: "json_object" as const,
    },
  };

  const preparation = await provider.prepare(request, context);

  await assert.rejects(
    () =>
      provider.infer(request, {
        ...context,
        preparation,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_invalid_response");

      const details = (error as { details?: unknown }).details;
      assert.ok(details && typeof details === "object" && !Array.isArray(details));
      assert.equal((details as { maxChars?: unknown }).maxChars, 8_192);
      assert.equal((details as { actualChars?: unknown }).actualChars, 8_193);

      return true;
    },
  );
});

test("llama.cpp provider sanitizes chat-completion token usage", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json prompt" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"intent":"positive"}',
              },
            },
          ],
          usage: {
            prompt_tokens: -3,
            completion_tokens: 2,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Classify the reply",
    system: "Return only compact JSON.",
    maxTokens: 64,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
    responseFormat: {
      type: "json_object" as const,
    },
  };

  const preparation = await provider.prepare(request, context);
  const result = await provider.infer(request, {
    ...context,
    preparation,
  });

  assert.equal(result.output, '{"intent":"positive"}');
  assert.deepEqual(result.usage?.tokens, {
    prompt: 3,
    completion: 2,
    total: 5,
  });
});

test("llama.cpp provider repairs invalid json_object chat responses once", async (t) => {
  let chatCalls = 0;

  const server = createServer(async (request, response) => {
    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json prompt" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      chatCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: chatCalls === 1 ? "intent: positive" : '{"intent":"positive"}',
              },
            },
          ],
          usage: {
            prompt_tokens: chatCalls === 1 ? 3 : 5,
            completion_tokens: chatCalls === 1 ? 4 : 2,
            total_tokens: chatCalls === 1 ? 7 : 7,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Classify the reply",
    system: "Return only compact JSON.",
    maxTokens: 64,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
    responseFormat: {
      type: "json_object" as const,
    },
  };

  const preparation = await provider.prepare(request, context);
  const result = await provider.infer(request, {
    ...context,
    preparation,
  });

  assert.equal(result.output, '{"intent":"positive"}');
  assert.equal(chatCalls, 2);
  assert.equal(result.diagnostics?.jsonRepairAttempted, true);
  assert.equal(result.diagnostics?.jsonRepairSucceeded, true);
  assert.deepEqual(result.usage?.tokens, {
    prompt: 8,
    completion: 6,
    total: 14,
  });
});

test("llama.cpp provider degrades gracefully when slot snapshots time out", async (t) => {
  const seenPaths: string[] = [];

  const server = createServer(async (request, response) => {
    seenPaths.push(request.url ?? "/");

    if (request.url === "/slots") {
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>json prompt" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"intent":"positive"}',
              },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 4,
            total_tokens: 7,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500, {
    slotStateTtlMs: 0,
    slotSnapshotTimeoutMs: 100,
  });
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);

  const preparation = await provider.prepare(
    {
      input: "Classify the reply",
      system: "Return only compact JSON.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
      responseFormat: {
        type: "json_object",
      },
    },
    context,
  );

  const result = await provider.infer(
    {
      input: "Classify the reply",
      system: "Return only compact JSON.",
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
      responseFormat: {
        type: "json_object",
      },
    },
    {
      ...context,
      preparation,
    },
  );

  assert.equal(result.output, '{"intent":"positive"}');
  assert.ok(seenPaths.includes("/slots"));
  assert.ok(seenPaths.includes("/v1/chat/completions"));
});

test("llama.cpp provider caps slot snapshots retained from backend", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          Array.from({ length: 80 }, (_value, index) => ({
            id: index,
            is_processing: false,
            n_ctx: 2048,
          })),
        ),
      );
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 80,
          default_generation_settings: {
            n_ctx: 2048,
            model: "test-model-ref",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>hello" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500, {
    slotStateTtlMs: 0,
  });
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const preparation = await provider.prepare(
    {
      input: "Hello",
      maxTokens: 32,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
    },
    context,
  );

  assert.equal(preparation.slotSnapshots?.length, 64);
  assert.equal(preparation.slotSnapshots?.at(0)?.id, 0);
  assert.equal(preparation.slotSnapshots?.at(-1)?.id, 63);
});

test("llama.cpp provider ignores malformed slot snapshot fields", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          slots: [
            null,
            { id: -1, is_processing: false, n_ctx: 2048 },
            { id: 1.5, is_processing: false },
            {
              id: 2,
              is_processing: true,
              task_id: -7,
              n_ctx: -2048,
              n_keep: "bad",
              next_token: { n_past: 3.5 },
            },
            {
              id: "bad",
              id_slot: 3,
              is_processing: false,
              task_id: "bad",
              id_task: 9,
              n_ctx: 2048,
              n_keep: 64,
              next_token: { n_past: 128 },
            },
            {
              id: 4,
              is_processing: false,
              n_ctx: 8193,
              n_keep: 8193,
              next_token: { n_past: 8193 },
            },
            {
              id: 1_000_000_001,
              is_processing: false,
              n_ctx: 2048,
            },
          ],
        }),
      );
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 2,
          chat_template: "{{ messages }}",
          default_generation_settings: {
            n_ctx: 2048,
            model: "test-model-ref",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>hello" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500, {
    slotStateTtlMs: 0,
  });
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);
  const preparation = await provider.prepare(
    {
      input: "Hello",
      maxTokens: 32,
      temperature: 0.2,
      topP: 0.95,
      cache: true,
      metadata: {},
    },
    context,
  );

  assert.deepEqual(
    preparation.slotSnapshots?.map((slot) => slot.id),
    [2, 3, 4],
  );
  assert.equal(preparation.slotSnapshots?.[0]?.taskId, undefined);
  assert.equal(preparation.slotSnapshots?.[0]?.contextWindow, undefined);
  assert.equal(preparation.slotSnapshots?.[0]?.cacheTokens, undefined);
  assert.equal(preparation.slotSnapshots?.[0]?.promptTokens, undefined);
  assert.deepEqual(preparation.slotSnapshots?.[1], {
    id: 3,
    taskId: 9,
    isProcessing: false,
    contextWindow: 2048,
    promptTokens: 128,
    cacheTokens: 64,
    updatedAt: preparation.slotSnapshots?.[1]?.updatedAt,
  });
  assert.deepEqual(preparation.slotSnapshots?.[2], {
    id: 4,
    isProcessing: false,
    updatedAt: preparation.slotSnapshots?.[2]?.updatedAt,
  });
});

test("llama.cpp provider ignores malformed health and capability counters", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health?include_slots=1") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: 7,
          slots_idle: 1_000_000_001,
          slots_processing: 1_000_000_001,
        }),
      );
      return;
    }

    if (request.url === "/slots") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
      return;
    }

    if (request.url === "/props") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          total_slots: 1_000_000_001,
          chat_template: "{{ messages }}",
          default_generation_settings: {
            n_ctx: 8193,
            model: "test-model-ref",
          },
        }),
      );
      return;
    }

    if (request.url === "/apply-template") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ prompt: "<s>hello" }));
      return;
    }

    if (request.url === "/tokenize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tokens: [1, 2, 3] }));
      return;
    }

    if (request.url === "/completion") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "ok",
          tokens_cached: 8193,
          tokens_evaluated: 1_000_000_001,
          generation_settings: {
            n_ctx: 8193,
          },
          timings: {
            prompt_n: 1_000_000_001,
            predicted_n: 1_000_000_001,
            prompt_ms: 1_000_000_001,
            predicted_per_second: 1_000_000_001,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500, {
    slotStateTtlMs: 0,
  });
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const health = await provider.health();

  assert.equal(health.status, "ready");
  assert.equal(health.details?.slotsIdle, undefined);
  assert.equal(health.details?.slotsProcessing, undefined);
  assert.equal(health.detectedCapabilities?.totalSlots, undefined);
  assert.equal(health.detectedCapabilities?.contextWindow, model.contextWindow);

  const context = createContext(model, new AbortController().signal);
  const request = {
    input: "Hello",
    maxTokens: 32,
    temperature: 0.2,
    topP: 0.95,
    cache: true,
    metadata: {},
  };
  const preparation = await provider.prepare(request, context);
  const result = await provider.infer(request, {
    ...context,
    preparation,
  });

  assert.equal(preparation.diagnostics?.totalSlots, undefined);
  assert.equal(preparation.diagnostics?.contextWindow, model.contextWindow);
  assert.equal(result.output, "ok");
  assert.equal(result.diagnostics?.totalSlots, undefined);
  assert.equal(result.diagnostics?.contextWindow, model.contextWindow);
  assert.equal(result.diagnostics?.tokensCached, undefined);
  assert.equal(result.diagnostics?.tokensEvaluated, undefined);
  assert.equal(result.diagnostics?.timings?.promptMs, undefined);
  assert.equal(result.diagnostics?.timings?.completionTokensPerSecond, undefined);
});

test("llama.cpp provider bounds preferred slot affinity maps", async (t) => {
  let completionCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === "/completion") {
      const slotId = completionCalls;
      completionCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: "ok",
          generation_settings: {
            id_slot: slotId,
          },
          timings: {
            prompt_n: 1,
            predicted_n: 1,
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

  const model = createModel(`http://127.0.0.1:${address.port}`, 500);
  const provider = new LlamaCppProvider(model, model.adapter as LlamaCppProviderConfig);
  const context = createContext(model, new AbortController().signal);

  for (let index = 0; index < 520; index += 1) {
    const request = {
      input: `Affinity prompt ${index}`,
      maxTokens: 1,
      temperature: 0.2,
      topP: 0.95,
      cache: false,
      metadata: {},
    };
    const preparation = {
      request,
      promptTokens: 1,
      providerState: {
        prompt: request.input,
      },
    } satisfies ProviderRequestPreparation;

    await provider.infer(request, {
      ...context,
      affinityKey: `family-${index}`,
      preparation,
    });
  }

  const providerState = provider as unknown as {
    familyPreferredSlots: Map<string, number>;
    slotFamilyAssignments: Map<number, string>;
  };
  assert.equal(providerState.familyPreferredSlots.size, 512);
  assert.equal(providerState.slotFamilyAssignments.size, 64);
  assert.equal(providerState.familyPreferredSlots.has("family-0"), false);
  assert.equal(providerState.familyPreferredSlots.has("family-519"), true);
});
