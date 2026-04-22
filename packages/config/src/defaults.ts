import type { RayConfig, RayProfile } from "@razroo/ray-core";

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends object
    ? DeepPartial<T[Key]>
    : T[Key] extends Array<infer Item>
      ? Array<DeepPartial<Item>>
      : T[Key];
};

const profileDefaults: Record<RayProfile, RayConfig> = {
  tiny: {
    profile: "tiny",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: 32_000,
    },
    model: {
      id: "tiny-dev",
      family: "mock",
      quantization: "unknown",
      contextWindow: 4096,
      warmOnBoot: false,
      maxOutputTokens: 192,
      adapter: {
        kind: "mock",
        latencyMs: 35,
        seed: "ray-tiny",
      },
    },
    scheduler: {
      concurrency: 1,
      maxQueue: 32,
      maxQueuedTokens: 12_000,
      maxInflightTokens: 2_500,
      requestTimeoutMs: 8_000,
      dedupeInflight: true,
      batchWindowMs: 0,
      affinityLookahead: 8,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      pollIntervalMs: 500,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 5_000,
      maxCallbackAttempts: 5,
    },
    cache: {
      enabled: true,
      maxEntries: 128,
      ttlMs: 30_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: false,
      slowRequestThresholdMs: 750,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: 8,
      maxPromptChars: 4_000,
      degradeToMaxTokens: 96,
    },
    promptCompiler: {
      enabled: true,
      collapseWhitespace: true,
      dedupeRepeatedLines: true,
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: false,
      sampleSize: 24,
      queueLatencyThresholdMs: 250,
      minCompletionTokensPerSecond: 18,
      maxOutputReductionRatio: 0.5,
      minOutputTokens: 48,
      learnedFamilyCapEnabled: true,
      familyHistorySize: 48,
      learnedCapMinSamples: 6,
      draftPercentile: 0.95,
      shortPercentile: 0.9,
      learnedCapHeadroomTokens: 24,
    },
    auth: {
      enabled: false,
      apiKeyEnv: "RAY_API_KEYS",
    },
    rateLimit: {
      enabled: false,
      windowMs: 60_000,
      maxRequests: 120,
      keyStrategy: "ip",
      trustProxyHeaders: false,
    },
    tags: {
      target: "tiny",
      hosting: "cheap-vps",
    },
  },
  vps: {
    profile: "vps",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: 64_000,
    },
    model: {
      id: "qwen2.5-3b-instruct-q4",
      family: "qwen2.5",
      quantization: "q4_k_m",
      contextWindow: 8192,
      warmOnBoot: true,
      maxOutputTokens: 384,
      adapter: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-3b-instruct-q4_k_m",
        timeoutMs: 20_000,
      },
    },
    scheduler: {
      concurrency: 2,
      maxQueue: 96,
      maxQueuedTokens: 48_000,
      maxInflightTokens: 8_000,
      requestTimeoutMs: 20_000,
      dedupeInflight: true,
      batchWindowMs: 0,
      affinityLookahead: 12,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      pollIntervalMs: 1_000,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 7_500,
      maxCallbackAttempts: 5,
    },
    cache: {
      enabled: true,
      maxEntries: 512,
      ttlMs: 120_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: true,
      slowRequestThresholdMs: 1_500,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: 24,
      maxPromptChars: 8_000,
      degradeToMaxTokens: 192,
    },
    promptCompiler: {
      enabled: true,
      collapseWhitespace: true,
      dedupeRepeatedLines: true,
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: false,
      sampleSize: 32,
      queueLatencyThresholdMs: 400,
      minCompletionTokensPerSecond: 18,
      maxOutputReductionRatio: 0.5,
      minOutputTokens: 64,
      learnedFamilyCapEnabled: true,
      familyHistorySize: 64,
      learnedCapMinSamples: 8,
      draftPercentile: 0.95,
      shortPercentile: 0.9,
      learnedCapHeadroomTokens: 24,
    },
    auth: {
      enabled: false,
      apiKeyEnv: "RAY_API_KEYS",
    },
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      maxRequests: 90,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
    tags: {
      target: "vps",
      hosting: "single-node",
    },
  },
  balanced: {
    profile: "balanced",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: 96_000,
    },
    model: {
      id: "mistral-7b-instruct-q4",
      family: "mistral",
      quantization: "q4_k_m",
      contextWindow: 8192,
      warmOnBoot: true,
      maxOutputTokens: 512,
      adapter: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "mistral-7b-instruct-q4_k_m",
        timeoutMs: 25_000,
      },
    },
    scheduler: {
      concurrency: 3,
      maxQueue: 160,
      maxQueuedTokens: 96_000,
      maxInflightTokens: 16_000,
      requestTimeoutMs: 25_000,
      dedupeInflight: true,
      batchWindowMs: 0,
      affinityLookahead: 16,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      pollIntervalMs: 1_000,
      dispatchConcurrency: 2,
      maxAttempts: 3,
      callbackTimeoutMs: 7_500,
      maxCallbackAttempts: 5,
    },
    cache: {
      enabled: true,
      maxEntries: 1024,
      ttlMs: 180_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: true,
      slowRequestThresholdMs: 2_000,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: 40,
      maxPromptChars: 12_000,
      degradeToMaxTokens: 256,
    },
    promptCompiler: {
      enabled: true,
      collapseWhitespace: true,
      dedupeRepeatedLines: true,
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: false,
      sampleSize: 48,
      queueLatencyThresholdMs: 500,
      minCompletionTokensPerSecond: 18,
      maxOutputReductionRatio: 0.4,
      minOutputTokens: 96,
      learnedFamilyCapEnabled: true,
      familyHistorySize: 96,
      learnedCapMinSamples: 10,
      draftPercentile: 0.95,
      shortPercentile: 0.9,
      learnedCapHeadroomTokens: 32,
    },
    auth: {
      enabled: false,
      apiKeyEnv: "RAY_API_KEYS",
    },
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      maxRequests: 180,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
    tags: {
      target: "balanced",
      hosting: "single-node",
    },
  },
};

export function createDefaultConfig(profile: RayProfile): RayConfig {
  return structuredClone(profileDefaults[profile]);
}

export function mergeConfig<T>(base: T, override?: DeepPartial<T>): T {
  if (override === undefined) {
    return structuredClone(base);
  }

  if (Array.isArray(base)) {
    return structuredClone((override as T | undefined) ?? base);
  }

  if (base === null || typeof base !== "object") {
    return (override as T | undefined) ?? base;
  }

  const result: Record<string, unknown> = {};
  const baseRecord = base as Record<string, unknown>;
  const overrideRecord = override as Record<string, unknown>;

  for (const key of Object.keys(baseRecord)) {
    const baseValue = baseRecord[key];
    const overrideValue = overrideRecord[key];

    if (overrideValue === undefined) {
      result[key] = structuredClone(baseValue);
      continue;
    }

    if (
      baseValue !== null &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue) &&
      overrideValue !== null &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue)
    ) {
      result[key] = mergeConfig(baseValue, overrideValue);
      continue;
    }

    result[key] = structuredClone(overrideValue);
  }

  for (const [key, value] of Object.entries(overrideRecord)) {
    if (key in result || value === undefined) {
      continue;
    }

    result[key] = structuredClone(value);
  }

  return result as T;
}
