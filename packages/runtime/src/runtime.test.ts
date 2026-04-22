import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig } from "@ray/config";
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
