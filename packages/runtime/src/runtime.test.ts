import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import type { ModelProvider, ProviderDiagnostics, SchedulerSlotSnapshot } from "@razroo/ray-core";
import { createRayRuntime, readCgroupCpuSnapshot, readCgroupMemorySnapshot } from "./index.js";

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for condition");
}

test("runtime rejects invalid direct config", () => {
  const config = createDefaultConfig("tiny");
  config.scheduler.concurrency = 0;

  assert.throws(() => createRayRuntime(config), /scheduler\.concurrency/);
});

test("runtime snapshots config at construction", async () => {
  let observedInput = "";
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedInput = request.input;
      return {
        output: request.input,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      maxPromptChars: 8,
      queueDepthThreshold: 1_000,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  config.gracefulDegradation.maxPromptChars = 1_000;

  const result = await runtime.infer({
    input: "x".repeat(32),
    cache: false,
  });

  assert.equal(observedInput.length, 8);
  assert.equal(result.degraded, true);
  assert.equal(runtime.config.gracefulDegradation.maxPromptChars, 8);
});

test("runtime deduplicates successful provider warmup work", async () => {
  let warmCalls = 0;
  let releaseWarm: (() => void) | undefined;
  const blockedWarm = new Promise<void>((resolve) => {
    releaseWarm = resolve;
  });
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "warm-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async warm() {
      warmCalls += 1;
      await blockedWarm;
    },
    async infer(request) {
      return {
        output: request.input,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    model: {
      warmOnBoot: true,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  const first = runtime.warm();
  const second = runtime.warm();
  await waitForCondition(() => warmCalls === 1);

  const warmingHealth = await runtime.health();
  assert.equal(warmingHealth.status, "degraded");
  assert.equal(warmingHealth.provider.status, "warming");

  releaseWarm?.();
  await Promise.all([first, second]);
  await runtime.warm();

  const readyHealth = await runtime.health();
  assert.equal(warmCalls, 1);
  assert.equal(readyHealth.status, "ok");
  assert.equal(readyHealth.provider.status, "ready");
});

test("runtime reports warming while provider health is ready during warmup", async () => {
  let warmCalls = 0;
  let healthCalls = 0;
  let releaseWarm: (() => void) | undefined;
  const blockedWarm = new Promise<void>((resolve) => {
    releaseWarm = resolve;
  });
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "provider-health-warm-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async warm() {
      warmCalls += 1;
      await blockedWarm;
    },
    async health() {
      healthCalls += 1;
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
        details: {
          backend: "ready",
        },
      };
    },
    async infer(request) {
      return {
        output: request.input,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    model: {
      warmOnBoot: true,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  const warm = runtime.warm();
  await waitForCondition(() => warmCalls === 1);

  const warmingHealth = await runtime.health();
  assert.equal(warmingHealth.status, "degraded");
  assert.equal(warmingHealth.provider.status, "warming");
  assert.equal(warmingHealth.provider.details?.backend, "ready");
  assert.equal(warmingHealth.provider.details?.rayWarmupStatus, "warming");

  releaseWarm?.();
  await warm;

  const readyHealth = await runtime.health();
  assert.equal(healthCalls, 1);
  assert.equal(readyHealth.status, "ok");
  assert.equal(readyHealth.provider.status, "ready");
});

test("runtime retries provider warmup after a failed attempt", async () => {
  let warmCalls = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "retry-warm-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async warm() {
      warmCalls += 1;
      if (warmCalls === 1) {
        throw new Error("backend still starting");
      }
    },
    async infer(request) {
      return {
        output: request.input,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    model: {
      warmOnBoot: true,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  await assert.rejects(() => runtime.warm(), /backend still starting/);
  const failedHealth = await runtime.health();
  assert.equal(failedHealth.status, "unavailable");
  assert.equal(failedHealth.provider.status, "unavailable");

  await runtime.warm();
  const readyHealth = await runtime.health();
  assert.equal(warmCalls, 2);
  assert.equal(readyHealth.status, "ok");
  assert.equal(readyHealth.provider.status, "ready");
});

test("runtime clamps output under configured process RSS pressure", async () => {
  let observedMaxTokens = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "memory-pressure-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens = request.maxTokens;
      return {
        output: "degraded",
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      degradeToMaxTokens: 32,
      memoryRssThresholdMiB: 1,
    },
  });
  const runtime = createRayRuntime(config, {
    provider,
    memoryUsage: () => ({
      rss: 2 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
  });

  const result = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
    cache: false,
  });
  const health = await runtime.health();
  const metrics = runtime.metricsSnapshot();

  assert.equal(observedMaxTokens, 32);
  assert.equal(result.degraded, true);
  assert.equal(result.diagnostics?.degradation?.applied, true);
  assert.deepEqual(result.diagnostics?.degradation?.reasons, ["memory_pressure"]);
  assert.equal(result.diagnostics?.degradation?.processRssMiB, 2);
  assert.equal(result.diagnostics?.degradation?.memoryRssThresholdMiB, 1);
  assert.equal(result.diagnostics?.degradation?.processRssPressureRatio, 2);
  assert.equal(health.status, "degraded");
  assert.equal(health.runtime?.memory.degraded, true);
  assert.deepEqual(health.runtime?.memory.sources, ["process_rss"]);
  assert.equal(health.runtime?.memory.processRssMiB, 2);
  assert.equal(health.runtime?.memory.memoryRssThresholdMiB, 1);
  assert.equal(health.runtime?.memory.processRssPressureRatio, 2);
  assert.equal(metrics.gauges["process.memory.rss_pressure_ratio"], 2);
  assert.equal(metrics.gauges["process.memory.pressure"], 1);
});

test("runtime clamps output under cgroup memory pressure", async () => {
  let observedMaxTokens = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "cgroup-pressure-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens = request.maxTokens;
      return {
        output: "degraded",
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      degradeToMaxTokens: 32,
      memoryRssThresholdMiB: 4_096,
    },
  });
  const runtime = createRayRuntime(config, {
    provider,
    memoryUsage: () => ({
      rss: 32 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
    cgroupMemory: () => ({
      currentMiB: 950,
      highMiB: 900,
      limitMiB: 1_000,
      pressureRatio: 0.95,
      swapCurrentMiB: 128,
      swapLimitMiB: 256,
      swapPressureRatio: 0.5,
      highEvents: 3,
      maxEvents: 2,
      oomEvents: 1,
      oomKillEvents: 0,
    }),
  });

  const result = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
    cache: false,
  });
  const health = await runtime.health();
  const metrics = runtime.metricsSnapshot();

  assert.equal(observedMaxTokens, 32);
  assert.equal(result.degraded, true);
  assert.equal(result.diagnostics?.degradation?.applied, true);
  assert.deepEqual(result.diagnostics?.degradation?.reasons, ["memory_pressure"]);
  assert.deepEqual(result.diagnostics?.degradation?.memoryPressureSources, ["cgroup"]);
  assert.equal(result.diagnostics?.degradation?.processRssMiB, 32);
  assert.equal(result.diagnostics?.degradation?.processRssPressureRatio, 0.0078);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryCurrentMiB, 950);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryHighMiB, 900);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryLimitMiB, 1_000);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryPressureRatio, 0.95);
  assert.equal(result.diagnostics?.degradation?.cgroupMemorySwapCurrentMiB, 128);
  assert.equal(result.diagnostics?.degradation?.cgroupMemorySwapLimitMiB, 256);
  assert.equal(result.diagnostics?.degradation?.cgroupMemorySwapPressureRatio, 0.5);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryHighEvents, 3);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryMaxEvents, 2);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryOomEvents, 1);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryOomKillEvents, 0);
  assert.equal(health.status, "degraded");
  assert.equal(health.runtime?.queue.degraded, false);
  assert.equal(health.runtime?.queue.depth, 0);
  assert.equal(health.runtime?.queue.depthRatio, 0);
  assert.equal(health.runtime?.queue.shortDepth, 0);
  assert.equal(health.runtime?.queue.draftDepth, 0);
  assert.equal(health.runtime?.queue.threshold, config.gracefulDegradation.queueDepthThreshold);
  assert.equal(health.runtime?.queue.maxQueue, config.scheduler.maxQueue);
  assert.equal(health.runtime?.queue.inFlight, 0);
  assert.equal(health.runtime?.queue.inFlightRatio, 0);
  assert.equal(health.runtime?.queue.concurrency, config.scheduler.concurrency);
  assert.equal(health.runtime?.queue.queuedTokens, 0);
  assert.equal(health.runtime?.queue.queuedTokensRatio, 0);
  assert.equal(health.runtime?.queue.maxQueuedTokens, config.scheduler.maxQueuedTokens);
  assert.equal(health.runtime?.queue.inFlightTokens, 0);
  assert.equal(health.runtime?.queue.inFlightTokensRatio, 0);
  assert.equal(health.runtime?.queue.maxInflightTokens, config.scheduler.maxInflightTokens);
  assert.equal(health.runtime?.memory.degraded, true);
  assert.deepEqual(health.runtime?.memory.sources, ["cgroup"]);
  assert.equal(health.runtime?.memory.processRssMiB, 32);
  assert.equal(health.runtime?.memory.processRssPressureRatio, 0.0078);
  assert.equal(health.runtime?.memory.cgroupMemoryCurrentMiB, 950);
  assert.equal(health.runtime?.memory.cgroupMemoryHighMiB, 900);
  assert.equal(health.runtime?.memory.cgroupMemoryLimitMiB, 1_000);
  assert.equal(health.runtime?.memory.cgroupMemoryPressureRatio, 0.95);
  assert.equal(health.runtime?.memory.cgroupMemorySwapCurrentMiB, 128);
  assert.equal(health.runtime?.memory.cgroupMemorySwapLimitMiB, 256);
  assert.equal(health.runtime?.memory.cgroupMemorySwapPressureRatio, 0.5);
  assert.equal(health.runtime?.memory.cgroupMemoryHighEvents, 3);
  assert.equal(health.runtime?.memory.cgroupMemoryMaxEvents, 2);
  assert.equal(health.runtime?.memory.cgroupMemoryOomEvents, 1);
  assert.equal(health.runtime?.memory.cgroupMemoryOomKillEvents, 0);
  assert.equal(metrics.gauges["process.memory.cgroup_current_mib"], 950);
  assert.equal(metrics.gauges["process.memory.cgroup_high_mib"], 900);
  assert.equal(metrics.gauges["process.memory.cgroup_limit_mib"], 1_000);
  assert.equal(metrics.gauges["process.memory.cgroup_pressure_ratio"], 0.95);
  assert.equal(metrics.gauges["process.memory.cgroup_pressure"], 1);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_current_mib"], 128);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_limit_mib"], 256);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_pressure_ratio"], 0.5);
  assert.equal(metrics.gauges["process.memory.cgroup_high_events"], 3);
  assert.equal(metrics.gauges["process.memory.cgroup_max_events"], 2);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_events"], 1);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_kill_events"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_event_pressure"], 0);
  assert.equal(metrics.gauges["process.memory.rss_pressure_ratio"], 0.0078);
  assert.equal(metrics.gauges["process.memory.pressure"], 1);
});

