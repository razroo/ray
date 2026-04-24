import test from "node:test";
import assert from "node:assert/strict";
import { loadRayConfig } from "./index.js";

test("loadRayConfig defaults to the sub1b profile", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    env: {},
  });

  assert.equal(loaded.config.profile, "sub1b");
  assert.equal(loaded.config.model.adapter.kind, "llama.cpp");
});

test("loadRayConfig accepts the cax11 sub1b launch preset", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.sub1b.cax11.json",
    env: {},
  });

  assert.equal(loaded.config.profile, "sub1b");
  assert.equal(loaded.config.scheduler.concurrency, 1);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.preset, "single-vps-sub1b-cax11");
});

test("loadRayConfig accepts the 1b 8gb launch preset", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.1b.8gb.json",
    env: {},
  });

  assert.equal(loaded.config.profile, "1b");
  assert.equal(loaded.config.scheduler.concurrency, 2);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
  assert.equal(loaded.config.model.operational?.memoryClassMiB, 8192);
});
