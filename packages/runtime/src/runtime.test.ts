import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import type { ModelProvider } from "@razroo/ray-core";
import { createRayRuntime } from "./index.js";

test("runtime rejects invalid direct config", () => {
  const config = createDefaultConfig("tiny");
  config.scheduler.concurrency = 0;

  assert.throws(() => createRayRuntime(config), /scheduler\.concurrency/);
});

test("runtime snapshots config at construction", async () => {
  let observedInput = "";
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedInput = request.input;
      return {
        output: request.input,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      maxPromptChars: 8,
      queueDepthThreshold: 1_000,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  config.gracefulDegradation.maxPromptChars = 1_000;

  const result = await runtime.infer({
    input: "x".repeat(32),
    cache: false,
  });

  assert.equal(observedInput.length, 8);
  assert.equal(result.degraded, true);
  assert.equal(runtime.config.gracefulDegradation.maxPromptChars, 8);
});

test("runtime returns chars and provider token usage explicitly", async () => {
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer() {
      return {
        output: "done",
        usage: {
          tokens: {
            prompt: 11,
            completion: 7,
            total: 18,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });
  const result = await runtime.infer({
    input: "hello world",
  });

  assert.deepEqual(result.usage.tokens, {
    prompt: 11,
    completion: 7,
    total: 18,
  });
  assert.deepEqual(result.usage.chars, {
    prompt: 11,
    completion: 4,
    total: 15,
  });
});

test("runtime health reports upstream unavailability", async () => {
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        details: {
          message: "backend offline",
        },
      };
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const health = await runtime.health();

  assert.equal(health.status, "unavailable");
  assert.equal(health.provider.status, "unavailable");
});

test("runtime deduplicates concurrent provider health checks", async () => {
  let calls = 0;
  let releaseHealth!: () => void;
  const healthGate = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      calls += 1;
      await healthGate;
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
      };
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const healthChecks = Promise.all([runtime.health(), runtime.health(), runtime.health()]);
  await Promise.resolve();

  assert.equal(calls, 1);
  releaseHealth();

  const results = await healthChecks;
  assert.deepEqual(
    results.map((result) => result.provider.status),
    ["ready", "ready", "ready"],
  );

  await runtime.health();
  assert.equal(calls, 1);
});

test("runtime rejects malformed request bodies and numeric controls", async () => {
  const runtime = createRayRuntime(createDefaultConfig("tiny"));

  await assert.rejects(
    runtime.infer(null as unknown as Parameters<typeof runtime.infer>[0]),
    /request body must be a JSON object/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      maxTokens: "128",
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /maxTokens must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      temperature: Number.NaN,
    }),
    /temperature must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      topP: Number.POSITIVE_INFINITY,
    }),
    /topP must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: "false",
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /cache must be a boolean/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      system: { role: "system" },
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /system must be a string/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      dedupeKey: 123,
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /dedupeKey must be a string/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: {
        promptFamily: ["email"],
      },
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /metadata must be an object of string values/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
    }),
    /metadata must not contain unsafe key "__proto__"/,
  );

  const metadata = {};
  Object.defineProperty(metadata, "promptFamily", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: metadata as Record<string, string>,
    }),
    /metadata must not contain unreadable properties/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: Object.fromEntries(
        Array.from({ length: 33 }, (_value, index) => [`key${index}`, "value"]),
      ),
    }),
    /metadata must contain at most 32 entries/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: {
        promptFamily: "x".repeat(1_025),
      },
    }),
    /metadata\.promptFamily must be at most 1024 characters/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      dedupeKey: "x".repeat(513),
    }),
    /dedupeKey must be at most 512 characters/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      stop: Array.from({ length: 17 }, (_value, index) => `stop-${index}`),
    }),
    /stop must contain at most 16 entries/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      stop: ["x".repeat(257)],
    }),
    /stop entries must be at most 256 characters/,
  );
});