test("runtime treats recent cgroup memory events as pressure", async () => {
  let observedMaxTokens = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "cgroup-event-pressure-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens = request.maxTokens;
      return {
        output: "degraded",
      };
    },
  };
  const snapshots = [
    {
      currentMiB: 500,
      highMiB: 800,
      limitMiB: 1_000,
      pressureRatio: 0.625,
      highEvents: 1,
      maxEvents: 0,
      oomEvents: 0,
      oomKillEvents: 0,
    },
    {
      currentMiB: 500,
      highMiB: 800,
      limitMiB: 1_000,
      pressureRatio: 0.625,
      highEvents: 3,
      maxEvents: 1,
      oomEvents: 1,
      oomKillEvents: 0,
    },
  ];
  let snapshotIndex = 0;
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      degradeToMaxTokens: 32,
      memoryRssThresholdMiB: 4_096,
    },
  });
  const runtime = createRayRuntime(config, {
    provider,
    memoryUsage: () => ({
      rss: 32 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
    cgroupMemory: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    cgroupCpu: false,
  });

  const initialHealth = await runtime.health();
  assert.equal(initialHealth.status, "ok");
  assert.equal(initialHealth.runtime?.memory.degraded, false);
  assert.deepEqual(initialHealth.runtime?.memory.sources, []);

  await new Promise((resolve) => setTimeout(resolve, 300));

  const result = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
    cache: false,
  });
  const health = await runtime.health();
  const metrics = runtime.metricsSnapshot();

  assert.equal(observedMaxTokens, 32);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.diagnostics?.degradation?.reasons, ["memory_pressure"]);
  assert.deepEqual(result.diagnostics?.degradation?.memoryPressureSources, ["cgroup"]);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryPressureRatio, 0.625);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryHighEventsDelta, 2);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryMaxEventsDelta, 1);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryOomEventsDelta, 1);
  assert.equal(result.diagnostics?.degradation?.cgroupMemoryOomKillEventsDelta, 0);
  assert.equal(health.status, "degraded");
  assert.equal(health.runtime?.memory.degraded, true);
  assert.deepEqual(health.runtime?.memory.sources, ["cgroup"]);
  assert.equal(health.runtime?.memory.cgroupMemoryHighEventsDelta, 2);
  assert.equal(health.runtime?.memory.cgroupMemoryMaxEventsDelta, 1);
  assert.equal(health.runtime?.memory.cgroupMemoryOomEventsDelta, 1);
  assert.equal(health.runtime?.memory.cgroupMemoryOomKillEventsDelta, 0);
  assert.equal(metrics.gauges["process.memory.cgroup_high_events_delta"], 2);
  assert.equal(metrics.gauges["process.memory.cgroup_max_events_delta"], 1);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_events_delta"], 1);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_kill_events_delta"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_event_pressure"], 1);
  assert.equal(metrics.gauges["process.memory.pressure"], 1);
});

test("runtime clamps output under cgroup CPU throttling", async () => {
  let observedMaxTokens = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "cpu-pressure-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens = request.maxTokens;
      return {
        output: "degraded",
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      degradeToMaxTokens: 32,
      memoryRssThresholdMiB: 4_096,
      cpuThrottledRatioThreshold: 0.24,
    },
  });
  const runtime = createRayRuntime(config, {
    provider,
    cgroupMemory: false,
    memoryUsage: () => ({
      rss: 32 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
    cgroupCpu: () => ({
      quotaUsec: 50_000,
      periodUsec: 100_000,
      quotaCores: 0.5,
      periods: 100,
      throttledPeriods: 25,
      throttledUsec: 150_000,
      throttledRatio: 0.25,
    }),
  });

  const result = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
    cache: false,
  });
  const health = await runtime.health();
  const metrics = runtime.metricsSnapshot();

  assert.equal(observedMaxTokens, 32);
  assert.equal(result.degraded, true);
  assert.equal(result.diagnostics?.degradation?.applied, true);
  assert.deepEqual(result.diagnostics?.degradation?.reasons, ["cpu_pressure"]);
  assert.equal(result.diagnostics?.degradation?.cgroupCpuThrottledRatio, 0.25);
  assert.equal(result.diagnostics?.degradation?.cgroupCpuThrottledThreshold, 0.24);
  assert.equal(health.status, "degraded");
  assert.equal(health.runtime?.cpu?.degraded, true);
  assert.equal(health.runtime?.cpu?.cgroupCpuQuotaCores, 0.5);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledRatio, 0.25);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledThreshold, 0.24);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_ratio"], 0.25);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_threshold"], 0.24);
  assert.equal(metrics.gauges["process.cpu.pressure"], 1);
});

