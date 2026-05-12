import type { LlamaCppLaunchProfile, RayConfig, RayProfile } from "@razroo/ray-core";

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends object
    ? DeepPartial<T[Key]>
    : T[Key] extends Array<infer Item>
      ? Array<DeepPartial<Item>>
      : T[Key];
};

type Sub1bMachineClass = "cx23" | "cax11";
type OneBMachineClass = "cx23" | "8gb";
const unsafeMergeKeys = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD = 0.2;
const MIB = 1024 * 1024;

function createSub1bLaunchProfile(machineClass: Sub1bMachineClass): LlamaCppLaunchProfile {
  if (machineClass === "cax11") {
    return {
      preset: "single-vps-sub1b-cax11",
      binaryPath: "/usr/local/bin/llama-server",
      modelPath: "/var/lib/ray/models/qwen2.5-0.5b-instruct-q4_k_m.gguf",
      host: "127.0.0.1",
      port: 8081,
      alias: "qwen2.5-0.5b-instruct-q4_k_m",
      ctxSize: 3072,
      parallel: 1,
      threads: 2,
      threadsHttp: 2,
      batchSize: 192,
      ubatchSize: 96,
      cachePrompt: true,
      cacheReuse: 256,
      cacheRamMiB: 512,
      continuousBatching: true,
      enableMetrics: true,
      exposeSlots: true,
      warmup: true,
      enableUnifiedKv: true,
      cacheIdleSlots: true,
      contextShift: true,
    };
  }

  return {
    preset: "single-vps-sub1b-cx23",
    binaryPath: "/usr/local/bin/llama-server",
    modelPath: "/var/lib/ray/models/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    host: "127.0.0.1",
    port: 8081,
    alias: "qwen2.5-0.5b-instruct-q4_k_m",
    ctxSize: 3072,
    parallel: 2,
    threads: 2,
    threadsHttp: 2,
    batchSize: 256,
    ubatchSize: 128,
    cachePrompt: true,
    cacheReuse: 256,
    cacheRamMiB: 512,
    continuousBatching: true,
    enableMetrics: true,
    exposeSlots: true,
    warmup: true,
    enableUnifiedKv: true,
    cacheIdleSlots: true,
    contextShift: true,
  };
}

function createSub1bDefaults(machineClass: Sub1bMachineClass): RayConfig {
  const launchProfile = createSub1bLaunchProfile(machineClass);

  return {
    profile: machineClass === "cax11" ? "sub1b-cax11" : "sub1b",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: 48_000,
    },
    model: {
      id: "qwen2.5-0.5b-instruct-q4_k_m",
      family: "qwen2.5",
      quantization: "q4_k_m",
      contextWindow: 8192,
      warmOnBoot: true,
      maxOutputTokens: 256,
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.5b-instruct-q4_k_m",
        timeoutMs: 18_000,
        cachePrompt: true,
        slotStateTtlMs: 200,
        slotSnapshotTimeoutMs: 250,
        promptScaffoldCacheEntries: 256,
        launchProfile,
      },
    },
    scheduler: {
      concurrency: machineClass === "cax11" ? 1 : 2,
      maxQueue: machineClass === "cax11" ? 48 : 64,
      maxQueuedTokens: machineClass === "cax11" ? 18_000 : 24_000,
      maxInflightTokens: machineClass === "cax11" ? 3_072 : 4_096,
      requestTimeoutMs: machineClass === "cax11" ? 22_000 : 20_000,
      dedupeInflight: true,
      batchWindowMs: machineClass === "cax11" ? 5 : 10,
      affinityLookahead: machineClass === "cax11" ? 16 : 24,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      maxJobs: 1_000,
      minFreeStorageMiB: 256,
      completedTtlMs: 86_400_000,
      pollIntervalMs: 1_000,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 5_000,
      maxCallbackAttempts: 5,
      callbackAllowPrivateNetwork: false,
      callbackAllowedHosts: [],
    },
    cache: {
      enabled: true,
      maxEntries: 256,
      maxBytes: 2 * MIB,
      ttlMs: 90_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: true,
      slowRequestThresholdMs: machineClass === "cax11" ? 1_500 : 1_200,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: machineClass === "cax11" ? 12 : 16,
      maxPromptChars: 6_000,
      degradeToMaxTokens: 128,
      memoryRssThresholdMiB: 512,
      cpuThrottledRatioThreshold: DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD,
    },
    promptCompiler: {
      enabled: true,
      collapseWhitespace: true,
      dedupeRepeatedLines: true,
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: true,
      sampleSize: 32,
      queueLatencyThresholdMs: machineClass === "cax11" ? 450 : 350,
      minCompletionTokensPerSecond: machineClass === "cax11" ? 10 : 14,
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
      maxRequests: machineClass === "cax11" ? 90 : 120,
      maxKeys: 4_096,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
    tags: {
      target: "sub1b",
      hosting: "cheap-vps",
      engine: "llama.cpp",
      hardware: machineClass === "cax11" ? "hetzner-cax11-class" : "hetzner-cx23-class",
    },
  };
}

