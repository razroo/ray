import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRayConfig, resolveAuthApiKeys } from "./index.js";

async function readDocumentedDotenvEnv(
  relativePath: string,
  marker: string,
): Promise<NodeJS.ProcessEnv> {
  const absolutePath = join(process.cwd(), relativePath);
  const content = await readFile(absolutePath, "utf8");
  const markerIndex = content.indexOf(marker);

  if (markerIndex === -1) {
    throw new Error(`Could not find marker in ${relativePath}: ${marker}`);
  }

  const fenceStart = content.indexOf("```dotenv", markerIndex);
  if (fenceStart === -1) {
    throw new Error(`Could not find dotenv fence in ${relativePath} after ${marker}`);
  }

  const blockStart = content.indexOf("\n", fenceStart) + 1;
  const blockEnd = content.indexOf("```", blockStart);
  if (blockStart === 0 || blockEnd === -1) {
    throw new Error(`Could not read dotenv block in ${relativePath} after ${marker}`);
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [index, rawLine] of content.slice(blockStart, blockEnd).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    assert.ok(match, `${relativePath} dotenv line ${index + 1} must be KEY=value`);
    const name = match[1];
    const value = match[2] ?? "";
    assert.ok(name, `${relativePath} dotenv line ${index + 1} must include a key`);
    assert.equal(env[name], undefined, `${relativePath} must not repeat ${name}`);
    env[name] = value;
  }

  return env;
}

test("loadRayConfig defaults to the sub1b profile", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    env: {},
  });

  assert.equal(loaded.config.profile, "sub1b");
  assert.equal(loaded.config.model.adapter.kind, "llama.cpp");
});

test("loadRayConfig rejects oversized config files before parsing", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-file-limit-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.huge.json");
  await writeFile(configPath, "x".repeat(256 * 1024 + 1), "utf8");

  await assert.rejects(
    loadRayConfig({
      cwd: tempDir,
      configPath: "ray.huge.json",
      env: {},
    }),
    /Config file must be at most 262144 bytes/,
  );
});

test("loadRayConfig accepts every checked-in example config", async () => {
  const configDir = join(process.cwd(), "examples/config");
  const configFiles = (await readdir(configDir)).filter((entry) => entry.endsWith(".json")).sort();

  assert.ok(configFiles.length > 0);

  for (const configFile of configFiles) {
    const loaded = await loadRayConfig({
      cwd: process.cwd(),
      configPath: `./examples/config/${configFile}`,
      env: {},
    });

    assert.ok(loaded.config.profile, `${configFile} should resolve a profile`);
  }
});

test("loadRayConfig accepts the cax11 sub1b launch preset", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.sub1b.cax11.json",
    env: {},
  });

  assert.equal(loaded.config.profile, "sub1b-cax11");
  assert.equal(loaded.config.scheduler.concurrency, 1);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.preset, "single-vps-sub1b-cax11");
});

test("loadRayConfig accepts the sub1b-cax11 profile from environment", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    env: {
      RAY_PROFILE: "sub1b-cax11",
    },
  });

  assert.equal(loaded.config.profile, "sub1b-cax11");
  assert.equal(loaded.config.scheduler.concurrency, 1);
  assert.equal(loaded.config.scheduler.requestTimeoutMs, 22_000);
  assert.equal(loaded.config.adaptiveTuning.minCompletionTokensPerSecond, 10);

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

  assert.equal(loaded.config.profile, "1b-8gb");
  assert.equal(loaded.config.scheduler.concurrency, 2);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
  assert.equal(loaded.config.model.adapter.launchProfile.threadsBatch, 4);
  assert.equal(loaded.config.model.operational?.memoryClassMiB, 8192);
});

test("loadRayConfig keeps checked-in 8gb profiles on 8gb operational defaults", async () => {
  const configPaths = [
    "./examples/config/ray.1b.8gb.json",
    "./examples/config/ray.1b.8gb.public.json",
    "./examples/config/ray.1b.8gb.generic.json",
    "./examples/config/ray.1b.8gb.generic.public.json",
  ];

  for (const configPath of configPaths) {
    const loaded = await loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    });

    assert.equal(loaded.config.profile, "1b-8gb", configPath);
    assert.equal(loaded.config.model.operational?.memoryClassMiB, 8192, configPath);
    assert.equal(loaded.config.asyncQueue.minFreeStorageMiB, 512, configPath);
    assert.equal(loaded.config.telemetry.slowRequestThresholdMs, 1800, configPath);
    assert.equal(loaded.config.gracefulDegradation.memoryRssThresholdMiB, 768, configPath);
    assert.equal(loaded.config.adaptiveTuning.queueLatencyThresholdMs, 450, configPath);
    assert.equal(loaded.config.adaptiveTuning.minCompletionTokensPerSecond, 14, configPath);

    if (
      loaded.config.model.adapter.kind !== "llama.cpp" ||
      !loaded.config.model.adapter.launchProfile
    ) {
      throw new Error(`Expected a llama.cpp launch profile for ${configPath}`);
    }

    assert.equal(loaded.config.model.adapter.launchProfile.threadsBatch, 4, configPath);
  }
});

test("loadRayConfig accepts the 1b-8gb profile from environment", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    env: {
      RAY_PROFILE: "1b-8gb",
    },
  });

  assert.equal(loaded.config.profile, "1b-8gb");
  assert.equal(loaded.config.scheduler.concurrency, 2);
  assert.equal(loaded.config.model.operational?.memoryClassMiB, 8192);
  assert.equal(loaded.config.asyncQueue.minFreeStorageMiB, 512);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
});