test("runtime health exposes queue saturation ratios", async () => {
  let inferenceStarts = 0;
  const releaseHandlers: Array<() => void> = [];
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "queue-ratio-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer() {
      inferenceStarts += 1;
      await new Promise<void>((resolve) => {
        releaseHandlers.push(resolve);
      });

      return { output: "ok" };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    model: {
      maxOutputTokens: 96,
    },
    scheduler: {
      concurrency: 1,
      maxQueue: 4,
      maxQueuedTokens: 100,
      maxInflightTokens: 100,
      requestTimeoutMs: 2_000,
      affinityLookahead: 4,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  const first = runtime.infer({ input: "ping", maxTokens: 10, cache: false });
  await waitForCondition(() => inferenceStarts === 1);

  const second = runtime.infer({ input: "pong", maxTokens: 10, cache: false });
  let health = await runtime.health();
  await waitForCondition(async () => {
    health = await runtime.health();
    return health.runtime?.queue.depth === 1 && health.runtime.queue.inFlight === 1;
  });

  assert.equal(health.runtime?.queue.depth, 1);
  assert.equal(health.runtime?.queue.depthRatio, 0.25);
  assert.equal(health.runtime?.queue.inFlight, 1);
  assert.equal(health.runtime?.queue.inFlightRatio, 1);
  assert.equal(health.runtime?.queue.queuedTokens, 11);
  assert.equal(health.runtime?.queue.queuedTokensRatio, 0.11);
  assert.equal(health.runtime?.queue.inFlightTokens, 11);
  assert.equal(health.runtime?.queue.inFlightTokensRatio, 0.11);

  releaseHandlers.shift()?.();
  await first;
  await waitForCondition(() => inferenceStarts === 2 && releaseHandlers.length > 0);
  releaseHandlers.shift()?.();
  await second;
});

test("readCgroupMemorySnapshot reads unified cgroup memory files", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-memory-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray.slice", "ray-gateway.service");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "0::/ray.slice/ray-gateway.service\n", "utf8");
  await writeFile(join(cgroupDir, "memory.current"), String(760 * 1024 * 1024), "utf8");
  await writeFile(join(cgroupDir, "memory.high"), String(800 * 1024 * 1024), "utf8");
  await writeFile(join(cgroupDir, "memory.max"), String(1_000 * 1024 * 1024), "utf8");
  await writeFile(join(cgroupDir, "memory.swap.current"), String(128 * 1024 * 1024), "utf8");
  await writeFile(join(cgroupDir, "memory.swap.max"), String(512 * 1024 * 1024), "utf8");
  await writeFile(
    join(cgroupDir, "memory.events"),
    "low 0\nhigh 7\nmax 2\noom 1\noom_kill 0\noom_group_kill 0\n",
    "utf8",
  );

  const snapshot = await readCgroupMemorySnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV2Root: tempDir,
  });

  assert.equal(snapshot?.currentMiB, 760);
  assert.equal(snapshot?.highMiB, 800);
  assert.equal(snapshot?.limitMiB, 1_000);
  assert.equal(snapshot?.pressureRatio, 0.95);
  assert.equal(snapshot?.swapCurrentMiB, 128);
  assert.equal(snapshot?.swapLimitMiB, 512);
  assert.equal(snapshot?.swapPressureRatio, 0.25);
  assert.equal(snapshot?.highEvents, 7);
  assert.equal(snapshot?.maxEvents, 2);
  assert.equal(snapshot?.oomEvents, 1);
  assert.equal(snapshot?.oomKillEvents, 0);
});

test("readCgroupMemorySnapshot falls back to memory.max when memory.high is unlimited", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-memory-max-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray.slice", "ray-gateway.service");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "0::/ray.slice/ray-gateway.service\n", "utf8");
  await writeFile(join(cgroupDir, "memory.current"), String(900 * 1024 * 1024), "utf8");
  await writeFile(join(cgroupDir, "memory.high"), "max\n", "utf8");
  await writeFile(join(cgroupDir, "memory.max"), String(1_000 * 1024 * 1024), "utf8");

  const snapshot = await readCgroupMemorySnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV2Root: tempDir,
  });

  assert.equal(snapshot?.currentMiB, 900);
  assert.equal(snapshot?.highMiB, undefined);
  assert.equal(snapshot?.limitMiB, 1_000);
  assert.equal(snapshot?.pressureRatio, 0.9);
  assert.equal(snapshot?.highEvents, undefined);
  assert.equal(snapshot?.maxEvents, undefined);
  assert.equal(snapshot?.oomEvents, undefined);
  assert.equal(snapshot?.oomKillEvents, undefined);
});

test("readCgroupMemorySnapshot skips oversized cgroup memory files", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-memory-oversized-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray.slice", "ray-gateway.service");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "0::/ray.slice/ray-gateway.service\n", "utf8");
  await writeFile(join(cgroupDir, "memory.current"), "7".repeat(64 * 1024 + 1), "utf8");
  await writeFile(join(cgroupDir, "memory.max"), String(1_000 * 1024 * 1024), "utf8");

  const snapshot = await readCgroupMemorySnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV2Root: tempDir,
  });

  assert.equal(snapshot, undefined);
});

test("readCgroupCpuSnapshot reads unified cgroup cpu.stat files", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-cpu-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray.slice", "ray-gateway.service");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "0::/ray.slice/ray-gateway.service\n", "utf8");
  await writeFile(
    join(cgroupDir, "cpu.stat"),
    "usage_usec 1000000\nuser_usec 700000\nsystem_usec 300000\nnr_periods 100\nnr_throttled 12\nthrottled_usec 45000\n",
    "utf8",
  );
  await writeFile(join(cgroupDir, "cpu.max"), "50000 100000\n", "utf8");

  const snapshot = await readCgroupCpuSnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV2Root: tempDir,
  });

  assert.equal(snapshot?.usageUsec, 1_000_000);
  assert.equal(snapshot?.userUsec, 700_000);
  assert.equal(snapshot?.systemUsec, 300_000);
  assert.equal(snapshot?.quotaUsec, 50_000);
  assert.equal(snapshot?.periodUsec, 100_000);
  assert.equal(snapshot?.quotaCores, 0.5);
  assert.equal(snapshot?.periods, 100);
  assert.equal(snapshot?.throttledPeriods, 12);
  assert.equal(snapshot?.throttledUsec, 45_000);
  assert.equal(snapshot?.throttledRatio, 0.12);
});

test("readCgroupCpuSnapshot reads legacy cgroup cpu.stat throttling", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-cpu-v1-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray", "gateway");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "4:cpu,cpuacct:/ray/gateway\n", "utf8");
  await writeFile(
    join(cgroupDir, "cpu.stat"),
    "nr_periods 80\nnr_throttled 20\nthrottled_time 250000000\n",
    "utf8",
  );
  await writeFile(join(cgroupDir, "cpu.cfs_quota_us"), "200000\n", "utf8");
  await writeFile(join(cgroupDir, "cpu.cfs_period_us"), "100000\n", "utf8");

  const snapshot = await readCgroupCpuSnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV1CpuRoot: tempDir,
  });

  assert.equal(snapshot?.usageUsec, undefined);
  assert.equal(snapshot?.quotaUsec, 200_000);
  assert.equal(snapshot?.periodUsec, 100_000);
  assert.equal(snapshot?.quotaCores, 2);
  assert.equal(snapshot?.periods, 80);
  assert.equal(snapshot?.throttledPeriods, 20);
  assert.equal(snapshot?.throttledUsec, 250_000);
  assert.equal(snapshot?.throttledRatio, 0.25);
});

test("readCgroupCpuSnapshot skips oversized cgroup cpu files", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-cgroup-cpu-oversized-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const cgroupDir = join(tempDir, "ray.slice", "ray-gateway.service");
  const procCgroupPath = join(tempDir, "self-cgroup");

  await mkdir(cgroupDir, { recursive: true });
  await writeFile(procCgroupPath, "0::/ray.slice/ray-gateway.service\n", "utf8");
  await writeFile(join(cgroupDir, "cpu.stat"), "usage_usec ".concat("1".repeat(64 * 1024)), "utf8");
  await writeFile(join(cgroupDir, "cpu.max"), "5".repeat(64 * 1024 + 1), "utf8");

  const snapshot = await readCgroupCpuSnapshot({
    procSelfCgroupPath: procCgroupPath,
    cgroupV2Root: tempDir,
  });

  assert.equal(snapshot, undefined);
});

