import assert from "node:assert/strict";
import test from "node:test";
import type {
  MockProviderConfig,
  ModelConfig,
  NormalizedInferenceRequest,
  ProviderContext,
} from "@razroo/ray-core";
import { MockProvider } from "./providers/mock.js";

function createModel(adapter: MockProviderConfig): ModelConfig {
  return {
    id: "mock-model",
    family: "mock",
    quantization: "unknown",
    contextWindow: 512,
    warmOnBoot: false,
    maxOutputTokens: 64,
    adapter,
  };
}

const request: NormalizedInferenceRequest = {
  input: "hello mock provider",
  maxTokens: 16,
  temperature: 0,
  topP: 1,
  cache: false,
  metadata: {},
};

const context = {
  signal: new AbortController().signal,
  requestId: "req_mock",
  config: {
    profile: "tiny",
  },
  startedAt: 0,
} as ProviderContext;

test("mock provider rejects invalid direct config", () => {
  const adapter: MockProviderConfig = {
    kind: "mock",
    latencyMs: 1,
  };

  assert.throws(() => new MockProvider({ ...createModel(adapter), id: "" }, adapter), /model\.id/);
  assert.throws(
    () =>
      new MockProvider(createModel({ ...adapter, latencyMs: 0 }), {
        ...adapter,
        latencyMs: 0,
      }),
    /model\.adapter\.latencyMs/,
  );
  assert.throws(
    () =>
      new MockProvider(createModel({ ...adapter, seed: "x".repeat(513) }), {
        ...adapter,
        seed: "x".repeat(513),
      }),
    /model\.adapter\.seed/,
  );
});

test("mock provider snapshots direct model and adapter config", async () => {
  const adapter: MockProviderConfig = {
    kind: "mock",
    latencyMs: 1,
    seed: "initial-seed",
  };
  const model = createModel(adapter);
  const provider = new MockProvider(model, adapter);
  model.id = "mutated-model";
  adapter.seed = "mutated-seed";

  const result = await provider.infer(request, context);

  assert.match(result.output, /model=mock-model/);
  assert.match(result.output, /seed=initial-seed/);
  assert.doesNotMatch(result.output, /mutated/);
});