function create1bLaunchProfile(machineClass: OneBMachineClass): LlamaCppLaunchProfile {
  if (machineClass === "8gb") {
    return {
      preset: "single-vps-1b-8gb",
      binaryPath: "/usr/local/bin/llama-server",
      modelPath: "/var/lib/ray/models/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      host: "127.0.0.1",
      port: 8081,
      alias: "qwen2.5-1.5b-instruct-q4_k_m",
      ctxSize: 4096,
      parallel: 2,
      threads: 4,
      threadsBatch: 4,
      threadsHttp: 2,
      batchSize: 256,
      ubatchSize: 128,
      cachePrompt: true,
      cacheReuse: 256,
      cacheRamMiB: 768,
      continuousBatching: true,
      enableMetrics: true,
      exposeSlots: true,
      warmup: true,
      enableUnifiedKv: true,
      cacheIdleSlots: true,
      contextShift: true,
    };
  }

  return {
    preset: "single-vps-1b-cx23",
    binaryPath: "/usr/local/bin/llama-server",
    modelPath: "/var/lib/ray/models/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    host: "127.0.0.1",
    port: 8081,
    alias: "qwen2.5-1.5b-instruct-q4_k_m",
    ctxSize: 2048,
    parallel: 1,
    threads: 2,
    threadsBatch: 2,
    threadsHttp: 2,
    batchSize: 192,
    ubatchSize: 96,
    cachePrompt: true,
    cacheReuse: 192,
    cacheRamMiB: 384,
    continuousBatching: true,
    enableMetrics: true,
    exposeSlots: true,
    warmup: true,
    enableUnifiedKv: true,
    cacheIdleSlots: true,
    contextShift: true,
  };
}

function create1bDefaults(machineClass: OneBMachineClass): RayConfig {
  const launchProfile = create1bLaunchProfile(machineClass);
  const is8gb = machineClass === "8gb";

  return {
    profile: is8gb ? "1b-8gb" : "1b",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: is8gb ? 64_000 : 48_000,
    },
    model: {
      id: "qwen2.5-1.5b-instruct-q4_k_m",
      family: "qwen2.5",
      quantization: "q4_k_m",
      contextWindow: 8192,
      warmOnBoot: true,
      maxOutputTokens: is8gb ? 256 : 192,
      operational: {
        recommendedPromptFormat: "native-template",
        supportsJsonMode: true,
        tokensPerSecondTarget: is8gb ? 18 : 10,
        memoryClassMiB: is8gb ? 8192 : 4096,
        preferredCtxSize: launchProfile.ctxSize,
        chatTemplateKnown: true,
      },
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-1.5b-instruct-q4_k_m",
        timeoutMs: is8gb ? 24_000 : 28_000,
        cachePrompt: true,
        slotStateTtlMs: 250,
        slotSnapshotTimeoutMs: 300,
        promptScaffoldCacheEntries: 384,
        launchProfile,
      },
    },
    scheduler: {
      concurrency: is8gb ? 2 : 1,
      maxQueue: is8gb ? 96 : 40,
      maxQueuedTokens: is8gb ? 48_000 : 18_000,
      maxInflightTokens: is8gb ? 6_144 : 2_560,
      requestTimeoutMs: is8gb ? 28_000 : 32_000,
      dedupeInflight: true,
      batchWindowMs: is8gb ? 10 : 5,
      affinityLookahead: is8gb ? 24 : 12,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      maxJobs: 1_000,
      minFreeStorageMiB: is8gb ? 512 : 256,
      completedTtlMs: 86_400_000,
      pollIntervalMs: 1_000,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 5_000,
      maxCallbackAttempts: 5,
      callbackAllowPrivateNetwork: false,
      callbackAllowedHosts: [],
    },
    cache: {
      enabled: true,
      maxEntries: is8gb ? 512 : 256,
      maxBytes: is8gb ? 4 * MIB : 2 * MIB,
      ttlMs: 120_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: true,
      slowRequestThresholdMs: is8gb ? 1_800 : 2_200,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: is8gb ? 20 : 10,
      maxPromptChars: is8gb ? 8_000 : 5_000,
      degradeToMaxTokens: is8gb ? 160 : 128,
      memoryRssThresholdMiB: is8gb ? 768 : 512,
      cpuThrottledRatioThreshold: DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD,
    },
    promptCompiler: {
      enabled: true,
      collapseWhitespace: true,
      dedupeRepeatedLines: true,
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: true,
      sampleSize: 32,
      queueLatencyThresholdMs: is8gb ? 450 : 600,
      minCompletionTokensPerSecond: is8gb ? 14 : 8,
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
      maxRequests: is8gb ? 150 : 75,
      maxKeys: is8gb ? 8_192 : 4_096,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
    tags: {
      target: "1b",
      hosting: is8gb ? "single-node-8gb" : "cheap-vps",
      engine: "llama.cpp",
      hardware: is8gb ? "8gb-vps-class" : "hetzner-cx23-class",
    },
  };
}

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
      maxJobs: 1_000,
      minFreeStorageMiB: 64,
      completedTtlMs: 86_400_000,
      pollIntervalMs: 500,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 5_000,
      maxCallbackAttempts: 5,
      callbackAllowPrivateNetwork: false,
      callbackAllowedHosts: [],
    },
    cache: {
      enabled: true,
      maxEntries: 128,
      maxBytes: MIB,
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
      memoryRssThresholdMiB: 256,
      cpuThrottledRatioThreshold: DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD,
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
      maxKeys: 2_048,
      keyStrategy: "ip",
      trustProxyHeaders: false,
    },
    tags: {
      target: "tiny",
      hosting: "cheap-vps",
    },
  },
  sub1b: createSub1bDefaults("cx23"),
  "sub1b-cax11": createSub1bDefaults("cax11"),
  "1b": create1bDefaults("cx23"),
  "1b-8gb": create1bDefaults("8gb"),
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
      requestTimeoutMs: 24_000,
      dedupeInflight: true,
      batchWindowMs: 0,
      affinityLookahead: 12,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      maxJobs: 1_000,
      minFreeStorageMiB: 512,
      completedTtlMs: 86_400_000,
      pollIntervalMs: 1_000,
      dispatchConcurrency: 1,
      maxAttempts: 3,
      callbackTimeoutMs: 7_500,
      maxCallbackAttempts: 5,
      callbackAllowPrivateNetwork: false,
      callbackAllowedHosts: [],
    },
    cache: {
      enabled: true,
      maxEntries: 512,
      maxBytes: 4 * MIB,
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
      memoryRssThresholdMiB: 768,
      cpuThrottledRatioThreshold: DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD,
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
      maxKeys: 4_096,
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
      requestTimeoutMs: 30_000,
      dedupeInflight: true,
      batchWindowMs: 0,
      affinityLookahead: 16,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: false,
      storageDir: ".ray/async-queue",
      maxJobs: 2_000,
      minFreeStorageMiB: 1_024,
      completedTtlMs: 86_400_000,
      pollIntervalMs: 1_000,
      dispatchConcurrency: 2,
      maxAttempts: 3,
      callbackTimeoutMs: 7_500,
      maxCallbackAttempts: 5,
      callbackAllowPrivateNetwork: false,
      callbackAllowedHosts: [],
    },
    cache: {
      enabled: true,
      maxEntries: 1024,
      maxBytes: 8 * MIB,
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
      memoryRssThresholdMiB: 1_024,
      cpuThrottledRatioThreshold: DEFAULT_CPU_THROTTLED_RATIO_THRESHOLD,
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
      maxKeys: 8_192,
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
  if (
    typeof profile !== "string" ||
    !Object.prototype.hasOwnProperty.call(profileDefaults, profile)
  ) {
    throw new TypeError("profile must be a supported Ray profile");
  }

  return structuredClone(profileDefaults[profile]);
}