test("runtime collected metrics refresh live queue and cgroup pressure gauges", async () => {
  const config = createDefaultConfig("tiny");
  const runtime = createRayRuntime(config, {
    memoryUsage: () => ({
      rss: 32 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }),
    cgroupMemory: () => ({
      currentMiB: 700,
      highMiB: 800,
      limitMiB: 1_000,
      pressureRatio: 0.875,
      swapCurrentMiB: 64,
      swapLimitMiB: 512,
      swapPressureRatio: 0.125,
      highEvents: 2,
      maxEvents: 0,
      oomEvents: 0,
      oomKillEvents: 0,
    }),
    cgroupCpu: () => ({
      usageUsec: 2_000_000,
      userUsec: 1_500_000,
      systemUsec: 500_000,
      quotaUsec: 50_000,
      periodUsec: 100_000,
      quotaCores: 0.5,
      periods: 200,
      throttledPeriods: 10,
      throttledUsec: 25_000,
      throttledRatio: 0.05,
    }),
  });

  const metrics = await runtime.collectMetricsSnapshot();

  assert.equal(metrics.gauges["queue.depth"], 0);
  assert.equal(metrics.gauges["queue.max_depth"], config.scheduler.maxQueue);
  assert.equal(metrics.gauges["queue.depth_ratio"], 0);
  assert.equal(metrics.gauges["queue.tokens"], 0);
  assert.equal(metrics.gauges["queue.max_tokens"], config.scheduler.maxQueuedTokens);
  assert.equal(metrics.gauges["queue.tokens_ratio"], 0);
  assert.equal(metrics.gauges["inference.in_flight"], 0);
  assert.equal(metrics.gauges["inference.concurrency"], config.scheduler.concurrency);
  assert.equal(metrics.gauges["inference.in_flight_ratio"], 0);
  assert.equal(metrics.gauges["inference.max_inflight_tokens"], config.scheduler.maxInflightTokens);
  assert.equal(metrics.gauges["inference.in_flight_tokens_ratio"], 0);
  assert.equal(metrics.gauges["cache.entries"], 0);
  assert.equal(metrics.gauges["cache.max_entries"], config.cache.maxEntries);
  assert.equal(metrics.gauges["cache.entries_ratio"], 0);
  assert.equal(metrics.gauges["cache.bytes"], 0);
  assert.equal(metrics.gauges["cache.max_bytes"], config.cache.maxBytes);
  assert.equal(metrics.gauges["cache.bytes_ratio"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_current_mib"], 700);
  assert.equal(metrics.gauges["process.memory.cgroup_high_mib"], 800);
  assert.equal(metrics.gauges["process.memory.cgroup_limit_mib"], 1_000);
  assert.equal(metrics.gauges["process.memory.cgroup_pressure_ratio"], 0.875);
  assert.equal(metrics.gauges["process.memory.cgroup_pressure"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_current_mib"], 64);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_limit_mib"], 512);
  assert.equal(metrics.gauges["process.memory.cgroup_swap_pressure_ratio"], 0.125);
  assert.equal(metrics.gauges["process.memory.rss_pressure_ratio"], 0.125);
  assert.equal(metrics.gauges["process.memory.cgroup_high_events"], 2);
  assert.equal(metrics.gauges["process.memory.cgroup_max_events"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_events"], 0);
  assert.equal(metrics.gauges["process.memory.cgroup_oom_kill_events"], 0);
  assert.equal(metrics.gauges["process.cpu.cgroup_usage_usec"], 2_000_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_user_usec"], 1_500_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_system_usec"], 500_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_quota_usec"], 50_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_period_usec"], 100_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_quota_cores"], 0.5);
  assert.equal(metrics.gauges["process.cpu.cgroup_periods"], 200);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_periods"], 10);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_usec"], 25_000);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_ratio"], 0.05);
  assert.equal(metrics.gauges["process.cpu.cgroup_throttled_threshold"], 0.2);
  assert.equal(metrics.gauges["process.cpu.pressure"], 0);
});

test("runtime health exposes cgroup CPU throttling", async () => {
  const runtime = createRayRuntime(createDefaultConfig("tiny"), {
    cgroupCpu: () => ({
      usageUsec: 4_000_000,
      userUsec: 3_000_000,
      systemUsec: 1_000_000,
      quotaUsec: 100_000,
      periodUsec: 100_000,
      quotaCores: 1,
      periods: 400,
      throttledPeriods: 80,
      throttledUsec: 125_000,
      throttledRatio: 0.1,
    }),
  });

  const health = await runtime.health();

  assert.equal(health.status, "ok");
  assert.equal(health.runtime?.cpu?.degraded, false);
  assert.equal(health.runtime?.cpu?.cgroupCpuUsageUsec, 4_000_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuUserUsec, 3_000_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuSystemUsec, 1_000_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuQuotaUsec, 100_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuPeriodUsec, 100_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuQuotaCores, 1);
  assert.equal(health.runtime?.cpu?.cgroupCpuPeriods, 400);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledPeriods, 80);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledUsec, 125_000);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledRatio, 0.1);
  assert.equal(health.runtime?.cpu?.cgroupCpuThrottledThreshold, 0.2);
});

test("runtime evaluates cgroup CPU throttling from recent counter deltas", async () => {
  const snapshots = [
    {
      periods: 100,
      throttledPeriods: 60,
      throttledRatio: 0.6,
    },
    {
      periods: 200,
      throttledPeriods: 61,
      throttledRatio: 0.305,
    },
  ];
  let snapshotIndex = 0;
  const runtime = createRayRuntime(createDefaultConfig("tiny"), {
    cgroupCpu: () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
  });

  const initialHealth = await runtime.health();
  assert.equal(initialHealth.status, "degraded");
  assert.equal(initialHealth.runtime?.cpu?.cgroupCpuThrottledRatio, 0.6);

  await new Promise((resolve) => setTimeout(resolve, 300));

  const recoveredHealth = await runtime.health();
  assert.equal(recoveredHealth.status, "ok");
  assert.equal(recoveredHealth.runtime?.cpu?.degraded, false);
  assert.equal(recoveredHealth.runtime?.cpu?.cgroupCpuThrottledRatio, 0.01);
});

test("runtime returns chars and provider token usage explicitly", async () => {
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer() {
      return {
        output: "done",
        usage: {
          tokens: {
            prompt: 11,
            completion: 7,
            total: 18,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });
  const result = await runtime.infer({
    input: "hello world",
  });

  assert.deepEqual(result.usage.tokens, {
    prompt: 11,
    completion: 7,
    total: 18,
  });
  assert.deepEqual(result.usage.chars, {
    prompt: 11,
    completion: 4,
    total: 15,
  });
});

test("runtime rejects malformed provider usage counts before caching", async () => {
  let inferCalls = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "bad-usage-counts-model",
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer() {
      inferCalls += 1;
      return {
        output: "done",
        usage:
          inferCalls === 1
            ? {
                tokens: {
                  prompt: 1.5,
                },
              }
            : {
                chars: {
                  total: 1_000_000_001,
                },
              },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      assert.equal(
        (error as { details?: { field?: string } }).details?.field,
        "usage.tokens.prompt",
      );
      return true;
    },
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      assert.equal((error as { details?: { field?: string } }).details?.field, "usage.chars.total");
      return true;
    },
  );

  assert.equal(inferCalls, 2);
});

test("runtime bounds retained provider model identifiers", async () => {
  let inferCalls = 0;
  const oversizedModelId = `model-${"x".repeat(700)}`;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: oversizedModelId,
    capabilities: {
      streaming: false,
      quantized: false,
      localBackend: true,
    },
    async infer() {
      inferCalls += 1;
      return {
        output: "done",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });
  const first = await runtime.infer({
    input: "hello world",
  });
  const second = await runtime.infer({
    input: "hello world",
  });
  const health = await runtime.health();

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(inferCalls, 1);
  assert.equal(first.model.length, 512);
  assert.equal(second.model, first.model);
  assert.equal(health.modelId, first.model);
  assert.notEqual(first.model, oversizedModelId);
  assert.match(first.model, /\[truncated \d+ chars\]$/);
});

test("runtime health reports upstream unavailability", async () => {
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        details: {
          message: "backend offline",
        },
      };
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const health = await runtime.health();

  assert.equal(health.status, "unavailable");
  assert.equal(health.provider.status, "unavailable");
});