test("loadRayConfig accepts generic 1b model profiles", async () => {
  const generic4gb = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.1b.generic.json",
    env: {},
  });
  const generic8gb = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.1b.8gb.generic.json",
    env: {},
  });

  assert.equal(generic4gb.config.model.id, "local-1b-q4");
  assert.equal(generic4gb.config.model.family, "generic-1b");
  assert.equal(generic4gb.config.scheduler.concurrency, 1);

  assert.equal(generic8gb.config.model.id, "local-1b-q4");
  assert.equal(generic8gb.config.scheduler.concurrency, 2);

  if (
    generic4gb.config.model.adapter.kind !== "llama.cpp" ||
    !generic4gb.config.model.adapter.launchProfile ||
    generic8gb.config.model.adapter.kind !== "llama.cpp" ||
    !generic8gb.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected llama.cpp launch profiles");
  }

  assert.equal(
    generic4gb.config.model.adapter.launchProfile.modelPath,
    "/var/lib/ray/models/local-1b-q4.gguf",
  );
  assert.equal(generic4gb.config.model.adapter.launchProfile.preset, "single-vps-1b-cx23");
  assert.equal(generic4gb.config.model.adapter.launchProfile.threadsBatch, 2);
  assert.equal(generic8gb.config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
  assert.equal(generic8gb.config.model.adapter.launchProfile.threadsBatch, 4);
  assert.equal(
    generic8gb.config.model.adapter.launchProfile.modelPath,
    "/var/lib/ray/models/local-1b-q4.gguf",
  );
});

