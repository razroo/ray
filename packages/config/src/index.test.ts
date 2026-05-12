import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRayConfig } from "./index.js";

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
  assert.equal(generic8gb.config.model.adapter.launchProfile.preset, "single-vps-1b-8gb");
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
      RAY_MODEL_PATH: "/models/local-any-1b-q4.gguf",
      RAY_LLAMA_CPP_BINARY_PATH: "/opt/llama.cpp/llama-server",
      RAY_LLAMA_CPP_HOST: "127.0.0.1",
      RAY_LLAMA_CPP_PORT: "8090",
      RAY_LLAMA_CPP_CTX_SIZE: "1536",
      RAY_LLAMA_CPP_PARALLEL: "1",
      RAY_LLAMA_CPP_THREADS: "2",
      RAY_LLAMA_CPP_CACHE_RAM_MIB: "256",
      RAY_SCHEDULER_MAX_INFLIGHT_TOKENS: "2048",
      RAY_ASYNC_QUEUE_STORAGE_DIR: ".ray/test-async-queue",
      RAY_ASYNC_QUEUE_MAX_JOBS: "250",
      RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB: "192",
      RAY_ASYNC_QUEUE_COMPLETED_TTL_MS: "3600000",
      RAY_CACHE_MAX_ENTRIES: "128",
      RAY_DEGRADATION_MAX_PROMPT_CHARS: "4200",
      RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB: "448",
    },
  });

  assert.equal(loaded.config.model.id, "local-any-1b-q4");
  assert.equal(loaded.config.model.family, "generic-llama");
  assert.equal(loaded.config.model.quantization, "q4_0");
  assert.equal(loaded.config.model.adapter.kind, "llama.cpp");

  if (
    loaded.config.model.adapter.kind !== "llama.cpp" ||
    !loaded.config.model.adapter.launchProfile
  ) {
    throw new Error("Expected a llama.cpp launch profile");
  }

  assert.equal(loaded.config.model.adapter.baseUrl, "http://127.0.0.1:8090");
  assert.equal(loaded.config.model.adapter.modelRef, "local-any-1b-q4");
  assert.equal(loaded.config.model.adapter.launchProfile.binaryPath, "/opt/llama.cpp/llama-server");
  assert.equal(loaded.config.model.adapter.launchProfile.modelPath, "/models/local-any-1b-q4.gguf");
  assert.equal(loaded.config.model.adapter.launchProfile.alias, "local-any-1b-q4");
  assert.equal(loaded.config.model.adapter.launchProfile.ctxSize, 1536);
  assert.equal(loaded.config.model.adapter.launchProfile.cacheRamMiB, 256);
  assert.equal(loaded.config.model.operational?.preferredCtxSize, 1536);
  assert.equal(loaded.config.scheduler.maxInflightTokens, 2048);
  assert.equal(loaded.config.asyncQueue.storageDir, join(process.cwd(), ".ray/test-async-queue"));
  assert.equal(loaded.config.asyncQueue.maxJobs, 250);
  assert.equal(loaded.config.asyncQueue.minFreeStorageMiB, 192);
  assert.equal(loaded.config.asyncQueue.completedTtlMs, 3_600_000);
  assert.equal(loaded.config.cache.maxEntries, 128);
  assert.equal(loaded.config.gracefulDegradation.maxPromptChars, 4200);
  assert.equal(loaded.config.gracefulDegradation.memoryRssThresholdMiB, 448);
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