test("runtime bounds provider health snapshots before caching", async () => {
  let calls = 0;
  const details: Record<string, unknown> = {
    message: "x".repeat(9_000),
    list: Array.from({ length: 70 }, (_entry, index) => index),
  };
  const longKey = `k${"x".repeat(140)}`;
  details[longKey] = "bounded-key";
  details.self = details;
  Object.defineProperty(details, "explode", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      calls += 1;
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
        latencyMs: 12,
        detectedCapabilities: {
          applyTemplate: "available",
          chatTemplate: "unknown",
          jsonMode: "available",
          backendModel: "m".repeat(700),
          contextWindow: 4096,
          totalSlots: 2,
          errors: {
            props: "p".repeat(9_000),
            [longKey]: "capability-key",
          },
        },
        details,
      };
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const health = await runtime.health();

  assert.equal(health.status, "ok");
  assert.equal(health.provider.status, "ready");
  assert.match(String(health.provider.details?.message), /\[truncated 808 chars\]$/);
  assert.equal(health.provider.details?.self, "[Circular]");
  assert.match(String(health.provider.details?.explode), /^\[Thrown:/);
  assert.equal((health.provider.details?.list as unknown[]).length, 65);
  assert.equal(
    health.provider.details?.[`k${"x".repeat(104)}...[truncated 36 chars]`],
    "bounded-key",
  );
  assert.ok(Object.keys(health.provider.details ?? {}).every((key) => key.length <= 128));
  assert.match(
    String(health.provider.detectedCapabilities?.backendModel),
    /\[truncated 188 chars\]$/,
  );
  assert.match(
    String(health.provider.detectedCapabilities?.errors?.props),
    /\[truncated 808 chars\]$/,
  );
  assert.equal(
    health.provider.detectedCapabilities?.errors?.[`k${"x".repeat(104)}...[truncated 36 chars]`],
    "capability-key",
  );
  assert.ok(
    Object.keys(health.provider.detectedCapabilities?.errors ?? {}).every(
      (key) => key.length <= 128,
    ),
  );

  details.message = "mutated";
  const cached = await runtime.health();
  assert.equal(calls, 1);
  assert.notEqual(cached.provider.details?.message, "mutated");
});

test("runtime treats malformed provider health as unavailable", async () => {
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
        latencyMs: Number.NaN,
      } as never;
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const health = await runtime.health();

  assert.equal(health.status, "unavailable");
  assert.equal(health.provider.status, "unavailable");
  assert.match(
    String(health.provider.details?.message),
    /Invalid provider health: latencyMs must be a non-negative finite number/,
  );
});

test("runtime deduplicates concurrent provider health checks", async () => {
  let calls = 0;
  let releaseHealth!: () => void;
  const healthGate = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "test-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async health() {
      calls += 1;
      await healthGate;
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
      };
    },
    async infer() {
      return {
        output: "unused",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("vps"), { provider });
  const healthChecks = Promise.all([runtime.health(), runtime.health(), runtime.health()]);
  await Promise.resolve();

  assert.equal(calls, 1);
  releaseHealth();

  const results = await healthChecks;
  assert.deepEqual(
    results.map((result) => result.provider.status),
    ["ready", "ready", "ready"],
  );

  await runtime.health();
  assert.equal(calls, 1);
});

test("runtime rejects malformed request bodies and numeric controls", async () => {
  const runtime = createRayRuntime(createDefaultConfig("tiny"));

  await assert.rejects(
    runtime.infer(null as unknown as Parameters<typeof runtime.infer>[0]),
    /request body must be a JSON object/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      maxTokens: "128",
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /maxTokens must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      temperature: Number.NaN,
    }),
    /temperature must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      topP: Number.POSITIVE_INFINITY,
    }),
    /topP must be a finite number/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: "false",
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /cache must be a boolean/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      system: { role: "system" },
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /system must be a string/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      dedupeKey: 123,
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /dedupeKey must be a string/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: {
        promptFamily: ["email"],
      },
    } as unknown as Parameters<typeof runtime.infer>[0]),
    /metadata must be an object of string values/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
    }),
    /metadata must not contain unsafe key "__proto__"/,
  );

  const metadata = {};
  Object.defineProperty(metadata, "promptFamily", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: metadata as Record<string, string>,
    }),
    /metadata must not contain unreadable properties/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: Object.fromEntries(
        Array.from({ length: 33 }, (_value, index) => [`key${index}`, "value"]),
      ),
    }),
    /metadata must contain at most 32 entries/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      metadata: {
        promptFamily: "x".repeat(1_025),
      },
    }),
    /metadata\.promptFamily must be at most 1024 characters/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      dedupeKey: "x".repeat(513),
    }),
    /dedupeKey must be at most 512 characters/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      stop: Array.from({ length: 17 }, (_value, index) => `stop-${index}`),
    }),
    /stop must contain at most 16 entries/,
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      stop: ["x".repeat(257)],
    }),
    /stop entries must be at most 256 characters/,
  );
});

test("runtime keeps seeded variants isolated in cache keys", async () => {
  const calls: Array<number | undefined> = [];
  const provider: ModelProvider = {
    kind: "openai-compatible",
    modelId: "seeded-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      calls.push(request.seed);
      return {
        output: `seed:${request.seed ?? "none"}:call:${calls.length}`,
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  const first = await runtime.infer({
    input: "hello world",
    seed: 11,
  });
  const second = await runtime.infer({
    input: "hello world",
    seed: 11,
  });
  const third = await runtime.infer({
    input: "hello world",
    seed: 12,
  });

  assert.equal(first.output, "seed:11:call:1");
  assert.equal(first.cached, false);
  assert.equal(second.output, "seed:11:call:1");
  assert.equal(second.cached, true);
  assert.equal(third.output, "seed:12:call:2");
  assert.equal(third.cached, false);
  assert.deepEqual(calls, [11, 12]);
});

test("runtime keeps metadata variants isolated in cache keys", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "metadata-sensitive-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      const format = request.metadata.rayPromptFormat ?? "default";
      calls.push(format);
      return {
        output: `format:${format}:call:${calls.length}`,
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  const first = await runtime.infer({
    input: "hello world",
    metadata: {
      rayPromptFormat: "prompt-scaffold",
    },
  });
  const second = await runtime.infer({
    input: "hello world",
    metadata: {
      rayPromptFormat: "prompt-scaffold",
    },
  });
  const third = await runtime.infer({
    input: "hello world",
    metadata: {
      rayPromptFormat: "ray-chat-fallback",
    },
  });

  assert.equal(first.output, "format:prompt-scaffold:call:1");
  assert.equal(first.cached, false);
  assert.equal(second.output, "format:prompt-scaffold:call:1");
  assert.equal(second.cached, true);
  assert.equal(third.output, "format:ray-chat-fallback:call:2");
  assert.equal(third.cached, false);
  assert.deepEqual(calls, ["prompt-scaffold", "ray-chat-fallback"]);
});

test("runtime skips caching payloads above the configured byte budget", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "byte-budget-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      calls += 1;
      return {
        output: `call:${calls}:${"x".repeat(1_024)}`,
      };
    },
  };
  const config = mergeConfig(createDefaultConfig("tiny"), {
    cache: {
      maxBytes: 512,
    },
  });
  const runtime = createRayRuntime(config, { provider });

  const first = await runtime.infer({ input: "hello world" });
  const second = await runtime.infer({ input: "hello world" });
  const metrics = runtime.metricsSnapshot();

  assert.equal(first.cached, false);
  assert.equal(second.cached, false);
  assert.equal(calls, 2);
  assert.equal(metrics.gauges["cache.entries"], 0);
  assert.equal(metrics.gauges["cache.bytes"], 0);
  assert.equal(metrics.gauges["cache.max_bytes"], 512);
});