test("runtime keeps seeded variants isolated in cache keys", async () => {
  const calls: Array<number | undefined> = [];
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "seeded-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      calls.push(request.seed);
      return {
        output: `seed:${request.seed ?? "none"}:call:${calls.length}`,
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  const first = await runtime.infer({
    input: "hello world",
    seed: 11,
  });
  const second = await runtime.infer({
    input: "hello world",
    seed: 11,
  });
  const third = await runtime.infer({
    input: "hello world",
    seed: 12,
  });

  assert.equal(first.output, "seed:11:call:1");
  assert.equal(first.cached, false);
  assert.equal(second.output, "seed:11:call:1");
  assert.equal(second.cached, true);
  assert.equal(third.output, "seed:12:call:2");
  assert.equal(third.cached, false);
  assert.deepEqual(calls, [11, 12]);
});

test("runtime uses provider token preparation and exposes compiler diagnostics", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "prepared-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 77,
      };
    },
    async infer() {
      return {
        output: "prepared",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });
  const result = await runtime.infer({
    system: "Write only the email body.\nWrite only the email body.",
    input: "Write only the email body.\nDraft a short reply.",
    maxTokens: 96,
  });

  assert.equal(result.usage.tokens?.prompt, 77);
  assert.ok((result.diagnostics?.promptCompiler?.charsSaved ?? 0) > 0);
  assert.ok(typeof result.diagnostics?.promptCompiler?.familyKey === "string");
  assert.equal(result.diagnostics?.taskRouting?.recommendedModelRole, "drafter");
});

test("runtime trims oversized prompts before prompt compilation", async () => {
  let observedInput = "";
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "trimmed-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedInput = request.input;
      return {
        output: "trimmed",
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      gracefulDegradation: {
        enabled: true,
        maxPromptChars: 32,
        queueDepthThreshold: 1_000,
      },
    }),
    { provider },
  );
  const result = await runtime.infer({
    input: "x".repeat(128),
    cache: false,
  });

  assert.equal(result.degraded, true);
  assert.equal(observedInput.length, 32);
  assert.equal(result.diagnostics?.promptCompiler?.charsBefore, 32);
});

test("runtime times out and aborts stalled provider preparation", async () => {
  let prepareAborted = false;
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "stalled-prepare-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request, context) {
      await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            prepareAborted = true;
            reject(context.signal.reason);
          },
          { once: true },
        );
      });

      return {
        request,
        promptTokens: 1,
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      scheduler: {
        requestTimeoutMs: 20,
      },
    }),
    { provider },
  );

  await assert.rejects(
    () =>
      runtime.infer({
        input: "hello world",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "request_timeout");
      assert.deepEqual((error as { details?: unknown }).details, {
        phase: "prepare",
        timeoutMs: 20,
      });
      return true;
    },
  );

  assert.equal(prepareAborted, true);
  assert.equal(inferCalled, false);
});

test("runtime bounds concurrent provider preparation before scheduling inference", async () => {
  let activePreparations = 0;
  let maxActivePreparations = 0;
  let prepareStarts = 0;
  const startWaiters: Array<() => void> = [];
  const releasePreparations: Array<() => void> = [];
  const waitForPrepareStarts = async (count: number) => {
    while (prepareStarts < count) {
      await new Promise<void>((resolve) => {
        startWaiters.push(resolve);
      });
    }
  };
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-prepare-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      prepareStarts += 1;
      for (const resolve of startWaiters.splice(0)) {
        resolve();
      }

      try {
        await new Promise<void>((resolve) => {
          releasePreparations.push(resolve);
        });
        return {
          request,
          promptTokens: 8,
        };
      } finally {
        activePreparations -= 1;
      }
    },
    async infer(request) {
      return {
        output: request.input,
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      scheduler: {
        concurrency: 1,
        maxQueue: 1,
        affinityLookahead: 1,
        requestTimeoutMs: 500,
      },
    }),
    { provider },
  );

  const first = runtime.infer({
    input: "first",
    cache: false,
  });
  await waitForPrepareStarts(1);

  const second = runtime.infer({
    input: "second",
    cache: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prepareStarts, 1);
  assert.equal(maxActivePreparations, 1);

  await assert.rejects(
    runtime.infer({
      input: "third",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "queue_full");
      assert.equal((error as { details?: { phase?: string } }).details?.phase, "prepare");
      return true;
    },
  );

  releasePreparations.shift()?.();
  await waitForPrepareStarts(2);
  releasePreparations.shift()?.();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.output, "first");
  assert.equal(secondResult.output, "second");
  assert.equal(prepareStarts, 2);
  assert.equal(maxActivePreparations, 1);
});

