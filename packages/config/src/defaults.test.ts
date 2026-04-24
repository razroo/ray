import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig, resolveAuthApiKeys, sanitizeConfig } from "./index.js";

test("createDefaultConfig returns an isolated clone", () => {
  const left = createDefaultConfig("tiny");
  const right = createDefaultConfig("tiny");

  left.server.port = 4444;

  assert.notEqual(left.server.port, right.server.port);
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