test("runtime uses provider token preparation and exposes compiler diagnostics", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "prepared-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 77,
      };
    },
    async infer() {
      return {
        output: "prepared",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });
  const result = await runtime.infer({
    system: "Write only the email body.\nWrite only the email body.",
    input: "Write only the email body.\nDraft a short reply.",
    maxTokens: 96,
  });

  assert.equal(result.usage.tokens?.prompt, 77);
  assert.ok((result.diagnostics?.promptCompiler?.charsSaved ?? 0) > 0);
  assert.ok(typeof result.diagnostics?.promptCompiler?.familyKey === "string");
  assert.equal(result.diagnostics?.taskRouting?.recommendedModelRole, "drafter");
});

test("runtime rejects prepared requests that exceed a llama.cpp slot context", async () => {
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "oversized-prepared-context-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 3_000,
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("sub1b"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "large prepared prompt",
      maxTokens: 128,
      cache: false,
    }),
    (error: unknown) =>
      error instanceof Error &&
      /model context window/.test(error.message) &&
      (error as { code?: string }).code === "request_context_window_exceeded",
  );

  assert.equal(inferCalled, false);
});

test("runtime passes sanitized provider preparation requests to inference", async () => {
  let observedRequest:
    | (Parameters<ModelProvider["infer"]>[0] & {
        extra?: unknown;
        responseFormat?: { extra?: unknown };
      })
    | undefined;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "sanitized-preparation-request-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request: {
          ...request,
          input: "  prepared input  ",
          system: "  prepared system  ",
          responseFormat: {
            type: "json_object",
            extra: "not retained",
          },
          metadata: {
            source: "prepare",
          },
          extra: "not retained",
        } as Parameters<ModelProvider["infer"]>[0] & {
          extra: string;
          responseFormat: { type: "json_object"; extra: string };
        },
        promptTokens: 8,
      };
    },
    async infer(request) {
      observedRequest = request as typeof observedRequest;
      return {
        output: "ok",
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await runtime.infer({
    input: "hello world",
    cache: false,
  });

  assert.equal(observedRequest?.input, "prepared input");
  assert.equal(observedRequest?.system, "prepared system");
  assert.deepEqual(observedRequest?.metadata, { source: "prepare" });
  assert.deepEqual(observedRequest?.responseFormat, { type: "json_object" });
  assert.equal(observedRequest?.responseFormat?.extra, undefined);
  assert.equal(observedRequest?.extra, undefined);
});

test("runtime rejects invalid provider preparation token counts before scheduling", async () => {
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-preparation-tokens-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: Number.NaN,
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_preparation_invalid");
      assert.equal((error as { status?: number }).status, 502);
      assert.equal((error as { details?: { field?: string } }).details?.field, "promptTokens");
      return true;
    },
  );

  assert.equal(inferCalled, false);
});

test("runtime rejects oversized provider preparation requests before scheduling", async () => {
  let inferCalled = false;
  const config = mergeConfig(createDefaultConfig("tiny"), {
    gracefulDegradation: {
      enabled: true,
      maxPromptChars: 32,
      queueDepthThreshold: 1_000,
    },
  });
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-preparation-request-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request: {
          ...request,
          input: "x".repeat(33),
        },
        promptTokens: 8,
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(config, { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_preparation_invalid");
      assert.equal((error as { details?: { field?: string } }).details?.field, "request");
      return true;
    },
  );

  assert.equal(inferCalled, false);
});

test("runtime rejects malformed provider slot snapshots before metrics", async () => {
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-preparation-slots-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 8,
        slotSnapshots: [
          {
            id: -1,
            isProcessing: false,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_preparation_invalid");
      assert.equal(
        (error as { details?: { field?: string } }).details?.field,
        "slotSnapshots[0].id",
      );
      return true;
    },
  );

  assert.equal(inferCalled, false);
});

test("runtime stores sanitized provider preparation slot snapshots", async () => {
  const extra = "x".repeat(10_000);
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "sanitized-preparation-slots-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 8,
        slotSnapshots: [
          {
            id: 7,
            taskId: 3,
            isProcessing: false,
            contextWindow: 2048,
            promptTokens: 128,
            cacheTokens: 64,
            updatedAt: new Date().toISOString(),
            extra,
          } as SchedulerSlotSnapshot & { extra: string },
        ],
      };
    },
    async infer() {
      return {
        output: "ok",
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await runtime.infer({
    input: "hello world",
    cache: false,
  });

  const schedulerState = runtime.scheduler as unknown as {
    backendSlots: Map<number, SchedulerSlotSnapshot & { extra?: unknown }>;
  };
  const slot = schedulerState.backendSlots.get(7);

  assert.equal(slot?.taskId, 3);
  assert.equal(slot?.isProcessing, false);
  assert.equal(slot?.contextWindow, 2048);
  assert.equal(slot?.promptTokens, 128);
  assert.equal(slot?.cacheTokens, 64);
  assert.equal(slot?.extra, undefined);
});

test("runtime stores bounded provider preparation diagnostics", async () => {
  const longDiagnostic = `d${"x".repeat(600)}`;
  let observedDiagnostics:
    | (ProviderDiagnostics & {
        extra?: unknown;
      })
    | undefined;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-preparation-diagnostics-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 8,
        diagnostics: {
          requestShape: "llama.cpp-completion",
          promptFormat: "prompt-scaffold",
          modelRef: longDiagnostic,
          backendModel: longDiagnostic,
          launchPreset: longDiagnostic,
          slotRouteReason: longDiagnostic,
          jsonRepairAttempted: true,
          totalSlots: 2,
          timings: {
            completionTokensPerSecond: 12,
          },
          extra: "not retained",
        } as ProviderDiagnostics & { extra: string },
      };
    },
    async infer(_request, context) {
      observedDiagnostics = context.preparation?.diagnostics as
        | (ProviderDiagnostics & { extra?: unknown })
        | undefined;
      return {
        output: "ok",
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await runtime.infer({
    input: "hello world",
    cache: false,
  });

  assert.equal(observedDiagnostics?.requestShape, "llama.cpp-completion");
  assert.equal(observedDiagnostics?.promptFormat, "prompt-scaffold");
  assert.equal(observedDiagnostics?.jsonRepairAttempted, true);
  assert.equal(observedDiagnostics?.totalSlots, 2);
  assert.equal(observedDiagnostics?.timings?.completionTokensPerSecond, 12);
  assert.equal(observedDiagnostics?.modelRef?.length, 512);
  assert.match(observedDiagnostics?.modelRef ?? "", /\[truncated 113 chars\]$/);
  assert.equal(observedDiagnostics?.backendModel?.length, 512);
  assert.equal(observedDiagnostics?.launchPreset?.length, 512);
  assert.equal(observedDiagnostics?.slotRouteReason?.length, 512);
  assert.equal(observedDiagnostics?.extra, undefined);
});

test("runtime rejects oversized provider preparation affinity keys before scheduling", async () => {
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-preparation-affinity-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 8,
        affinityKey: "x".repeat(513),
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_preparation_invalid");
      assert.equal((error as { details?: { field?: string } }).details?.field, "affinityKey");
      return true;
    },
  );

  assert.equal(inferCalled, false);
});

test("runtime rejects malformed provider preparation diagnostics before scheduling", async () => {
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-preparation-diagnostics-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 8,
        diagnostics: {
          tokensCached: Number.NaN,
        },
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_preparation_invalid");
      assert.equal(
        (error as { details?: { field?: string } }).details?.field,
        "diagnostics.tokensCached",
      );
      return true;
    },
  );

  assert.equal(inferCalled, false);
});

test("runtime rejects malformed provider result output before caching", async () => {
  let inferCalls = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "bad-result-output-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      inferCalls += 1;
      return {
        output: 42 as unknown as string,
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      assert.equal((error as { status?: number }).status, 502);
      assert.equal((error as { details?: { field?: string } }).details?.field, "output");
      return true;
    },
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      return true;
    },
  );
  assert.equal(inferCalls, 2);
});