test("loadRayConfig applies portable 1b model environment overrides", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.1b.json",
    env: {
      RAY_MODEL_ID: "local-any-1b-q4",
      RAY_MODEL_FAMILY: "generic-llama",
      RAY_MODEL_QUANTIZATION: "q4_0",
      RAY_MODEL_WARM_ON_BOOT: "off",
      RAY_MODEL_API_KEY_ENV: "RAY_UPSTREAM_API_KEY",
      RAY_MODEL_PATH: "/models/local-any-1b-q4.gguf",
      RAY_LLAMA_CPP_BINARY_PATH: "/opt/llama.cpp/llama-server",
      RAY_LLAMA_CPP_HOST: "127.0.0.1",
      RAY_LLAMA_CPP_PORT: "8090",
      RAY_LLAMA_CPP_CTX_SIZE: "1536",
      RAY_LLAMA_CPP_PARALLEL: "1",
      RAY_LLAMA_CPP_THREADS: "2",
      RAY_LLAMA_CPP_CACHE_RAM_MIB: "256",
      RAY_LLAMA_CPP_CACHE_PROMPT: "false",
      RAY_LLAMA_CPP_SLOT_ID: "0",
      RAY_LLAMA_CPP_SLOT_STATE_TTL_MS: "500",
      RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS: "250",
      RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES: "96",
      RAY_LLAMA_CPP_CONTINUOUS_BATCHING: "false",
      RAY_LLAMA_CPP_ENABLE_METRICS: "false",
      RAY_LLAMA_CPP_EXPOSE_SLOTS: "false",
      RAY_LLAMA_CPP_WARMUP: "false",
      RAY_LLAMA_CPP_ENABLE_UNIFIED_KV: "false",
      RAY_LLAMA_CPP_CACHE_IDLE_SLOTS: "false",
      RAY_LLAMA_CPP_CONTEXT_SHIFT: "false",
      RAY_LOG_LEVEL: "debug",
      RAY_TELEMETRY_SERVICE_NAME: "ray-vps-test",
      RAY_TELEMETRY_INCLUDE_DEBUG_METRICS: "false",
      RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS: "900",
      RAY_REQUEST_BODY_LIMIT_BYTES: "36000",
      RAY_SCHEDULER_DEDUPE_INFLIGHT: "false",
      RAY_SCHEDULER_BATCH_WINDOW_MS: "12",
      RAY_SCHEDULER_AFFINITY_LOOKAHEAD: "8",
      RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS: "48",
      RAY_SCHEDULER_MAX_INFLIGHT_TOKENS: "1536",
      RAY_ASYNC_QUEUE_ENABLED: "yes",
      RAY_ASYNC_QUEUE_STORAGE_DIR: ".ray/test-async-queue",
      RAY_ASYNC_QUEUE_MAX_JOBS: "250",
      RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB: "192",
      RAY_ASYNC_QUEUE_COMPLETED_TTL_MS: "3600000",
      RAY_ASYNC_QUEUE_POLL_INTERVAL_MS: "250",
      RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY: "2",
      RAY_ASYNC_QUEUE_MAX_ATTEMPTS: "4",
      RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS: "1500",
      RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS: "3",
      RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK: "false",
      RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS: "callback.example,*.trusted.example",
      RAY_CACHE_ENABLED: "0",
      RAY_CACHE_MAX_ENTRIES: "128",
      RAY_CACHE_MAX_BYTES: "65536",
      RAY_CACHE_TTL_MS: "45000",
      RAY_CACHE_KEY_STRATEGY: "input",
      RAY_GRACEFUL_DEGRADATION_ENABLED: "1",
      RAY_DEGRADATION_MAX_PROMPT_CHARS: "4200",
      RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB: "448",
      RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD: "0.35",
      RAY_PROMPT_COMPILER_ENABLED: "false",
      RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE: "false",
      RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES: "false",
      RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS: "tenant,workflow",
      RAY_ADAPTIVE_TUNING_ENABLED: "off",
      RAY_ADAPTIVE_SAMPLE_SIZE: "16",
      RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS: "700",
      RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND: "7",
      RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO: "0.25",
      RAY_ADAPTIVE_MIN_OUTPUT_TOKENS: "32",
      RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED: "false",
      RAY_ADAPTIVE_FAMILY_HISTORY_SIZE: "32",
      RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES: "4",
      RAY_ADAPTIVE_DRAFT_PERCENTILE: "0.85",
      RAY_ADAPTIVE_SHORT_PERCENTILE: "0.8",
      RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS: "12",
      RAY_AUTH_ENABLED: "on",
      RAY_AUTH_API_KEY_ENV: "RAY_PUBLIC_API_KEYS",
      RAY_RATE_LIMIT_ENABLED: "no",
      RAY_RATE_LIMIT_WINDOW_MS: "30000",
      RAY_RATE_LIMIT_MAX_REQUESTS: "45",
      RAY_RATE_LIMIT_MAX_KEYS: "1024",
      RAY_RATE_LIMIT_KEY_STRATEGY: "api-key",
      RAY_RATE_LIMIT_TRUST_PROXY_HEADERS: "false",
    },
  });

  assert.equal(loaded.config.model.id, "local-any-1b-q4");
  assert.equal(loaded.config.model.family, "generic-llama");
  assert.equal(loaded.config.model.quantization, "q4_0");
  assert.equal(loaded.config.model.warmOnBoot, false);
  assert.equal(loaded.config.telemetry.logLevel, "debug");
  assert.equal(loaded.config.telemetry.serviceName, "ray-vps-test");
  assert.equal(loaded.config.telemetry.includeDebugMetrics, false);
  assert.equal(loaded.config.telemetry.slowRequestThresholdMs, 900);
  assert.equal(loaded.config.server.requestBodyLimitBytes, 36_000);
  assert.equal(loaded.config.model.adapter.kind, "llama.cpp");

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.baseUrl, "http://127.0.0.1:8090");
  assert.equal(loaded.config.model.adapter.modelRef, "local-any-1b-q4");
  assert.equal(loaded.config.model.adapter.apiKeyEnv, "RAY_UPSTREAM_API_KEY");
  assert.equal(loaded.config.model.adapter.launchProfile.binaryPath, "/opt/llama.cpp/llama-server");
  assert.equal(loaded.config.model.adapter.launchProfile.modelPath, "/models/local-any-1b-q4.gguf");
  assert.equal(loaded.config.model.adapter.launchProfile.alias, "local-any-1b-q4");
  assert.equal(loaded.config.model.adapter.launchProfile.ctxSize, 1536);
  assert.equal(loaded.config.model.adapter.launchProfile.cacheRamMiB, 256);
  assert.equal(loaded.config.model.adapter.cachePrompt, false);
  assert.equal(loaded.config.model.adapter.slotId, 0);
  assert.equal(loaded.config.model.adapter.slotStateTtlMs, 500);
  assert.equal(loaded.config.model.adapter.slotSnapshotTimeoutMs, 250);
  assert.equal(loaded.config.model.adapter.promptScaffoldCacheEntries, 96);
  assert.equal(loaded.config.model.adapter.launchProfile.cachePrompt, false);
  assert.equal(loaded.config.model.adapter.launchProfile.continuousBatching, false);
  assert.equal(loaded.config.model.adapter.launchProfile.enableMetrics, false);
  assert.equal(loaded.config.model.adapter.launchProfile.exposeSlots, false);
  assert.equal(loaded.config.model.adapter.launchProfile.warmup, false);
  assert.equal(loaded.config.model.adapter.launchProfile.enableUnifiedKv, false);
  assert.equal(loaded.config.model.adapter.launchProfile.cacheIdleSlots, false);
  assert.equal(loaded.config.model.adapter.launchProfile.contextShift, false);
  assert.equal(loaded.config.model.operational?.preferredCtxSize, 1536);
  assert.equal(loaded.config.scheduler.maxInflightTokens, 1536);
  assert.equal(loaded.config.scheduler.dedupeInflight, false);
  assert.equal(loaded.config.scheduler.batchWindowMs, 12);
  assert.equal(loaded.config.scheduler.affinityLookahead, 8);
  assert.equal(loaded.config.scheduler.shortJobMaxTokens, 48);
  assert.equal(loaded.config.asyncQueue.enabled, true);
  assert.equal(loaded.config.asyncQueue.storageDir, join(process.cwd(), ".ray/test-async-queue"));
  assert.equal(loaded.config.asyncQueue.maxJobs, 250);
  assert.equal(loaded.config.asyncQueue.minFreeStorageMiB, 192);
  assert.equal(loaded.config.asyncQueue.completedTtlMs, 3_600_000);
  assert.equal(loaded.config.asyncQueue.pollIntervalMs, 250);
  assert.equal(loaded.config.asyncQueue.dispatchConcurrency, 2);
  assert.equal(loaded.config.asyncQueue.maxAttempts, 4);
  assert.equal(loaded.config.asyncQueue.callbackTimeoutMs, 1_500);
  assert.equal(loaded.config.asyncQueue.maxCallbackAttempts, 3);
  assert.equal(loaded.config.asyncQueue.callbackAllowPrivateNetwork, false);
  assert.deepEqual(loaded.config.asyncQueue.callbackAllowedHosts, [
    "callback.example",
    "*.trusted.example",
  ]);
  assert.equal(loaded.config.cache.enabled, false);
  assert.equal(loaded.config.cache.maxEntries, 128);
  assert.equal(loaded.config.cache.maxBytes, 65_536);
  assert.equal(loaded.config.cache.ttlMs, 45_000);
  assert.equal(loaded.config.cache.keyStrategy, "input");
  assert.equal(loaded.config.gracefulDegradation.enabled, true);
  assert.equal(loaded.config.gracefulDegradation.maxPromptChars, 4200);
  assert.equal(loaded.config.gracefulDegradation.memoryRssThresholdMiB, 448);
  assert.equal(loaded.config.gracefulDegradation.cpuThrottledRatioThreshold, 0.35);
  assert.equal(loaded.config.promptCompiler.enabled, false);
  assert.equal(loaded.config.promptCompiler.collapseWhitespace, false);
  assert.equal(loaded.config.promptCompiler.dedupeRepeatedLines, false);
  assert.deepEqual(loaded.config.promptCompiler.familyMetadataKeys, ["tenant", "workflow"]);
  assert.equal(loaded.config.adaptiveTuning.enabled, false);
  assert.equal(loaded.config.adaptiveTuning.sampleSize, 16);
  assert.equal(loaded.config.adaptiveTuning.queueLatencyThresholdMs, 700);
  assert.equal(loaded.config.adaptiveTuning.minCompletionTokensPerSecond, 7);
  assert.equal(loaded.config.adaptiveTuning.maxOutputReductionRatio, 0.25);
  assert.equal(loaded.config.adaptiveTuning.minOutputTokens, 32);
  assert.equal(loaded.config.adaptiveTuning.learnedFamilyCapEnabled, false);
  assert.equal(loaded.config.adaptiveTuning.familyHistorySize, 32);
  assert.equal(loaded.config.adaptiveTuning.learnedCapMinSamples, 4);
  assert.equal(loaded.config.adaptiveTuning.draftPercentile, 0.85);
  assert.equal(loaded.config.adaptiveTuning.shortPercentile, 0.8);
  assert.equal(loaded.config.adaptiveTuning.learnedCapHeadroomTokens, 12);
  assert.equal(loaded.config.auth.enabled, true);
  assert.equal(loaded.config.auth.apiKeyEnv, "RAY_PUBLIC_API_KEYS");
  assert.deepEqual(
    resolveAuthApiKeys(loaded.config, { RAY_PUBLIC_API_KEYS: "alpha,beta" }),
    new Set(["alpha", "beta"]),
  );
  assert.equal(loaded.config.rateLimit.enabled, false);
  assert.equal(loaded.config.rateLimit.windowMs, 30_000);
  assert.equal(loaded.config.rateLimit.maxRequests, 45);
  assert.equal(loaded.config.rateLimit.maxKeys, 1_024);
  assert.equal(loaded.config.rateLimit.keyStrategy, "api-key");
  assert.equal(loaded.config.rateLimit.trustProxyHeaders, false);
});

