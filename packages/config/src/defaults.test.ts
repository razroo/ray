import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "./index.js";

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

