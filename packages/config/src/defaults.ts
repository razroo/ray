import type { RayConfig, RayProfile } from "@ray/core";

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
      host: "0.0.0.0",
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
      requestTimeoutMs: 8_000,
      dedupeInflight: true,
      batchWindowMs: 0,
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
    tags: {
      target: "tiny",
      hosting: "cheap-vps",
    },
  },
  vps: {
    profile: "vps",
    server: {
      host: "0.0.0.0",
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
      requestTimeoutMs: 20_000,
      dedupeInflight: true,
      batchWindowMs: 0,
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
    tags: {
      target: "vps",
      hosting: "single-node",
    },
  },
  balanced: {
    profile: "balanced",
    server: {
      host: "0.0.0.0",
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
      requestTimeoutMs: 25_000,
      dedupeInflight: true,
      batchWindowMs: 0,
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