test("runtime rejects oversized provider result output before caching", async () => {
  let inferCalls = 0;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "oversized-result-output-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      inferCalls += 1;
      return {
        output: "x".repeat(8_193),
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      maxTokens: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      assert.equal((error as { status?: number }).status, 502);
      assert.equal((error as { details?: { field?: string } }).details?.field, "output");
      assert.equal((error as { details?: { maxChars?: number } }).details?.maxChars, 8_192);
      assert.equal((error as { details?: { actualChars?: number } }).details?.actualChars, 8_193);
      return true;
    },
  );

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      maxTokens: 1,
    }),
    /provider result: output must be at most 8192 characters/,
  );
  assert.equal(inferCalls, 2);
});

test("runtime stores bounded provider result diagnostics", async () => {
  let inferCalls = 0;
  const longDiagnostic = `d${"x".repeat(600)}`;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-result-diagnostics-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      inferCalls += 1;
      return {
        output: "ok",
        diagnostics: {
          requestShape: "llama.cpp-completion",
          promptFormat: "prompt-scaffold",
          modelRef: longDiagnostic,
          backendModel: longDiagnostic,
          launchPreset: longDiagnostic,
          slotRouteReason: longDiagnostic,
          jsonRepairAttempted: true,
          totalSlots: 2,
          timings: {
            completionTokensPerSecond: 12,
          },
          extra: "not retained",
        } as ProviderDiagnostics & { extra: string },
        raw: {
          extra: "not retained",
        },
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  const first = await runtime.infer({ input: "hello world" });
  const second = await runtime.infer({ input: "hello world" });
  const diagnostics = second.diagnostics?.provider as
    | (NonNullable<typeof second.diagnostics>["provider"] & { extra?: unknown; raw?: unknown })
    | undefined;

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(inferCalls, 1);
  assert.equal(diagnostics?.requestShape, "llama.cpp-completion");
  assert.equal(diagnostics?.promptFormat, "prompt-scaffold");
  assert.equal(diagnostics?.jsonRepairAttempted, true);
  assert.equal(diagnostics?.totalSlots, 2);
  assert.equal(diagnostics?.timings?.completionTokensPerSecond, 12);
  assert.equal(diagnostics?.modelRef?.length, 512);
  assert.match(diagnostics?.modelRef ?? "", /\[truncated 113 chars\]$/);
  assert.equal(diagnostics?.backendModel?.length, 512);
  assert.equal(diagnostics?.launchPreset?.length, 512);
  assert.equal(diagnostics?.slotRouteReason?.length, 512);
  assert.equal(diagnostics?.extra, undefined);
  assert.equal(diagnostics?.raw, undefined);
});

test("runtime rejects malformed provider result diagnostics before metrics", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bad-result-diagnostics-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      return {
        output: "ok",
        diagnostics: {
          tokensCached: Number.NaN,
        },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  await assert.rejects(
    runtime.infer({
      input: "hello world",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "provider_result_invalid");
      assert.equal(
        (error as { details?: { field?: string } }).details?.field,
        "diagnostics.tokensCached",
      );
      return true;
    },
  );
});

test("runtime trims oversized prompts before prompt compilation", async () => {
  let observedInput = "";
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "trimmed-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedInput = request.input;
      return {
        output: "trimmed",
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      gracefulDegradation: {
        enabled: true,
        maxPromptChars: 32,
        queueDepthThreshold: 1_000,
      },
    }),
    { provider },
  );
  const result = await runtime.infer({
    input: "x".repeat(128),
    cache: false,
  });

  assert.equal(result.degraded, true);
  assert.equal(observedInput.length, 32);
  assert.equal(result.diagnostics?.promptCompiler?.charsBefore, 32);
});

test("runtime applies prompt length degradation to system and input together", async () => {
  let observedInput = "";
  let observedSystem: string | undefined;
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "combined-prompt-budget-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedInput = request.input;
      observedSystem = request.system;
      return {
        output: "trimmed",
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      gracefulDegradation: {
        enabled: true,
        maxPromptChars: 32,
        queueDepthThreshold: 1_000,
      },
    }),
    { provider },
  );
  const result = await runtime.infer({
    system: "s".repeat(128),
    input: "hello world",
    cache: false,
  });

  assert.equal(result.degraded, true);
  assert.equal(observedInput, "hello world");
  assert.equal(observedInput.length + (observedSystem?.length ?? 0), 32);
  assert.equal(result.diagnostics?.promptCompiler?.charsBefore, 32);
});

test("runtime times out and aborts stalled provider preparation", async () => {
  let prepareAborted = false;
  let inferCalled = false;
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "stalled-prepare-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request, context) {
      await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            prepareAborted = true;
            reject(context.signal.reason);
          },
          { once: true },
        );
      });

      return {
        request,
        promptTokens: 1,
      };
    },
    async infer() {
      inferCalled = true;
      return {
        output: "should not run",
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      scheduler: {
        requestTimeoutMs: 100,
      },
    }),
    { provider },
  );

  await assert.rejects(
    () =>
      runtime.infer({
        input: "hello world",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "request_timeout");
      assert.deepEqual((error as { details?: unknown }).details, {
        phase: "prepare",
        timeoutMs: 100,
      });
      return true;
    },
  );

  assert.equal(prepareAborted, true);
  assert.equal(inferCalled, false);
});

test("runtime bounds concurrent provider preparation before scheduling inference", async () => {
  let activePreparations = 0;
  let maxActivePreparations = 0;
  let prepareStarts = 0;
  const startWaiters: Array<() => void> = [];
  const releasePreparations: Array<() => void> = [];
  const waitForPrepareStarts = async (count: number) => {
    while (prepareStarts < count) {
      await new Promise<void>((resolve) => {
        startWaiters.push(resolve);
      });
    }
  };
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-prepare-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      prepareStarts += 1;
      for (const resolve of startWaiters.splice(0)) {
        resolve();
      }

      try {
        await new Promise<void>((resolve) => {
          releasePreparations.push(resolve);
        });
        return {
          request,
          promptTokens: 8,
        };
      } finally {
        activePreparations -= 1;
      }
    },
    async infer(request) {
      return {
        output: request.input,
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      scheduler: {
        concurrency: 1,
        maxQueue: 1,
        affinityLookahead: 1,
        requestTimeoutMs: 2_000,
      },
    }),
    { provider },
  );

  const first = runtime.infer({
    input: "first",
    cache: false,
  });
  await waitForPrepareStarts(1);

  const second = runtime.infer({
    input: "second",
    cache: false,
  });
  let health = await runtime.health();
  await waitForCondition(async () => {
    health = await runtime.health();
    return health.runtime?.preparation.active === 1 && health.runtime.preparation.queued === 1;
  });

  assert.equal(prepareStarts, 1);
  assert.equal(maxActivePreparations, 1);
  assert.equal(health.runtime?.preparation.active, 1);
  assert.equal(health.runtime?.preparation.concurrency, 1);
  assert.equal(health.runtime?.preparation.activeRatio, 1);
  assert.equal(health.runtime?.preparation.queued, 1);
  assert.equal(health.runtime?.preparation.maxQueue, 1);
  assert.equal(health.runtime?.preparation.queuedRatio, 1);

  const metrics = await runtime.collectMetricsSnapshot();
  assert.equal(metrics.gauges["preparation.active"], 1);
  assert.equal(metrics.gauges["preparation.concurrency"], 1);
  assert.equal(metrics.gauges["preparation.active_ratio"], 1);
  assert.equal(metrics.gauges["preparation.queued"], 1);
  assert.equal(metrics.gauges["preparation.max_queue"], 1);
  assert.equal(metrics.gauges["preparation.queued_ratio"], 1);

  await assert.rejects(
    runtime.infer({
      input: "third",
      cache: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "queue_full");
      assert.equal((error as { details?: { phase?: string } }).details?.phase, "prepare");
      return true;
    },
  );

  releasePreparations.shift()?.();
  await waitForPrepareStarts(2);
  releasePreparations.shift()?.();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.output, "first");
  assert.equal(secondResult.output, "second");
  assert.equal(prepareStarts, 2);
  assert.equal(maxActivePreparations, 1);
});

