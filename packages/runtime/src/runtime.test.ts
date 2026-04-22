import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import type { ModelProvider } from "@razroo/ray-core";
import { createRayRuntime } from "./index.js";

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
