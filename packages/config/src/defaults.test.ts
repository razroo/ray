import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig, resolveAuthApiKeys, sanitizeConfig } from "./index.js";

const ASYNC_QUEUE_PERSISTED_JOB_FILE_LIMIT_MIB = 2;

function assertDefaultPsiThresholds(config: ReturnType<typeof createDefaultConfig>): void {
  assert.equal(config.gracefulDegradation.memoryCgroupPressureRatioThreshold, 0.9);
  assert.equal(config.gracefulDegradation.memoryPsiSomeAvg10Threshold, 10);
  assert.equal(config.gracefulDegradation.memoryPsiFullAvg10Threshold, 1);
  assert.equal(config.gracefulDegradation.cpuPsiSomeAvg10Threshold, 50);
  assert.equal(config.gracefulDegradation.cpuPsiFullAvg10Threshold, 5);
}

test("createDefaultConfig returns an isolated clone", () => {
  const left = createDefaultConfig("tiny");
  const right = createDefaultConfig("tiny");

  left.server.port = 4444;

  assert.notEqual(left.server.port, right.server.port);
});

test("createDefaultConfig rejects unsupported direct profiles", () => {
  assert.throws(() => createDefaultConfig("cluster" as never), /supported Ray profile/);
});

test("mergeConfig preserves nested defaults while applying overrides", () => {
  const merged = mergeConfig(createDefaultConfig("vps"), {
    model: {
      id: "custom-model",
    },
    scheduler: {
      concurrency: 4,
    },
  });

  assert.equal(merged.model.id, "custom-model");
  assert.equal(merged.model.adapter.kind, "openai-compatible");
  assert.equal(merged.scheduler.concurrency, 4);
  assert.equal(merged.cache.enabled, true);
});

test("mergeConfig snapshots direct override values", () => {
  const override = {
    tags: {
      custom: "initial",
    },
    model: {
      adapter: {
        kind: "mock" as const,
        latencyMs: 1,
        seed: "initial",
      },
    },
  };

  const merged = mergeConfig(createDefaultConfig("tiny"), override);

  override.tags.custom = "mutated";
  override.model.adapter.seed = "mutated";

  assert.equal(merged.tags.custom, "initial");

  if (merged.model.adapter.kind !== "mock") {
    throw new Error("Expected a mock adapter");
  }

  assert.equal(merged.model.adapter.seed, "initial");
});

test("mergeConfig ignores inherited direct override properties", () => {
  const baseline = createDefaultConfig("tiny");
  const override = Object.create({
    server: {
      port: 65535,
    },
    tags: {
      inherited: "ignored",
    },
  });

  const merged = mergeConfig(baseline, override as never);

  assert.equal(merged.server.port, baseline.server.port);
  assert.equal(merged.tags.inherited, undefined);
});

