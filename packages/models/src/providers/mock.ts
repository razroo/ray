import {
  sleep,
  type MockProviderConfig,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type ProviderContext,
  type ProviderResult,
} from "@razroo/ray-core";

const MAX_MOCK_MODEL_ID_CHARS = 256;
const MAX_MOCK_LATENCY_MS = 120_000;
const MAX_MOCK_SEED_CHARS = 512;
const unsafeMockRecordKeys = new Set(["__proto__", "constructor", "prototype"]);
const mockAdapterKeys = new Set(["kind", "latencyMs", "seed"]);

interface SnapshotMockProviderConfig {
  latencyMs: number;
  seed?: string;
}

function assertNonEmptyStringLength(value: string, label: string, maxChars: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new RangeError(`${label} must be at most ${maxChars} characters`);
  }
}

function assertOptionalStringLength(
  value: string | undefined,
  label: string,
  maxChars: number,
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  if (value.length > maxChars) {
    throw new RangeError(`${label} must be at most ${maxChars} characters`);
  }
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertMockAdapterKeys(adapter: MockProviderConfig): void {
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("model.adapter must be an object");
  }

  for (const [key] of objectEntries(adapter, "model.adapter")) {
    if (unsafeMockRecordKeys.has(key)) {
      throw new TypeError(`model.adapter must not contain unsafe key "${key}"`);
    }

    if (!mockAdapterKeys.has(key)) {
      throw new TypeError(`model.adapter must not contain unsupported key "${key}"`);
    }
  }
}

function snapshotMockAdapter(adapter: MockProviderConfig): SnapshotMockProviderConfig {
  assertMockAdapterKeys(adapter);
  assertPositiveSafeIntegerAtMost(
    adapter.latencyMs,
    "model.adapter.latencyMs",
    MAX_MOCK_LATENCY_MS,
  );
  assertOptionalStringLength(adapter.seed, "model.adapter.seed", MAX_MOCK_SEED_CHARS);

  return {
    latencyMs: adapter.latencyMs,
    ...(adapter.seed !== undefined ? { seed: adapter.seed } : {}),
  };
}

export class MockProvider implements ModelProvider {
  readonly kind = "mock";
  readonly modelId: string;
  readonly capabilities = {
    streaming: false,
    quantized: false,
    localBackend: true,
  } as const;
  private readonly adapter: SnapshotMockProviderConfig;

  constructor(model: ModelConfig, adapter: MockProviderConfig) {
    assertNonEmptyStringLength(model.id, "model.id", MAX_MOCK_MODEL_ID_CHARS);
    this.modelId = model.id;
    this.adapter = snapshotMockAdapter(adapter);
  }

  async infer(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    await sleep(this.adapter.latencyMs);

    const systemPrefix = request.system ? `system=${request.system.slice(0, 72)}\n` : "";
    const body = request.input.slice(0, 320);
    const seed = this.adapter.seed ?? "ray";
    const output = `[ray:mock model=${this.modelId} profile=${context.config.profile} seed=${seed}]\n${systemPrefix}${body}`;
    const promptChars = request.input.length + (request.system?.length ?? 0);
    const completionChars = output.length;

    return {
      output,
      usage: {
        chars: {
          prompt: promptChars,
          completion: completionChars,
          total: promptChars + completionChars,
        },
      },
    };
  }
}
