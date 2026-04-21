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
  };

  assert.equal(safe.model.adapter.headers.authorization, "[redacted]");
});
