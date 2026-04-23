import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import {
  buildLlamaCppEnvironment,
  diagnoseConfig,
  loadAndDiagnoseDeployment,
  renderCaddyfile,
  renderEnvironmentFileExample,
  renderLlamaCppService,
  renderSystemdService,
} from "./index.js";

test("renderSystemdService includes hardening directives", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.vps.json",
    user: "ray",
    envFile: "/etc/ray/ray.env",
  });

  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=full/);
  assert.match(service, /EnvironmentFile=\/etc\/ray\/ray.env/);
});

test("renderCaddyfile applies body size and health checks", () => {
  const caddyfile = renderCaddyfile({
    domain: "ray.example.com",
    upstreamPort: 3000,
    requestBodyLimitBytes: 64_000,
  });

  assert.match(caddyfile, /max_size 64000/);
  assert.match(caddyfile, /health_uri \/health/);
});

test("diagnoseConfig flags unsafe public deployment defaults", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: false,
    },
    rateLimit: {
      enabled: false,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "auth_disabled"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "rate_limit_disabled"));
});

test("renderEnvironmentFileExample includes auth env placeholders", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: true,
      apiKeyEnv: "RAY_API_KEYS",
    },
  });

  const envFile = renderEnvironmentFileExample(config);
  assert.match(envFile, /RAY_API_KEYS=/);
});

test("renderLlamaCppService emits a single-vps launch profile", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.6b-test",
        timeoutMs: 20_000,
        launchProfile: {
          preset: "single-vps-sub1b",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: "/models/qwen.gguf",
          host: "127.0.0.1",
          port: 8081,
          ctxSize: 3072,
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
  });

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const service = renderLlamaCppService({
    user: "ray",
    launchProfile: config.model.adapter.launchProfile,
  });
  assert.match(service, /LLAMA_ARG_CTX_SIZE=3072/);
  assert.match(service, /LLAMA_ARG_N_PARALLEL=2/);
  assert.match(service, /LLAMA_ARG_CACHE_RAM=512/);
  assert.match(service, /LLAMA_ARG_WARMUP=1/);
  assert.match(service, /LLAMA_ARG_KV_UNIFIED=1/);
  assert.match(service, /LLAMA_ARG_CACHE_IDLE_SLOTS=1/);
  assert.match(service, /LLAMA_ARG_CONTEXT_SHIFT=1/);
  assert.match(service, /ExecStart=\/usr\/local\/bin\/llama-server/);
});

test("buildLlamaCppEnvironment emits cache and slot flags explicitly", () => {
  const environment = buildLlamaCppEnvironment({
    preset: "single-vps-sub1b",
    binaryPath: "/usr/local/bin/llama-server",
    modelPath: "/models/qwen.gguf",
    host: "127.0.0.1",
    port: 8081,
    ctxSize: 3072,
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
  });

  assert.equal(environment.LLAMA_ARG_CACHE_RAM, "512");
  assert.equal(environment.LLAMA_ARG_KV_UNIFIED, "1");
  assert.equal(environment.LLAMA_ARG_CACHE_IDLE_SLOTS, "1");
});

test("diagnoseConfig flags missing or mismatched llama.cpp launch settings", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    scheduler: {
      concurrency: 3,
    },
    model: {
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.6b-test",
        timeoutMs: 20_000,
        cachePrompt: false,
        launchProfile: {
          preset: "single-vps-sub1b",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: "/models/qwen.gguf",
          host: "127.0.0.1",
          port: 8081,
          ctxSize: 8192,
          parallel: 2,
          threads: 2,
          threadsHttp: 2,
          batchSize: 256,
          ubatchSize: 128,
          cachePrompt: false,
          cacheReuse: 64,
          cacheRamMiB: 0,
          continuousBatching: true,
          enableMetrics: false,
          exposeSlots: false,
          warmup: true,
          enableUnifiedKv: false,
          cacheIdleSlots: true,
          contextShift: true,
        },
      },
    },
  });

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "cache_prompt_disabled"));
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "cache_idle_slots_without_cache_ram"),
  );
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "cache_idle_slots_without_unified_kv"),
  );
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "scheduler_exceeds_parallel"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "ctx_per_slot_high"));
});

test("diagnoseConfig warns when cache RAM is left implicit on a small VPS launch profile", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.6b-test",
        timeoutMs: 20_000,
        launchProfile: {
          preset: "single-vps-sub1b",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: "/models/qwen.gguf",
          host: "127.0.0.1",
          port: 8081,
          ctxSize: 3072,
          parallel: 2,
          threads: 2,
          threadsHttp: 2,
          batchSize: 256,
          ubatchSize: 128,
          cachePrompt: true,
          cacheReuse: 64,
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
  });

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "cache_ram_implicit"));
});

test("loadAndDiagnoseDeployment errors when the projected memory fit exceeds a 4 GB target", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-memory-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "oversized.gguf");
  await writeFile(modelPath, "");
  await truncate(modelPath, 2_500 * 1_024 * 1_024);

  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      maxOutputTokens: 256,
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-1b-test",
        timeoutMs: 20_000,
        launchProfile: {
          preset: "single-vps-sub1b",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath,
          host: "127.0.0.1",
          port: 8081,
          ctxSize: 3072,
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
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "memory_fit_exceeded");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /Projected llama\.cpp working set is about/);
  assert.match(diagnostic.message, /safe budget of 3,276 MiB/);
});

test("loadAndDiagnoseDeployment errors when the configured model file is missing in strict mode", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-model-missing-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        kind: "llama.cpp",
        baseUrl: "http://127.0.0.1:8081",
        modelRef: "qwen2.5-0.6b-test",
        timeoutMs: 20_000,
        launchProfile: {
          preset: "single-vps-sub1b",
          binaryPath: "/usr/local/bin/llama-server",
          modelPath: join(tempDir, "missing.gguf"),
          host: "127.0.0.1",
          port: 8081,
          ctxSize: 3072,
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
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "model_file_missing");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /was not found/);
});