test("documented portable 1b dotenv examples resolve to single-slot budgets", async () => {
  const examples = [
    {
      relativePath: "README.md",
      marker: "Common portable deploy and model overrides",
    },
    {
      relativePath: "examples/deploy/vps/README.md",
      marker: "For portable deployments, keep model-specific",
    },
  ];

  for (const example of examples) {
    const loaded = await loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.generic.public.json",
      env: await readDocumentedDotenvEnv(example.relativePath, example.marker),
    });

    if (
      loaded.config.model.adapter.kind !== "llama.cpp" ||
      !loaded.config.model.adapter.launchProfile
    ) {
      throw new Error(`Expected a llama.cpp launch profile for ${example.relativePath}`);
    }

    assert.equal(loaded.config.profile, "1b", example.relativePath);
    assert.equal(loaded.config.scheduler.concurrency, 1, example.relativePath);
    assert.equal(loaded.config.scheduler.maxInflightTokens, 2048, example.relativePath);
    assert.equal(loaded.config.model.adapter.launchProfile.ctxSize, 2048, example.relativePath);
    assert.equal(loaded.config.model.adapter.launchProfile.parallel, 1, example.relativePath);
    assert.ok(
      loaded.config.scheduler.maxInflightTokens <=
        loaded.config.model.adapter.launchProfile.ctxSize *
          loaded.config.model.adapter.launchProfile.parallel,
      example.relativePath,
    );
  }
});

test("loadRayConfig resolves relative llama.cpp launch paths against cwd", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.1b.json",
    env: {
      RAY_MODEL_PATH: "models/local-1b-q4.gguf",
      RAY_LLAMA_CPP_BINARY_PATH: "./bin/llama-server",
    },
  });

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(
    loaded.config.model.adapter.launchProfile.modelPath,
    join(process.cwd(), "models/local-1b-q4.gguf"),
  );
  assert.equal(
    loaded.config.model.adapter.launchProfile.binaryPath,
    join(process.cwd(), "bin/llama-server"),
  );
});

