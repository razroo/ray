import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig, resolveAuthApiKeys, sanitizeConfig } from "./index.js";

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
    /override key "__proto__" is not allowed/,
  );
  assert.throws(
    () =>
      mergeConfig(
        createDefaultConfig("tiny"),
        JSON.parse('{"model":{"adapter":{"constructor":{"polluted":true}}}}'),
      ),
    /override key "constructor" is not allowed/,
  );
  assert.throws(
    () =>
      mergeConfig(
        createDefaultConfig("tiny"),
        JSON.parse('{"unknown":{"prototype":{"polluted":true}}}'),
      ),
    /override key "prototype" is not allowed/,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("sub1b profile defaults to a bounded llama.cpp launch profile", () => {
  const config = createDefaultConfig("sub1b");

  assert.equal(config.profile, "sub1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(config.model.adapter.launchProfile.preset, "single-vps-sub1b-cx23");
  assert.equal(config.model.adapter.launchProfile.cacheRamMiB, 512);
  assert.equal(config.model.adapter.slotSnapshotTimeoutMs, 250);
  assert.equal(config.asyncQueue.maxJobs, 1_000);
  assert.equal(config.asyncQueue.completedTtlMs, 86_400_000);
  assert.equal(config.gracefulDegradation.memoryRssThresholdMiB, 512);
  assert.equal(config.rateLimit.maxKeys, 4096);
  assert.equal(config.auth.enabled, false);
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
  assert.equal(config.model.adapter.launchProfile.cacheRamMiB, 384);
  assert.equal(config.scheduler.concurrency, 1);
  assert.equal(config.gracefulDegradation.memoryRssThresholdMiB, 512);
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