test("mergeConfig preserves unsafe base keys as inert own properties", () => {
  const base: Record<string, unknown> = {
    nested: {
      keep: "base",
    },
  };
  Object.defineProperty(base, "__proto__", {
    value: {
      polluted: true,
    },
    enumerable: true,
  });

  const merged = mergeConfig(base, {
    nested: {
      extra: "override",
    },
  }) as Record<string, unknown>;
  const nested = merged.nested as Record<string, unknown>;

  assert.equal(nested.keep, "base");
  assert.equal(nested.extra, "override");
  assert.deepEqual(Object.getOwnPropertyDescriptor(merged, "__proto__")?.value, {
    polluted: true,
  });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("mergeConfig rejects invalid direct override shapes", () => {
  assert.throws(
    () => mergeConfig(createDefaultConfig("tiny"), null as never),
    /override must be an object/,
  );
  assert.throws(
    () => mergeConfig(createDefaultConfig("tiny"), { model: null } as never),
    /override must be an object/,
  );
  assert.throws(
    () =>
      mergeConfig(createDefaultConfig("tiny"), {
        promptCompiler: {
          familyMetadataKeys: { primary: "promptFamily" },
        },
      } as never),
    /override must be an array/,
  );
});

test("mergeConfig rejects unsafe override keys", () => {
  assert.throws(
    () => mergeConfig(createDefaultConfig("tiny"), JSON.parse('{"__proto__":{"polluted":true}}')),
    /override key "__proto__" is not allowed at __proto__/,
  );
  assert.throws(
    () =>
      mergeConfig(
        createDefaultConfig("tiny"),
        JSON.parse('{"model":{"adapter":{"constructor":{"polluted":true}}}}'),
      ),
    /override key "constructor" is not allowed at model\.adapter\.constructor/,
  );
  assert.throws(
    () =>
      mergeConfig(
        createDefaultConfig("tiny"),
        JSON.parse('{"unknown":{"prototype":{"polluted":true}}}'),
      ),
    /override key "prototype" is not allowed at unknown\.prototype/,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("sub1b profile defaults to a bounded llama.cpp launch profile", () => {
  const config = createDefaultConfig("sub1b");

  assert.equal(config.profile, "sub1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.equal(config.model.operational?.tokensPerSecondTarget, 14);
  assert.equal(config.model.operational?.memoryClassMiB, 4096);
  assert.equal(config.model.operational?.preferredCtxSize, 3072);

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(config.model.adapter.launchProfile.preset, "single-vps-sub1b-cx23");
  assert.equal(config.model.adapter.launchProfile.cacheRamMiB, 512);
  assert.equal(config.model.adapter.slotSnapshotTimeoutMs, 250);
  assert.equal(config.asyncQueue.maxJobs, 128);
  assert.equal(config.asyncQueue.minFreeStorageMiB, 256);
  assert.equal(config.asyncQueue.completedTtlMs, 86_400_000);
  assert.equal(config.cache.maxBytes, 2 * 1024 * 1024);
  assert.equal(config.gracefulDegradation.memoryRssThresholdMiB, 512);
  assert.equal(config.gracefulDegradation.cpuThrottledRatioThreshold, 0.2);
  assertDefaultPsiThresholds(config);
  assert.equal(config.rateLimit.maxKeys, 4096);
  assert.equal(config.auth.enabled, false);
});

test("sub1b-cax11 profile defaults to the ARM single-slot llama.cpp launch profile", () => {
  const config = createDefaultConfig("sub1b-cax11");

  assert.equal(config.profile, "sub1b-cax11");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.equal(config.model.operational?.tokensPerSecondTarget, 10);
  assert.equal(config.model.operational?.memoryClassMiB, 4096);
  assert.equal(config.model.operational?.preferredCtxSize, 3072);

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(config.model.adapter.launchProfile.preset, "single-vps-sub1b-cax11");
  assert.equal(config.model.adapter.launchProfile.parallel, 1);
  assert.equal(config.model.adapter.launchProfile.batchSize, 192);
  assert.equal(config.model.adapter.launchProfile.ubatchSize, 96);
  assert.equal(config.scheduler.concurrency, 1);
  assert.equal(config.scheduler.maxQueue, 48);
  assert.equal(config.scheduler.requestTimeoutMs, 22_000);
  assert.equal(config.telemetry.slowRequestThresholdMs, 1500);
  assert.equal(config.adaptiveTuning.queueLatencyThresholdMs, 450);
  assert.equal(config.adaptiveTuning.minCompletionTokensPerSecond, 10);
  assert.equal(config.rateLimit.maxRequests, 90);
});

test("1b profile defaults to a conservative llama.cpp launch profile", () => {
  const config = createDefaultConfig("1b");

  assert.equal(config.profile, "1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.equal(config.model.operational?.memoryClassMiB, 4096);
  assert.equal(config.model.operational?.supportsJsonMode, true);

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(config.model.adapter.launchProfile.preset, "single-vps-1b-cx23");
  assert.equal(config.model.adapter.launchProfile.parallel, 1);
  assert.equal(config.model.adapter.launchProfile.threadsBatch, 2);
  assert.equal(config.model.adapter.launchProfile.cacheRamMiB, 384);
  assert.equal(config.scheduler.concurrency, 1);
  assert.equal(config.scheduler.maxInflightTokens, 2048);
  assert.equal(config.asyncQueue.minFreeStorageMiB, 256);
  assert.equal(config.cache.maxBytes, 2 * 1024 * 1024);
  assert.equal(config.gracefulDegradation.memoryRssThresholdMiB, 512);
  assert.equal(config.gracefulDegradation.cpuThrottledRatioThreshold, 0.2);
  assertDefaultPsiThresholds(config);
});

test("1b-8gb profile defaults to a roomier llama.cpp launch profile", () => {
  const config = createDefaultConfig("1b-8gb");

  assert.equal(config.profile, "1b-8gb");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.equal(config.model.operational?.memoryClassMiB, 8192);
  assert.equal(config.model.maxOutputTokens, 256);

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
  assert.equal(config.model.adapter.launchProfile.parallel, 2);
  assert.equal(config.model.adapter.launchProfile.threadsBatch, 4);
  assert.equal(config.model.adapter.launchProfile.cacheRamMiB, 768);
  assert.equal(config.scheduler.concurrency, 2);
  assert.equal(config.asyncQueue.minFreeStorageMiB, 512);
  assert.equal(config.telemetry.slowRequestThresholdMs, 1800);
  assert.equal(config.gracefulDegradation.memoryRssThresholdMiB, 768);
  assertDefaultPsiThresholds(config);
  assert.equal(config.adaptiveTuning.queueLatencyThresholdMs, 450);
  assert.equal(config.adaptiveTuning.minCompletionTokensPerSecond, 14);
  assert.equal(config.rateLimit.maxKeys, 8192);
  assert.equal(config.cache.maxBytes, 4 * 1024 * 1024);
});

test("default async queue retention fits the configured storage reserve", () => {
  for (const profile of [
    "tiny",
    "sub1b",
    "sub1b-cax11",
    "1b",
    "1b-8gb",
    "vps",
    "balanced",
  ] as const) {
    const config = createDefaultConfig(profile);

    assert.ok(
      config.asyncQueue.maxJobs * ASYNC_QUEUE_PERSISTED_JOB_FILE_LIMIT_MIB <=
        config.asyncQueue.minFreeStorageMiB,
      `${profile} asyncQueue.maxJobs should fit asyncQueue.minFreeStorageMiB`,
    );
  }
});

test("remote-backend default profiles keep gateway timeouts above adapter timeouts", () => {
  for (const profile of ["sub1b", "sub1b-cax11", "1b", "1b-8gb", "vps", "balanced"] as const) {
    const config = createDefaultConfig(profile);

    if (config.model.adapter.kind === "mock") {
      throw new Error(`Expected ${profile} to use a remote backend adapter`);
    }

    assert.ok(
      config.scheduler.requestTimeoutMs > config.model.adapter.timeoutMs,
      `${profile} scheduler timeout should exceed adapter timeout`,
    );
  }
});

test("single-node default profiles keep prompt and adaptive caps enabled", () => {
  for (const profile of ["sub1b", "sub1b-cax11", "1b", "1b-8gb", "vps", "balanced"] as const) {
    const config = createDefaultConfig(profile);

    assert.equal(config.promptCompiler.enabled, true, `${profile} prompt compiler`);
    assert.equal(config.adaptiveTuning.enabled, true, `${profile} adaptive tuning`);
    assert.equal(
      config.adaptiveTuning.learnedFamilyCapEnabled,
      true,
      `${profile} learned family caps`,
    );
  }
});

test("unauthenticated default profiles use IP rate-limit keys", () => {
  for (const profile of ["sub1b", "sub1b-cax11", "1b", "1b-8gb", "vps", "balanced"] as const) {
    const config = createDefaultConfig(profile);

    assert.equal(config.auth.enabled, false, `${profile} auth`);
    assert.equal(config.rateLimit.keyStrategy, "ip", `${profile} rate-limit key strategy`);
  }
});

test("resolveAuthApiKeys parses comma and newline separated values", () => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
  });

  const keys = resolveAuthApiKeys(config, {
    RAY_API_KEYS: "alpha, beta\ncharlie",
  });

  assert.deepEqual([...keys], ["alpha", "beta", "charlie"]);
});

test("resolveAuthApiKeys bounds retained API key material", () => {
  const config = mergeConfig(createDefaultConfig("tiny"), {
    auth: {
      enabled: true,
    },
  });

  assert.throws(
    () =>
      resolveAuthApiKeys(config, {
        RAY_API_KEYS: Array.from({ length: 129 }, (_value, index) => `key-${index}`).join(","),
      }),
    /RAY_API_KEYS must contain at most 128 API keys/,
  );

  assert.throws(
    () =>
      resolveAuthApiKeys(config, {
        RAY_API_KEYS: "x".repeat(1_025),
      }),
    /RAY_API_KEYS entries must be at most 1024 characters/,
  );

  assert.throws(
    () =>
      resolveAuthApiKeys(config, {
        RAY_API_KEYS: "alpha beta",
      }),
    /RAY_API_KEYS entries must be bearer-token-safe strings without whitespace/,
  );
});

test("sanitizeConfig redacts upstream adapter headers", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        kind: "openai-compatible",
        headers: {
          authorization: "secret",
        },
      },
    },
  });

  const safe = sanitizeConfig(config) as {
    model: {
      adapter: {
        headers: Record<string, string>;
      };
    };
    capabilityHints: {
      modelId: string;
      operational?: unknown;
    };
  };

  assert.equal(safe.model.adapter.headers.authorization, "[redacted]");
  assert.equal(safe.capabilityHints.modelId, "qwen2.5-3b-instruct-q4");
});