test("loadRayConfig rejects malformed environment overrides", async () => {
  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_LLAMA_CPP_CTX_SIZE: "2048MiB",
      },
    }),
    /Expected RAY_LLAMA_CPP_CTX_SIZE to be a positive integer/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      env: {
        RAY_PROFILE: "cluster",
      },
    }),
    /Expected RAY_PROFILE to be a supported Ray profile/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      env: {
        RAY_ASYNC_QUEUE_MAX_JOBS: "100jobs",
      },
    }),
    /Expected RAY_ASYNC_QUEUE_MAX_JOBS to be a positive integer/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      env: {
        RAY_ASYNC_QUEUE_COMPLETED_TTL_MS: "1h",
      },
    }),
    /Expected RAY_ASYNC_QUEUE_COMPLETED_TTL_MS to be a positive integer/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      env: {
        RAY_PORT: "70000",
      },
    }),
    /Expected RAY_PORT to be less than or equal to 65535/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_LLAMA_CPP_PORT: "70000",
      },
    }),
    /Expected RAY_LLAMA_CPP_PORT to be less than or equal to 65535/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_BASE_URL: "127.0.0.1:8081",
      },
    }),
    /model\.adapter\.baseUrl must be an absolute HTTP or HTTPS URL/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_BASE_URL: "http://ray:secret@127.0.0.1:8081",
      },
    }),
    /model\.adapter\.baseUrl must not include credentials/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD: "2",
      },
    }),
    /Expected RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD to be greater than 0 and less than or equal to 1/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_AUTH_ENABLED: "sometimes",
      },
    }),
    /Expected RAY_AUTH_ENABLED to be a boolean/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_AUTH_API_KEY_ENV: "RAY-API-KEYS",
      },
    }),
    /auth\.apiKeyEnv must be a valid environment variable name/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_API_KEY_ENV: "RAY UPSTREAM KEY",
      },
    }),
    /model\.adapter\.apiKeyEnv must be a valid environment variable name/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_RATE_LIMIT_KEY_STRATEGY: "bearer",
      },
    }),
    /Expected RAY_RATE_LIMIT_KEY_STRATEGY to be a supported rate-limit key strategy/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS: "callback.example,",
      },
    }),
    /Expected RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS to be comma-separated non-empty values/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_SCHEDULER_BATCH_WINDOW_MS: "-1",
      },
    }),
    /Expected RAY_SCHEDULER_BATCH_WINDOW_MS to be an integer greater than or equal to 0/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_CACHE_KEY_STRATEGY: "params",
      },
    }),
    /Expected RAY_CACHE_KEY_STRATEGY to be a supported cache key strategy/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS: "promptFamily,",
      },
    }),
    /Expected RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS to be comma-separated non-empty values/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_LLAMA_CPP_SLOT_ID: "-1",
      },
    }),
    /Expected RAY_LLAMA_CPP_SLOT_ID to be an integer greater than or equal to 0/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS: "0",
      },
    }),
    /Expected RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS to be a positive integer/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO: "1.5",
      },
    }),
    /Expected RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO to be between 0 and 1/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_ADAPTIVE_FAMILY_HISTORY_SIZE: "4",
        RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES: "8",
      },
    }),
    /adaptiveTuning\.learnedCapMinSamples must be less than or equal to 4/,
  );
});

test("loadRayConfig rejects non-boolean JSON config switches", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = join(tempDir, "ray.invalid.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "tiny",
      cache: {
        enabled: "false",
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    }),
    /cache.enabled must be a boolean/,
  );
});

test("loadRayConfig rejects invalid async queue storage caps", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = join(tempDir, "ray.invalid.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        minFreeStorageMiB: 0,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    }),
    /asyncQueue.minFreeStorageMiB must be a positive integer/,
  );
});

test("loadRayConfig rejects oversized mock adapter seeds", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-mock-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = join(tempDir, "ray.mock-seed.invalid.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "tiny",
      model: {
        adapter: {
          seed: "x".repeat(513),
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    }),
    /model\.adapter\.seed must be at most 512 characters/,
  );
});