function assertSafeOverrideKeys(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);

  for (const key of Object.keys(value)) {
    if (unsafeMergeKeys.has(key)) {
      throw new TypeError(`override key "${key}" is not allowed`);
    }

    assertSafeOverrideKeys((value as Record<string, unknown>)[key], seen);
  }
}

function mergeConfigValue<T>(base: T, override?: DeepPartial<T>): T {
  if (override === undefined) {
    return structuredClone(base);
  }

  if (Array.isArray(base)) {
    if (!Array.isArray(override)) {
      throw new TypeError("override must be an array when merging array config");
    }

    return structuredClone(override as T);
  }

  if (base === null || typeof base !== "object") {
    return structuredClone(override as T);
  }

  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new TypeError("override must be an object when merging object config");
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

    if (Array.isArray(baseValue)) {
      if (!Array.isArray(overrideValue)) {
        throw new TypeError("override must be an array when merging array config");
      }

      result[key] = structuredClone(overrideValue);
      continue;
    }

    if (baseValue !== null && typeof baseValue === "object" && !Array.isArray(baseValue)) {
      if (
        overrideValue === null ||
        typeof overrideValue !== "object" ||
        Array.isArray(overrideValue)
      ) {
        throw new TypeError("override must be an object when merging object config");
      }

      result[key] = mergeConfigValue(baseValue, overrideValue as DeepPartial<typeof baseValue>);
      continue;
    }

    result[key] = structuredClone(overrideValue);
  }

  for (const [key, value] of Object.entries(overrideRecord)) {
    if (Object.prototype.hasOwnProperty.call(result, key) || value === undefined) {
      continue;
    }

    result[key] = structuredClone(value);
  }

  return result as T;
}

export function mergeConfig<T>(base: T, override?: DeepPartial<T>): T {
  assertSafeOverrideKeys(override);
  return mergeConfigValue(base, override);
}