test("runtime exposes task-aware routing diagnostics for classification", async () => {
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "classifier-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      return {
        output: '{"intent":"positive"}',
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      tags: {
        modelRole: "classifier",
      },
    }),
    { provider },
  );
  const result = await runtime.infer({
    input: "Classify this reply",
    responseFormat: {
      type: "json_object",
    },
    metadata: {
      promptFamily: "email.reply_classification",
    },
  });

  assert.equal(result.diagnostics?.taskRouting?.taskKind, "classification");
  assert.equal(result.diagnostics?.taskRouting?.recommendedModelRole, "classifier");
  assert.equal(result.diagnostics?.taskRouting?.matchedActiveRole, true);
});

test("runtime adaptively reduces maxTokens when observed throughput drops", async () => {
  const observedMaxTokens: number[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "adaptive-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 24,
      };
    },
    async infer(request) {
      observedMaxTokens.push(request.maxTokens);
      return {
        output: "ok",
        diagnostics: {
          requestShape: "llama.cpp-completion",
          timings: {
            completionTokensPerSecond: 5,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      adaptiveTuning: {
        enabled: true,
        sampleSize: 4,
        queueLatencyThresholdMs: 1_000,
        minCompletionTokensPerSecond: 10,
        maxOutputReductionRatio: 0.5,
        minOutputTokens: 32,
      },
    }),
    { provider },
  );

  const first = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
  });
  const second = await runtime.infer({
    input: "hello world again",
    maxTokens: 128,
  });

  assert.equal(first.diagnostics?.adaptiveTuning?.reduced, false);
  assert.equal(second.diagnostics?.adaptiveTuning?.reduced, true);
  assert.ok((second.diagnostics?.adaptiveTuning?.appliedMaxTokens ?? 128) < 128);
  assert.deepEqual(observedMaxTokens, [128, 96]);
});

test("runtime bounds learned output family history across unique prompt families", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-family-history-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      return {
        output: "ok",
        usage: {
          tokens: {
            prompt: 8,
            completion: 2,
            total: 10,
          },
        },
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  for (let index = 0; index < 520; index += 1) {
    await runtime.infer({
      input: `unique prompt family ${index}`,
      cache: false,
      metadata: {
        promptFamily: `family-${index}`,
      },
    });
  }

  const familyCompletionHistory = (
    runtime as unknown as {
      familyCompletionHistory: Map<string, unknown>;
    }
  ).familyCompletionHistory;
  assert.equal(familyCompletionHistory.size, 512);
});

test("runtime metrics expose small-box process and provider telemetry", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "telemetry-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 80,
        preferredSlot: 1,
        slotSnapshots: [
          {
            id: 1,
            isProcessing: false,
            promptTokens: 64,
            cacheTokens: 48,
            updatedAt: new Date().toISOString(),
          },
          {
            id: 2,
            isProcessing: true,
            promptTokens: 96,
            cacheTokens: 32,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    },
    async infer() {
      return {
        output: "ok",
        diagnostics: {
          requestShape: "llama.cpp-completion",
          slotId: 1,
          tokensCached: 40,
          timings: {
            completionTokensPerSecond: 22,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("sub1b"), { provider });
  await runtime.infer({
    input: "hello world",
    maxTokens: 64,
  });

  const metrics = runtime.metricsSnapshot();

  assert.equal(metrics.gauges["provider.slots.total"], 2);
  assert.equal(metrics.gauges["provider.slots.processing"], 1);
  assert.equal(metrics.gauges["provider.slots.idle"], 1);
  assert.equal(metrics.gauges["provider.slot.last_id"], 1);
  assert.equal(metrics.gauges["provider.prompt_cache.tokens_cached"], 40);
  assert.equal(metrics.gauges["provider.prompt_cache.reuse_ratio"], 0.5);
  assert.equal(metrics.gauges["provider.completion_tps"], 22);
  assert.ok(typeof metrics.gauges["process.memory.rss_mib"] === "number");
  assert.ok(typeof metrics.gauges["process.memory.heap_used_mib"] === "number");
  assert.ok(typeof metrics.gauges["process.cpu.percent"] === "number");
  assert.ok(typeof metrics.gauges["runtime.event_loop_lag_p95_ms"] === "number");
  assert.equal(metrics.recent?.lastSlotId, 1);
  assert.equal(metrics.recent?.lastPromptCacheTokens, 40);
  assert.equal(metrics.recent?.lastPromptCacheReuseRatio, 0.5);
});