test("loadRayConfig rejects oversized retained-entry budgets", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-oversized-retention-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const asyncQueueConfigPath = join(tempDir, "ray.async-jobs.invalid.json");
  await writeFile(
    asyncQueueConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        maxJobs: 2_001,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: asyncQueueConfigPath,
      env: {},
    }),
    /asyncQueue\.maxJobs must be less than or equal to 2000/,
  );

  const cacheConfigPath = join(tempDir, "ray.cache.invalid.json");
  await writeFile(
    cacheConfigPath,
    JSON.stringify({
      profile: "tiny",
      cache: {
        maxEntries: 4_097,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: cacheConfigPath,
      env: {},
    }),
    /cache\.maxEntries must be less than or equal to 4096/,
  );

  const cacheBytesConfigPath = join(tempDir, "ray.cache-bytes.invalid.json");
  await writeFile(
    cacheBytesConfigPath,
    JSON.stringify({
      profile: "tiny",
      cache: {
        maxBytes: 268_435_457,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: cacheBytesConfigPath,
      env: {},
    }),
    /cache\.maxBytes must be less than or equal to 268435456/,
  );

  const rateLimitConfigPath = join(tempDir, "ray.rate-limit.invalid.json");
  await writeFile(
    rateLimitConfigPath,
    JSON.stringify({
      profile: "tiny",
      rateLimit: {
        maxKeys: 16_385,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: rateLimitConfigPath,
      env: {},
    }),
    /rateLimit\.maxKeys must be less than or equal to 16384/,
  );
});

test("loadRayConfig rejects oversized scheduler admission budgets", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-oversized-scheduler-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const concurrencyConfigPath = join(tempDir, "ray.scheduler-concurrency.invalid.json");
  await writeFile(
    concurrencyConfigPath,
    JSON.stringify({
      profile: "tiny",
      scheduler: {
        concurrency: 9,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: concurrencyConfigPath,
      env: {},
    }),
    /scheduler\.concurrency must be less than or equal to 8/,
  );

  const queueConfigPath = join(tempDir, "ray.scheduler-queue.invalid.json");
  await writeFile(
    queueConfigPath,
    JSON.stringify({
      profile: "tiny",
      scheduler: {
        maxQueue: 513,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: queueConfigPath,
      env: {},
    }),
    /scheduler\.maxQueue must be less than or equal to 512/,
  );

  const queuedTokensConfigPath = join(tempDir, "ray.scheduler-queued-tokens.invalid.json");
  await writeFile(
    queuedTokensConfigPath,
    JSON.stringify({
      profile: "tiny",
      scheduler: {
        maxQueuedTokens: 262_145,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: queuedTokensConfigPath,
      env: {},
    }),
    /scheduler\.maxQueuedTokens must be less than or equal to 262144/,
  );

  const inflightTokensConfigPath = join(tempDir, "ray.scheduler-inflight-tokens.invalid.json");
  await writeFile(
    inflightTokensConfigPath,
    JSON.stringify({
      profile: "tiny",
      scheduler: {
        maxInflightTokens: 65_537,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: inflightTokensConfigPath,
      env: {},
    }),
    /scheduler\.maxInflightTokens must be less than or equal to 65536/,
  );

  const launchCapacityConfigPath = join(tempDir, "ray.scheduler-launch-capacity.invalid.json");
  await writeFile(
    launchCapacityConfigPath,
    JSON.stringify({
      profile: "1b",
      scheduler: {
        maxInflightTokens: 2_049,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: launchCapacityConfigPath,
      env: {},
    }),
    /scheduler\.maxInflightTokens must be less than or equal to llama\.cpp launch context capacity/,
  );

  const dispatchConfigPath = join(tempDir, "ray.async-dispatch.invalid.json");
  await writeFile(
    dispatchConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        dispatchConcurrency: 9,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: dispatchConfigPath,
      env: {},
    }),
    /asyncQueue\.dispatchConcurrency must be less than or equal to 8/,
  );

  const attemptsConfigPath = join(tempDir, "ray.async-attempts.invalid.json");
  await writeFile(
    attemptsConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        maxAttempts: 101,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: attemptsConfigPath,
      env: {},
    }),
    /asyncQueue\.maxAttempts must be less than or equal to 100/,
  );

  const callbackAttemptsConfigPath = join(tempDir, "ray.async-callback-attempts.invalid.json");
  await writeFile(
    callbackAttemptsConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        maxCallbackAttempts: 101,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: callbackAttemptsConfigPath,
      env: {},
    }),
    /asyncQueue\.maxCallbackAttempts must be less than or equal to 100/,
  );
});

test("loadRayConfig rejects oversized scalar resource budgets", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-oversized-scalars-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const contextConfigPath = join(tempDir, "ray.context.invalid.json");
  await writeFile(
    contextConfigPath,
    JSON.stringify({
      profile: "tiny",
      model: {
        contextWindow: 32_769,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: contextConfigPath,
      env: {},
    }),
    /model\.contextWindow must be less than or equal to 32768/,
  );

  const outputContextConfigPath = join(tempDir, "ray.output-context.invalid.json");
  await writeFile(
    outputContextConfigPath,
    JSON.stringify({
      profile: "tiny",
      model: {
        contextWindow: 128,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: outputContextConfigPath,
      env: {},
    }),
    /model\.maxOutputTokens must be less than or equal to model\.contextWindow/,
  );

  const schedulerTimeoutConfigPath = join(tempDir, "ray.scheduler-timeout.invalid.json");
  await writeFile(
    schedulerTimeoutConfigPath,
    JSON.stringify({
      profile: "tiny",
      scheduler: {
        requestTimeoutMs: 120_001,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: schedulerTimeoutConfigPath,
      env: {},
    }),
    /scheduler\.requestTimeoutMs must be less than or equal to 120000/,
  );

  const adapterTimeoutConfigPath = join(tempDir, "ray.adapter-timeout.invalid.json");
  await writeFile(
    adapterTimeoutConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          timeoutMs: 120_001,
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: adapterTimeoutConfigPath,
      env: {},
    }),
    /model\.adapter\.timeoutMs must be less than or equal to 120000/,
  );

  const asyncConfigPath = join(tempDir, "ray.async-timing.invalid.json");
  await writeFile(
    asyncConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        completedTtlMs: 604_800_001,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: asyncConfigPath,
      env: {},
    }),
    /asyncQueue\.completedTtlMs must be less than or equal to 604800000/,
  );

  const rateLimitConfigPath = join(tempDir, "ray.rate-limit-requests.invalid.json");
  await writeFile(
    rateLimitConfigPath,
    JSON.stringify({
      profile: "tiny",
      rateLimit: {
        maxRequests: 10_001,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: rateLimitConfigPath,
      env: {},
    }),
    /rateLimit\.maxRequests must be less than or equal to 10000/,
  );

  const launchContextConfigPath = join(tempDir, "ray.launch-context.invalid.json");
  await writeFile(
    launchContextConfigPath,
    JSON.stringify({
      profile: "1b",
      model: {
        adapter: {
          launchProfile: {
            ctxSize: 8_193,
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: launchContextConfigPath,
      env: {},
    }),
    /model\.adapter\.launchProfile\.ctxSize must be less than or equal to model\.contextWindow/,
  );

  const launchBatchConfigPath = join(tempDir, "ray.launch-batch.invalid.json");
  await writeFile(
    launchBatchConfigPath,
    JSON.stringify({
      profile: "1b",
      model: {
        adapter: {
          launchProfile: {
            batchSize: 128,
            ubatchSize: 129,
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: launchBatchConfigPath,
      env: {},
    }),
    /model\.adapter\.launchProfile\.ubatchSize must be less than or equal to batchSize/,
  );
});

test("loadRayConfig rejects oversized scalar config strings", async () => {
  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_ID: "x".repeat(257),
      },
    }),
    /model\.id must be at most 256 characters/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_BASE_URL: `http://127.0.0.1/${"x".repeat(2_048)}`,
      },
    }),
    /model\.adapter\.baseUrl must be at most 2048 characters/,
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: "./examples/config/ray.1b.json",
      env: {
        RAY_MODEL_PATH: "x".repeat(4_097),
      },
    }),
    /model\.adapter\.launchProfile\.modelPath must be at most 4096 characters/,
  );
});