test("runtime exposes task-aware routing diagnostics for classification", async () => {
  const provider: ModelProvider = {
    kind: "mock",
    modelId: "classifier-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      return {
        output: '{"intent":"positive"}',
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      tags: {
        modelRole: "classifier",
      },
    }),
    { provider },
  );
  const result = await runtime.infer({
    input: "Classify this reply",
    responseFormat: {
      type: "json_object",
    },
    metadata: {
      promptFamily: "email.reply_classification",
    },
  });

  assert.equal(result.diagnostics?.taskRouting?.taskKind, "classification");
  assert.equal(result.diagnostics?.taskRouting?.recommendedModelRole, "classifier");
  assert.equal(result.diagnostics?.taskRouting?.matchedActiveRole, true);
});

test("runtime adaptively reduces maxTokens when observed throughput drops", async () => {
  const observedMaxTokens: number[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "adaptive-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 24,
      };
    },
    async infer(request) {
      observedMaxTokens.push(request.maxTokens);
      return {
        output: "ok",
        diagnostics: {
          requestShape: "llama.cpp-completion",
          timings: {
            completionTokensPerSecond: 5,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      adaptiveTuning: {
        enabled: true,
        sampleSize: 4,
        queueLatencyThresholdMs: 1_000,
        minCompletionTokensPerSecond: 10,
        maxOutputReductionRatio: 0.5,
        minOutputTokens: 32,
      },
    }),
    { provider },
  );

  const first = await runtime.infer({
    input: "hello world",
    maxTokens: 128,
  });
  const second = await runtime.infer({
    input: "hello world again",
    maxTokens: 128,
  });

  assert.equal(first.diagnostics?.adaptiveTuning?.reduced, false);
  assert.equal(second.diagnostics?.adaptiveTuning?.reduced, true);
  assert.ok((second.diagnostics?.adaptiveTuning?.appliedMaxTokens ?? 128) < 128);
  assert.deepEqual(observedMaxTokens, [128, 96]);
});

test("runtime keeps adaptive tuning below-min token requests stable", async () => {
  const observedMaxTokens: number[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "adaptive-small-budget-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens.push(request.maxTokens);
      return {
        output: "ok",
        diagnostics: {
          timings: {
            completionTokensPerSecond: 5,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      adaptiveTuning: {
        enabled: true,
        sampleSize: 4,
        queueLatencyThresholdMs: 1_000,
        minCompletionTokensPerSecond: 10,
        maxOutputReductionRatio: 0.5,
        minOutputTokens: 32,
      },
    }),
    { provider },
  );

  await runtime.infer({
    input: "prime adaptive sample",
    maxTokens: 64,
    cache: false,
  });
  const result = await runtime.infer({
    input: "small request",
    maxTokens: 16,
    cache: false,
  });

  assert.equal(result.output, "ok");
  assert.equal(result.diagnostics?.adaptiveTuning?.reduced, false);
  assert.deepEqual(observedMaxTokens, [64, 16]);
});

test("runtime keeps learned caps below-min token requests stable", async () => {
  const observedMaxTokens: number[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "learned-cap-small-budget-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens.push(request.maxTokens);
      return {
        output: "ok",
        usage: {
          tokens: {
            prompt: 8,
            completion: 4,
            total: 12,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      adaptiveTuning: {
        learnedCapMinSamples: 2,
        learnedCapHeadroomTokens: 4,
        minOutputTokens: 32,
      },
    }),
    { provider },
  );

  await runtime.infer({
    input: "family sample one",
    maxTokens: 64,
    cache: false,
    metadata: {
      promptFamily: "small-budget-family",
    },
  });
  await runtime.infer({
    input: "family sample two",
    maxTokens: 64,
    cache: false,
    metadata: {
      promptFamily: "small-budget-family",
    },
  });
  const result = await runtime.infer({
    input: "family small request",
    maxTokens: 16,
    cache: false,
    metadata: {
      promptFamily: "small-budget-family",
    },
  });

  assert.equal(result.output, "ok");
  assert.equal(result.diagnostics?.learnedOutputCap?.applied, false);
  assert.deepEqual(observedMaxTokens, [64, 64, 16]);
});

test("runtime disables learned output caps when adaptive tuning is disabled", async () => {
  const observedMaxTokens: number[] = [];
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "adaptive-disabled-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer(request) {
      observedMaxTokens.push(request.maxTokens);
      return {
        output: "ok",
        usage: {
          tokens: {
            prompt: 8,
            completion: 4,
            total: 12,
          },
        },
      };
    },
  };
  const runtime = createRayRuntime(
    mergeConfig(createDefaultConfig("tiny"), {
      adaptiveTuning: {
        enabled: false,
        learnedFamilyCapEnabled: true,
        learnedCapMinSamples: 2,
        learnedCapHeadroomTokens: 4,
        minOutputTokens: 32,
      },
    }),
    { provider },
  );

  for (let index = 0; index < 4; index += 1) {
    const result = await runtime.infer({
      input: `adaptive disabled sample ${index}`,
      maxTokens: 64,
      cache: false,
      metadata: {
        promptFamily: "adaptive-disabled-family",
      },
    });

    assert.equal(result.diagnostics?.learnedOutputCap?.applied, false);
  }

  assert.deepEqual(observedMaxTokens, [64, 64, 64, 64]);
});

test("runtime bounds learned output family history across unique prompt families", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "bounded-family-history-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async infer() {
      return {
        output: "ok",
        usage: {
          tokens: {
            prompt: 8,
            completion: 2,
            total: 10,
          },
        },
      };
    },
  };
  const runtime = createRayRuntime(createDefaultConfig("tiny"), { provider });

  for (let index = 0; index < 520; index += 1) {
    await runtime.infer({
      input: `unique prompt family ${index}`,
      cache: false,
      metadata: {
        promptFamily: `family-${index}`,
      },
    });
  }

  const familyCompletionHistory = (
    runtime as unknown as {
      familyCompletionHistory: Map<string, unknown>;
    }
  ).familyCompletionHistory;
  assert.equal(familyCompletionHistory.size, 512);
});

test("runtime metrics expose small-box process and provider telemetry", async () => {
  const provider: ModelProvider = {
    kind: "llama.cpp",
    modelId: "telemetry-model",
    capabilities: {
      streaming: false,
      quantized: true,
      localBackend: true,
    },
    async prepare(request) {
      return {
        request,
        promptTokens: 80,
        preferredSlot: 1,
        slotSnapshots: [
          {
            id: 1,
            isProcessing: false,
            promptTokens: 64,
            cacheTokens: 48,
            updatedAt: new Date().toISOString(),
          },
          {
            id: 2,
            isProcessing: true,
            promptTokens: 96,
            cacheTokens: 32,
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    },
    async infer() {
      return {
        output: "ok",
        diagnostics: {
          requestShape: "llama.cpp-completion",
          slotId: 1,
          tokensCached: 40,
          timings: {
            completionTokensPerSecond: 22,
          },
        },
      };
    },
  };

  const runtime = createRayRuntime(createDefaultConfig("sub1b"), { provider });
  await runtime.infer({
    input: "hello world",
    maxTokens: 64,
  });

  const metrics = runtime.metricsSnapshot();

  assert.equal(metrics.gauges["provider.slots.total"], 2);
  assert.equal(metrics.gauges["provider.slots.processing"], 1);
  assert.equal(metrics.gauges["provider.slots.idle"], 1);
  assert.equal(metrics.gauges["provider.slot.last_id"], 1);
  assert.equal(metrics.gauges["provider.prompt_cache.tokens_cached"], 40);
  assert.equal(metrics.gauges["provider.prompt_cache.reuse_ratio"], 0.5);
  assert.equal(metrics.gauges["provider.completion_tps"], 22);
  assert.ok(typeof metrics.gauges["process.memory.rss_mib"] === "number");
  assert.ok(typeof metrics.gauges["process.memory.rss_pressure_ratio"] === "number");
  assert.ok(typeof metrics.gauges["process.memory.heap_used_mib"] === "number");
  assert.ok(typeof metrics.gauges["process.cpu.percent"] === "number");
  assert.ok(typeof metrics.gauges["runtime.event_loop_lag_p95_ms"] === "number");
  assert.equal(metrics.recent?.lastSlotId, 1);
  assert.equal(metrics.recent?.lastPromptCacheTokens, 40);
  assert.equal(metrics.recent?.lastPromptCacheReuseRatio, 0.5);
});
