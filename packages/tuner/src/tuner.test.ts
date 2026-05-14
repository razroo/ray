import assert from "node:assert/strict";
import test from "node:test";
import type { RayConfig } from "@razroo/ray-core";
import {
  createLlamaTunerCandidates,
  createTunedRayConfig,
  recommendLlamaTunerCandidate,
} from "./index.js";

function createSub1bConfig(): RayConfig {
  return {
    profile: "sub1b",
    server: {
      host: "127.0.0.1",
      port: 3000,
      requestBodyLimitBytes: 48_000,
    },
    model: {
      id: "razroo-email-ai-qwen0.6b",
      family: "qwen2.5",
      quantization: "q4_k_m",
      contextWindow: 8_192,
      warmOnBoot: true,
      maxOutputTokens: 256,
      operational: {
        recommendedPromptFormat: "native-template",
        supportsJsonMode: true,
        tokensPerSecondTarget: 14,
        memoryClassMiB: 4_096,
        preferredCtxSize: 3_072,
        chatTemplateKnown: true,
      },
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.6b-razroo-email-ai",
        timeoutMs: 18_000,
        cachePrompt: true,
        slotStateTtlMs: 200,
        slotSnapshotTimeoutMs: 250,
        promptScaffoldCacheEntries: 256,
        launchProfile: {
          preset: "single-vps-sub1b-cx23",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: "/var/lib/ray/models/qwen2.5-0.6b-razroo-email-ai.q4_k_m.gguf",
          host: "127.0.0.1",
          port: 8081,
          alias: "qwen2.5-0.6b-razroo-email-ai",
          ctxSize: 3_072,
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
        },
      },
    },
    scheduler: {
      concurrency: 2,
      maxQueue: 64,
      maxQueuedTokens: 24_000,
      maxInflightTokens: 4_096,
      requestTimeoutMs: 20_000,
      dedupeInflight: true,
      batchWindowMs: 10,
      affinityLookahead: 24,
      shortJobMaxTokens: 96,
    },
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      maxJobs: 128,
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
      maxBytes: 2_097_152,
      ttlMs: 90_000,
      keyStrategy: "input+params",
    },
    telemetry: {
      serviceName: "ray-gateway",
      logLevel: "info",
      includeDebugMetrics: true,
      slowRequestThresholdMs: 1_200,
    },
    gracefulDegradation: {
      enabled: true,
      queueDepthThreshold: 16,
      maxPromptChars: 6_000,
      degradeToMaxTokens: 128,
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
      familyMetadataKeys: ["promptFamily", "taskTemplate", "template", "useCase"],
    },
    adaptiveTuning: {
      enabled: true,
      sampleSize: 32,
      queueLatencyThresholdMs: 350,
      minCompletionTokensPerSecond: 14,
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
      enabled: true,
      apiKeyEnv: "RAY_API_KEYS",
    },
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      maxRequests: 120,
      maxKeys: 4_096,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
    tags: {
      target: "sub1b",
      hosting: "cheap-vps",
    },
  };
}

test("createLlamaTunerCandidates generates bounded sub-1B VPS candidates", () => {
  const config = createSub1bConfig();
  const candidates = createLlamaTunerCandidates({
    config,
    host: {
      cpuCount: 2,
      memoryMiB: 4_096,
      architecture: "x64",
      machineClass: "hetzner-cx23",
    },
    target: {
      modelClass: "sub1b",
      goal: "balanced",
      maxCandidates: 12,
    },
  });

  assert.equal(candidates.length, 12);
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
  assert.ok(candidates.every((candidate) => candidate.launchProfile.cachePrompt));
  assert.ok(candidates.every((candidate) => candidate.launchProfile.enableMetrics));
  assert.ok(candidates.every((candidate) => candidate.scheduler.concurrency >= 1));
  assert.ok(candidates.some((candidate) => candidate.launchProfile.parallel === 2));
});

test("recommendLlamaTunerCandidate chooses the fastest stable benchmark observation", () => {
  const config = createSub1bConfig();
  const candidates = createLlamaTunerCandidates({
    config,
    host: {
      cpuCount: 2,
      memoryMiB: 4_096,
    },
    target: {
      maxCandidates: 4,
    },
  });
  const stableFast = candidates[1];
  const unstableFast = candidates[2];

  assert.ok(stableFast);
  assert.ok(unstableFast);

  const recommendation = recommendLlamaTunerCandidate(
    candidates,
    [
      {
        candidateId: candidates[0]?.id ?? "",
        completionTokensPerSecondAvg: 16,
        latencyP95Ms: 1_600,
        ttftP95Ms: 800,
        queueDelayP95Ms: 120,
        qualityPassRate: 95,
      },
      {
        candidateId: stableFast.id,
        completionTokensPerSecondAvg: 20,
        latencyP95Ms: 1_700,
        ttftP95Ms: 850,
        queueDelayP95Ms: 140,
        qualityPassRate: 95,
      },
      {
        candidateId: unstableFast.id,
        completionTokensPerSecondAvg: 26,
        latencyP95Ms: 1_600,
        ttftP95Ms: 800,
        queueDelayP95Ms: 100,
        failureRate: 0.2,
        qualityPassRate: 95,
      },
    ],
    {
      goal: "throughput",
    },
  );

  assert.equal(recommendation.candidate.id, stableFast.id);
  assert.ok(recommendation.score > 0);
});

test("createTunedRayConfig applies tuner launch profile without mutating the source config", () => {
  const config = createSub1bConfig();
  const [candidate] = createLlamaTunerCandidates({
    config,
    host: {
      cpuCount: 2,
      memoryMiB: 4_096,
    },
    target: {
      goal: "latency",
      maxCandidates: 1,
    },
  });

  assert.ok(candidate);

  const tuned = createTunedRayConfig(config, candidate);
  assert.equal(tuned.scheduler.concurrency, candidate.scheduler.concurrency);
  assert.equal(tuned.scheduler.maxInflightTokens, candidate.scheduler.maxInflightTokens);
  assert.equal(tuned.model.adapter.kind, "llama.cpp");
  assert.equal(tuned.model.adapter.launchProfile?.batchSize, candidate.launchProfile.batchSize);
  assert.notEqual(tuned, config);
  assert.equal(config.scheduler.maxInflightTokens, 4_096);
});

test("createLlamaTunerCandidates rejects malformed direct tuner inputs", () => {
  const config = createSub1bConfig();

  assert.throws(
    () =>
      createLlamaTunerCandidates({
        config,
        host: {
          cpuCount: 0,
          memoryMiB: 4_096,
        },
      }),
    /tuner host cpuCount must be a positive safe integer/,
  );

  assert.throws(
    () =>
      createLlamaTunerCandidates({
        config: {
          ...config,
          model: {
            ...config.model,
            adapter: {
              kind: "mock",
              latencyMs: 1,
            },
          },
        },
        host: {
          cpuCount: 2,
          memoryMiB: 4_096,
        },
      }),
    /must use a llama\.cpp adapter/,
  );
});