test("loadRayConfig rejects oversized structured config collections", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-oversized-collections-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const callbackHostsConfigPath = join(tempDir, "ray.callback-hosts.invalid.json");
  await writeFile(
    callbackHostsConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        callbackAllowedHosts: Array.from({ length: 65 }, (_value, index) => {
          return `callback-${index}.example.com`;
        }),
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: callbackHostsConfigPath,
      env: {},
    }),
    /asyncQueue\.callbackAllowedHosts must contain at most 64 entries/,
  );

  const promptKeysConfigPath = join(tempDir, "ray.prompt-keys.invalid.json");
  await writeFile(
    promptKeysConfigPath,
    JSON.stringify({
      profile: "tiny",
      promptCompiler: {
        familyMetadataKeys: Array.from({ length: 17 }, (_value, index) => `family${index}`),
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: promptKeysConfigPath,
      env: {},
    }),
    /promptCompiler\.familyMetadataKeys must contain at most 16 entries/,
  );

  const tagsConfigPath = join(tempDir, "ray.tags.invalid.json");
  await writeFile(
    tagsConfigPath,
    JSON.stringify({
      profile: "tiny",
      tags: Object.fromEntries(
        Array.from({ length: 65 }, (_value, index) => [`tag${index}`, "value"]),
      ),
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: tagsConfigPath,
      env: {},
    }),
    /tags must contain at most 64 entries/,
  );

  const unsafeTagsConfigPath = join(tempDir, "ray.tags-unsafe.invalid.json");
  await writeFile(
    unsafeTagsConfigPath,
    JSON.stringify({
      profile: "tiny",
      tags: JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: unsafeTagsConfigPath,
      env: {},
    }),
    /override key "__proto__" is not allowed at tags\.__proto__/,
  );

  const headersConfigPath = join(tempDir, "ray.headers.invalid.json");
  await writeFile(
    headersConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          headers: Object.fromEntries(
            Array.from({ length: 65 }, (_value, index) => [`x-test-${index}`, "value"]),
          ),
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: headersConfigPath,
      env: {},
    }),
    /model\.adapter\.headers must contain at most 64 entries/,
  );

  const unsafeHeaderConfigPath = join(tempDir, "ray.header-unsafe.invalid.json");
  await writeFile(
    unsafeHeaderConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          headers: {
            constructor: "polluted",
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: unsafeHeaderConfigPath,
      env: {},
    }),
    /override key "constructor" is not allowed at model\.adapter\.headers\.constructor/,
  );

  const headerNameConfigPath = join(tempDir, "ray.header-name.invalid.json");
  await writeFile(
    headerNameConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          headers: {
            "x bad": "value",
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: headerNameConfigPath,
      env: {},
    }),
    /model\.adapter\.headers names must be valid HTTP header token strings/,
  );

  const reservedHeaderConfigPath = join(tempDir, "ray.header-reserved.invalid.json");
  await writeFile(
    reservedHeaderConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          headers: {
            Host: "127.0.0.1:8081",
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: reservedHeaderConfigPath,
      env: {},
    }),
    /model\.adapter\.headers\.Host must not use a transport-controlled header name/,
  );

  const headerValueConfigPath = join(tempDir, "ray.header-value.invalid.json");
  await writeFile(
    headerValueConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          headers: {
            "x-test": "good\r\nbad",
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: headerValueConfigPath,
      env: {},
    }),
    /model\.adapter\.headers\.x-test must not contain NUL, CR, or LF characters/,
  );

  const unsafeTemplateVariablesConfigPath = join(
    tempDir,
    "ray.warmup-template-variables-unsafe.invalid.json",
  );
  await writeFile(
    unsafeTemplateVariablesConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          warmupRequests: [
            {
              templateId: "email.reply_classification.v1",
              templateVariables: {
                prototype: "polluted",
              },
            },
          ],
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: unsafeTemplateVariablesConfigPath,
      env: {},
    }),
    /override key "prototype" is not allowed at model\.adapter\.warmupRequests\.0\.templateVariables\.prototype/,
  );

  const unsafeWarmupConfigPath = join(tempDir, "ray.warmup-unsafe.invalid.json");
  await writeFile(
    unsafeWarmupConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          warmupRequests: [
            {
              constructor: "polluted",
              input: "ping",
            },
          ],
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: unsafeWarmupConfigPath,
      env: {},
    }),
    /override key "constructor" is not allowed at model\.adapter\.warmupRequests\.0\.constructor/,
  );

  const warmupsConfigPath = join(tempDir, "ray.warmups.invalid.json");
  await writeFile(
    warmupsConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          warmupRequests: Array.from({ length: 9 }, () => ({ input: "ping" })),
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: warmupsConfigPath,
      env: {},
    }),
    /model\.adapter\.warmupRequests must contain at most 8 entries/,
  );

  const warmupTokensConfigPath = join(tempDir, "ray.warmup-tokens.invalid.json");
  await writeFile(
    warmupTokensConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          warmupRequests: [{ input: "ping", maxTokens: 385 }],
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: warmupTokensConfigPath,
      env: {},
    }),
    /model\.adapter\.warmupRequests\[0\]\.maxTokens must be less than or equal to model\.maxOutputTokens/,
  );

  const extraArgsConfigPath = join(tempDir, "ray.extra-args.invalid.json");
  await writeFile(
    extraArgsConfigPath,
    JSON.stringify({
      profile: "1b",
      model: {
        adapter: {
          launchProfile: {
            extraArgs: Array.from({ length: 65 }, (_value, index) => `--flag-${index}`),
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: extraArgsConfigPath,
      env: {},
    }),
    /model\.adapter\.launchProfile\.extraArgs must contain at most 64 entries/,
  );
});

test("loadRayConfig validates async callback allowed host patterns", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-callback-hosts-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const validConfigPath = join(tempDir, "ray.callback-hosts.valid.json");
  await writeFile(
    validConfigPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        callbackAllowedHosts: [
          "callback.example",
          "*.trusted.example",
          "127.0.0.1",
          "[2001:db8::1]",
        ],
      },
    }),
  );

  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: validConfigPath,
    env: {},
  });

  assert.deepEqual(loaded.config.asyncQueue.callbackAllowedHosts, [
    "callback.example",
    "*.trusted.example",
    "127.0.0.1",
    "[2001:db8::1]",
  ]);

  for (const [index, callbackAllowedHost] of [
    "https://callback.example/ray-callback",
    "callback.example:443",
    "bad host.example",
    "*",
    "callback.*.example",
  ].entries()) {
    const invalidConfigPath = join(tempDir, `ray.callback-hosts.${index}.invalid.json`);
    await writeFile(
      invalidConfigPath,
      JSON.stringify({
        profile: "tiny",
        asyncQueue: {
          callbackAllowedHosts: [callbackAllowedHost],
        },
      }),
    );

    await assert.rejects(
      loadRayConfig({
        cwd: process.cwd(),
        configPath: invalidConfigPath,
        env: {},
      }),
      /asyncQueue\.callbackAllowedHosts entries must be exact host\/IP literals/,
    );
  }
});

