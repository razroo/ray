import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { LlamaCppProviderConfig, ModelConfig, ProviderContext } from "@razroo/ray-core";
import { LlamaCppProvider } from "./providers/llama-cpp.js";

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
  assert.equal(result.diagnostics?.tokensCached, 3);
  assert.equal(result.diagnostics?.slotId, 0);
  assert.equal(result.diagnostics?.timings?.ttftMs, 40);
  assert.equal(completionBody?.cache_prompt, true);
  assert.equal(completionBody?.id_slot, -1);
  assert.ok(seenPaths.includes("/apply-template"));
  assert.ok(seenPaths.includes("/tokenize"));
  assert.ok(seenPaths.includes("/completion"));
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