test("loadRayConfig rejects invalid async queue completed job TTLs", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = join(tempDir, "ray.invalid.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "tiny",
      asyncQueue: {
        completedTtlMs: 0,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    }),
    /asyncQueue.completedTtlMs must be a positive integer/,
  );
});

test("loadRayConfig rejects invalid TCP port ranges", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-port-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const gatewayConfigPath = join(tempDir, "ray.gateway-port.invalid.json");
  await writeFile(
    gatewayConfigPath,
    JSON.stringify({
      profile: "tiny",
      server: {
        port: 70_000,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: gatewayConfigPath,
      env: {},
    }),
    /server\.port must be less than or equal to 65535/,
  );

  const llamaConfigPath = join(tempDir, "ray.llama-port.invalid.json");
  await writeFile(
    llamaConfigPath,
    JSON.stringify({
      profile: "1b",
      model: {
        adapter: {
          launchProfile: {
            port: 70_000,
          },
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: llamaConfigPath,
      env: {},
    }),
    /model\.adapter\.launchProfile\.port must be less than or equal to 65535/,
  );
});

test("loadRayConfig rejects oversized gateway request body limits", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-body-limit-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = join(tempDir, "ray.body-limit.invalid.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "tiny",
      server: {
        requestBodyLimitBytes: 1_048_577,
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    }),
    /server\.requestBodyLimitBytes must be less than or equal to 1048576/,
  );
});

test("loadRayConfig rejects invalid adapter base URLs", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-config-invalid-url-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const unsupportedSchemeConfigPath = join(tempDir, "ray.unsupported-url.invalid.json");
  await writeFile(
    unsupportedSchemeConfigPath,
    JSON.stringify({
      profile: "vps",
      model: {
        adapter: {
          baseUrl: "file:///tmp/llama.sock",
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: unsupportedSchemeConfigPath,
      env: {},
    }),
    /model\.adapter\.baseUrl must use the http or https scheme/,
  );

  const queryConfigPath = join(tempDir, "ray.query-url.invalid.json");
  await writeFile(
    queryConfigPath,
    JSON.stringify({
      profile: "1b",
      model: {
        adapter: {
          baseUrl: "http://127.0.0.1:8081?token=secret",
        },
      },
    }),
  );

  await assert.rejects(
    loadRayConfig({
      cwd: process.cwd(),
      configPath: queryConfigPath,
      env: {},
    }),
    /model\.adapter\.baseUrl must not include a query string or fragment/,
  );
});

test("loadRayConfig accepts sub1b email classifier variant", async () => {
  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: "./examples/config/ray.sub1b.classifier.json",
    env: {},
  });

  assert.equal(loaded.config.profile, "sub1b");
  assert.equal(loaded.config.model.maxOutputTokens, 96);
  assert.equal(loaded.config.model.operational?.tokensPerSecondTarget, 22);
  assert.equal(loaded.config.scheduler.shortJobMaxTokens, 64);

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.launchProfile.ctxSize, 2048);
  assert.equal(loaded.config.model.adapter.launchProfile.cacheRamMiB, 384);
});
