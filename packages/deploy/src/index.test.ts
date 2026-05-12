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
  renderDeploymentBundle,
  renderEnvironmentFileExample,
  renderLlamaCppService,
  renderSystemdService,
} from "./index.js";

test("renderSystemdService includes hardening directives", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.sub1b.public.json",
    user: "ray",
    envFile: "/etc/ray/ray.env",
    stateDirectory: "ray",
  });

  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=full/);
  assert.match(service, /EnvironmentFile=\/etc\/ray\/ray.env/);
  assert.match(service, /StateDirectory=ray/);
  assert.match(service, /StartLimitIntervalSec=60/);
  assert.match(service, /StartLimitBurst=10/);
  assert.match(service, /TimeoutStopSec=35/);
  assert.match(service, /KillSignal=SIGTERM/);
  assert.match(service, /KillMode=mixed/);
  assert.match(service, /TasksMax=128/);
  assert.match(service, /CPUAccounting=true/);
  assert.match(service, /MemoryAccounting=true/);
  assert.match(service, /IOAccounting=true/);
  assert.match(service, /CapabilityBoundingSet=\n/);
  assert.match(service, /SystemCallArchitectures=native/);
  assert.match(service, /PrivateDevices=true/);
  assert.match(service, /ProtectClock=true/);
  assert.match(service, /ProtectKernelModules=true/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(service, /RestrictRealtime=true/);
});

test("renderSystemdService can order the gateway after local backend units", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.json",
    user: "ray",
    after: ["ray-llama-cpp.service", "network.target"],
    wants: ["ray-llama-cpp.service", "ray-llama-cpp.service"],
  });

  assert.match(service, /Wants=ray-llama-cpp\.service/);
  assert.match(service, /After=network\.target ray-llama-cpp\.service/);
  assert.doesNotMatch(service, /After=.*network\.target.*network\.target/);
});

test("renderSystemdService escapes ExecStart arguments", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray current",
    configPath: "/etc/ray/ray 100%.json",
    user: "ray",
    envFile: "/etc/ray/ray 100%.env",
    nodeBinary: "/opt/node 22/bin/node",
  });

  assert.match(service, /WorkingDirectory="\/srv\/ray current"/);
  assert.match(service, /EnvironmentFile="\/etc\/ray\/ray 100%%\.env"/);
  assert.match(
    service,
    /ExecStart="\/opt\/node 22\/bin\/node" "\/srv\/ray current\/apps\/gateway\/dist\/index\.js" --config "\/etc\/ray\/ray 100%%\.json"/,
  );
});

test("renderSystemdService rejects unsafe systemd execution directives", () => {
  const baseOptions = {
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.json",
    user: "ray",
  };

  assert.throws(
    () => renderSystemdService(null as never),
    /Systemd service options must be an object/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        after: "ray-llama-cpp.service" as never,
      }),
    /after must be an array of strings/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        wants: Array.from({ length: 33 }, (_value, index) => `ray-${index}.service`),
      }),
    /wants must contain at most 32 entries/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        after: [42 as never],
      }),
    /after\[0\] must be a string/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        after: ["x".repeat(257)],
      }),
    /after\[0\] must be at most 256 characters/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        nodeBinary: "node",
      }),
    /nodeBinary must be an absolute path/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: ".",
        configPath: "/etc/ray/ray.json",
        user: "ray",
      }),
    /workingDirectory must be an absolute path/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        envFile: "ray.env",
      }),
    /envFile must be an absolute path/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray deploy",
      }),
    /user must be a system account name/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "%i",
      }),
    /user must be a system account name/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray;root",
      }),
    /user must be a system account name/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        after: ["bad unit.service"],
      }),
    /After unit cannot contain whitespace/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray\nExecStart=/bin/false",
        configPath: "/etc/ray/ray.json",
        user: "ray",
      }),
    /workingDirectory cannot contain control characters/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        stateDirectory: "/var/lib/ray",
      }),
    /stateDirectory must be a relative systemd state directory/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        stateDirectory: "../ray",
      }),
    /stateDirectory must be a relative systemd state directory/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        stateDirectory: "ray cache",
      }),
    /stateDirectory must be a relative systemd state directory/,
  );
});

test("renderCaddyfile applies body size and health checks", () => {
  const caddyfile = renderCaddyfile({
    domain: "ray.example.com",
    upstreamPort: 3000,
    requestBodyLimitBytes: 64_000,
    upstreamTimeoutMs: 25_000,
  });

  assert.match(caddyfile, /^ray\.example\.com \{/);
  assert.match(caddyfile, /max_size 64000/);
  assert.match(caddyfile, /health_uri \/livez/);
  assert.match(caddyfile, /dial_timeout 5s/);
  assert.match(caddyfile, /response_header_timeout 25s/);
  assert.match(caddyfile, /read_timeout 25s/);
  assert.match(caddyfile, /write_timeout 10s/);
});

test("renderCaddyfile rejects unsafe site addresses and numeric limits", () => {
  assert.throws(() => renderCaddyfile(null as never), /Caddyfile options must be an object/);

  assert.throws(
    () =>
      renderCaddyfile({
        domain: 42 as never,
        upstreamPort: 3000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 25_000,
      }),
    /Caddy site address must be a non-empty string/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com {",
        upstreamPort: 3000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 25_000,
      }),
    /site address/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com alt.example.com",
        upstreamPort: 3000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 25_000,
      }),
    /site address/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com",
        upstreamPort: 70_000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 25_000,
      }),
    /upstreamPort/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com",
        upstreamPort: 3000,
        requestBodyLimitBytes: 0,
        upstreamTimeoutMs: 25_000,
      }),
    /requestBodyLimitBytes/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com",
        upstreamPort: 3000,
        requestBodyLimitBytes: 1_048_577,
        upstreamTimeoutMs: 25_000,
      }),
    /requestBodyLimitBytes must be less than or equal to 1048576/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com",
        upstreamPort: 3000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 125_001,
      }),
    /upstreamTimeoutMs must be less than or equal to 125000/,
  );

  assert.throws(
    () =>
      renderCaddyfile({
        domain: "ray.example.com",
        upstreamPort: 3000,
        requestBodyLimitBytes: 64_000,
        upstreamTimeoutMs: 0,
      }),
    /upstreamTimeoutMs/,
  );
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

test("diagnoseConfig surfaces invalid auth key material without retaining secrets", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: true,
    },
  });
  const diagnostics = diagnoseConfig(config, {
    RAY_API_KEYS: "secret-".repeat(200),
  });
  const diagnostic = diagnostics.find((entry) => entry.code === "auth_keys_missing");

  assert.ok(diagnostic);
  assert.match(diagnostic.message, /RAY_API_KEYS entries must be at most 1024 characters/);
  assert.doesNotMatch(diagnostic.message, /secret-secret/);
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

test("renderEnvironmentFileExample documents portable llama.cpp model overrides", () => {
  const config = createDefaultConfig("1b");
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_MODEL_ID=/);
  assert.match(envFile, /RAY_MODEL_PATH=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CTX_SIZE=/);
  assert.match(envFile, /RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=/);
});

test("renderEnvironmentFileExample documents async queue retention overrides", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      maxJobs: 500,
      completedTtlMs: 3_600_000,
    },
  });
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_ASYNC_QUEUE_STORAGE_DIR=\/var\/lib\/ray\/async-queue/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_MAX_JOBS=500/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=3600000/);
});

test("renderDeploymentBundle includes llama.cpp service for generic 1b profiles", async () => {
  const bundle = await renderDeploymentBundle({
    cwd: ".",
    configPath: "./examples/config/ray.1b.generic.public.json",
    user: "ray",
    domain: "ray.example.com",
    envFile: "/etc/ray/ray.env",
    env: {
      RAY_API_KEYS: "test-key",
    },
    memoryBudgetMiB: 4096,
    nodeBinary: "/opt/node 22/bin/node",
  });

  assert.match(bundle.service, /Ray Gateway/);
  assert.match(
    bundle.service,
    new RegExp(`WorkingDirectory=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(bundle.service, /ExecStart="\/opt\/node 22\/bin\/node"/);
  assert.match(bundle.service, /StateDirectory=ray/);
  assert.match(bundle.service, /Wants=ray-llama-cpp\.service/);
  assert.match(bundle.service, /After=network\.target ray-llama-cpp\.service/);
  assert.match(bundle.caddyfile, /response_header_timeout 37s/);
  assert.match(bundle.caddyfile, /read_timeout 37s/);
  assert.match(bundle.llamaCppService ?? "", /llama\.cpp Server for Ray/);
  assert.doesNotMatch(bundle.llamaCppService ?? "", /EnvironmentFile=\/etc\/ray\/ray.env/);
  assert.match(
    bundle.llamaCppService ?? "",
    /LLAMA_ARG_MODEL=\/var\/lib\/ray\/models\/local-1b-q4\.gguf/,
  );
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
  assert.match(service, /StartLimitIntervalSec=60/);
  assert.match(service, /StartLimitBurst=10/);
  assert.match(service, /TimeoutStopSec=35/);
  assert.match(service, /KillSignal=SIGTERM/);
  assert.match(service, /KillMode=mixed/);
  assert.match(service, /TasksMax=256/);
  assert.match(service, /CPUAccounting=true/);
  assert.match(service, /MemoryAccounting=true/);
  assert.match(service, /IOAccounting=true/);
  assert.match(service, /CapabilityBoundingSet=\n/);
  assert.match(service, /SystemCallArchitectures=native/);
  assert.match(service, /PrivateDevices=true/);
  assert.match(service, /ProtectClock=true/);
  assert.match(service, /ProtectKernelModules=true/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(service, /RestrictRealtime=true/);
});

test("renderLlamaCppService rejects relative binary paths", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const { launchProfile } = config.model.adapter;
  launchProfile.binaryPath = "llama-server";

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile,
      }),
    /model\.adapter\.launchProfile\.binaryPath must be an absolute path/,
  );
});

test("renderLlamaCppService rejects malformed service options and launch profiles", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const { launchProfile } = config.model.adapter;

  assert.throws(
    () => renderLlamaCppService(null as never),
    /llama\.cpp service options must be an object/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: null as never,
      }),
    /model\.adapter\.launchProfile must be an object/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          modelPath: "models/local-1b.gguf",
        },
      }),
    /model\.adapter\.launchProfile\.modelPath must be an absolute path/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          cachePrompt: "true" as never,
        },
      }),
    /model\.adapter\.launchProfile\.cachePrompt must be a boolean/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          extraArgs: "--log-prefix" as never,
        },
      }),
    /model\.adapter\.launchProfile\.extraArgs must be an array of non-empty strings/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          extraArgs: Array.from({ length: 65 }, (_value, index) => `--flag-${index}`),
        },
      }),
    /model\.adapter\.launchProfile\.extraArgs must contain at most 64 entries/,
  );
});

test("renderLlamaCppService escapes systemd directive values", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const service = renderLlamaCppService({
    user: "ray",
    envFile: "/etc/ray/ray 100%.env",
    launchProfile: config.model.adapter.launchProfile,
  });

  assert.match(service, /EnvironmentFile="\/etc\/ray\/ray 100%%\.env"/);
});

test("renderLlamaCppService rejects unsafe service users", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const { launchProfile } = config.model.adapter;

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "%i",
        launchProfile,
      }),
    /user must be a system account name/,
  );
});

test("renderLlamaCppService quotes systemd environment values", () => {
  const service = renderLlamaCppService({
    user: "ray",
    launchProfile: {
      preset: "single-vps-1b-cx23",
      binaryPath: "/usr/local/bin/llama-server",
      modelPath: "/var/lib/ray/models/local 1b 100%.gguf",
      alias: 'local "1b"',
      host: "127.0.0.1",
      port: 8081,
      ctxSize: 2048,
      parallel: 1,
      threads: 2,
      threadsHttp: 2,
      batchSize: 192,
      ubatchSize: 96,
      cachePrompt: true,
      cacheReuse: 192,
      cacheRamMiB: 384,
      continuousBatching: true,
      enableMetrics: true,
      exposeSlots: true,
      warmup: true,
      enableUnifiedKv: true,
      cacheIdleSlots: true,
      contextShift: true,
    },
  });

  assert.match(
    service,
    /Environment="LLAMA_ARG_MODEL=\/var\/lib\/ray\/models\/local 1b 100%%\.gguf"/,
  );
  assert.match(service, /Environment="LLAMA_ARG_ALIAS=local \\"1b\\""/);
  assert.doesNotMatch(service, /Environment=LLAMA_ARG_MODEL=/);
});

test("renderLlamaCppService escapes ExecStart arguments", () => {
  const service = renderLlamaCppService({
    user: "ray",
    launchProfile: {
      preset: "single-vps-1b-cx23",
      binaryPath: "/opt/llama cpp/llama-server",
      modelPath: "/var/lib/ray/models/local-1b.gguf",
      host: "127.0.0.1",
      port: 8081,
      ctxSize: 2048,
      parallel: 1,
      threads: 2,
      threadsHttp: 2,
      batchSize: 192,
      ubatchSize: 96,
      cachePrompt: true,
      cacheReuse: 192,
      cacheRamMiB: 384,
      continuousBatching: true,
      enableMetrics: true,
      exposeSlots: true,
      warmup: true,
      enableUnifiedKv: true,
      cacheIdleSlots: true,
      contextShift: true,
      extraArgs: ["--log-prefix", "ray 100%", '--jinja-template={{ role == "user" }}'],
    },
  });

  assert.match(
    service,
    /ExecStart="\/opt\/llama cpp\/llama-server" --log-prefix "ray 100%%" "--jinja-template=\{\{ role == \\"user\\" \}\}"/,
  );
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

test("buildLlamaCppEnvironment rejects malformed direct launch profiles", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  const { launchProfile } = config.model.adapter;

  assert.throws(
    () => buildLlamaCppEnvironment(null as never),
    /model\.adapter\.launchProfile must be an object/,
  );

  assert.throws(
    () =>
      buildLlamaCppEnvironment({
        ...launchProfile,
        modelPath: "models/local-1b.gguf",
      }),
    /model\.adapter\.launchProfile\.modelPath must be an absolute path/,
  );

  assert.throws(
    () =>
      buildLlamaCppEnvironment({
        ...launchProfile,
        cacheReuse: -1,
      }),
    /model\.adapter\.launchProfile\.cacheReuse must be a non-negative integer/,
  );

  assert.throws(
    () =>
      buildLlamaCppEnvironment({
        ...launchProfile,
        continuousBatching: "true" as never,
      }),
    /model\.adapter\.launchProfile\.continuousBatching must be a boolean/,
  );
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

test("diagnoseConfig warns when the cax11 preset is overcommitted", () => {
  const config = createDefaultConfig("sub1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.ok(config.model.adapter.launchProfile);

  const launchProfile = config.model.adapter.launchProfile;
  launchProfile.preset = "single-vps-sub1b-cax11";
  launchProfile.parallel = 2;

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "cax11_parallel_high"));
});

test("diagnoseConfig warns when async queue storage is not durable", () => {
  const relativeConfig = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: ".ray/async-queue",
    },
  });
  const temporaryConfig = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: join(tmpdir(), "ray-async-queue"),
    },
  });

  const relativeDiagnostics = diagnoseConfig(relativeConfig, process.env);
  const temporaryDiagnostics = diagnoseConfig(temporaryConfig, process.env);

  assert.ok(
    relativeDiagnostics.some((diagnostic) => diagnostic.code === "async_queue_storage_relative"),
  );
  assert.ok(
    temporaryDiagnostics.some((diagnostic) => diagnostic.code === "async_queue_storage_volatile"),
  );
});

test("diagnoseConfig errors when generated llama.cpp service paths are relative", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.model.adapter.launchProfile.binaryPath = "llama-server";
  config.model.adapter.launchProfile.modelPath = "models/local-1b.gguf";

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "llama_binary_path_relative"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "llama_model_path_relative"));
});

test("diagnoseConfig errors when generated systemd paths are hidden by ProtectHome", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/home/ray/async-queue",
    },
  });

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.model.adapter.launchProfile.binaryPath = "/home/ray/bin/llama-server";
  config.model.adapter.launchProfile.modelPath = "/root/models/local-1b.gguf";

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "async_queue_storage_home_protected"),
  );
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "llama_binary_path_home_protected"),
  );
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === "llama_model_path_home_protected"),
  );
});

test("diagnoseConfig errors when generated llama.cpp service binds publicly", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.model.adapter.launchProfile.host = "0.0.0.0";

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "llama_launch_host_public"));
});

test("diagnoseConfig errors when generated gateway service binds publicly", () => {
  const config = createDefaultConfig("1b");
  config.server.host = "0.0.0.0";

  const diagnostics = diagnoseConfig(config, process.env);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "gateway_bind_host_public"));
});

test("diagnoseConfig errors when Ray points away from the generated llama.cpp service", () => {
  const publicBaseUrlConfig = createDefaultConfig("1b");
  const portMismatchConfig = createDefaultConfig("1b");
  const schemeMismatchConfig = createDefaultConfig("1b");
  const pathMismatchConfig = createDefaultConfig("1b");
  const hostMismatchConfig = createDefaultConfig("1b");

  if (
    publicBaseUrlConfig.model.adapter.kind !== "llama.cpp" ||
    portMismatchConfig.model.adapter.kind !== "llama.cpp" ||
    schemeMismatchConfig.model.adapter.kind !== "llama.cpp" ||
    pathMismatchConfig.model.adapter.kind !== "llama.cpp" ||
    hostMismatchConfig.model.adapter.kind !== "llama.cpp" ||
    !hostMismatchConfig.model.adapter.launchProfile
  ) {
    throw new Error("Expected llama.cpp adapters");
  }

  publicBaseUrlConfig.model.adapter.baseUrl = "http://203.0.113.10:8081";
  portMismatchConfig.model.adapter.baseUrl = "http://127.0.0.1:9090";
  schemeMismatchConfig.model.adapter.baseUrl = "https://127.0.0.1:8081";
  pathMismatchConfig.model.adapter.baseUrl = "http://127.0.0.1:8081/v1";
  hostMismatchConfig.model.adapter.launchProfile.host = "127.0.0.2";
  hostMismatchConfig.model.adapter.baseUrl = "http://127.0.0.1:8081";

  const publicBaseUrlDiagnostics = diagnoseConfig(publicBaseUrlConfig, process.env);
  const portMismatchDiagnostics = diagnoseConfig(portMismatchConfig, process.env);
  const schemeMismatchDiagnostics = diagnoseConfig(schemeMismatchConfig, process.env);
  const pathMismatchDiagnostics = diagnoseConfig(pathMismatchConfig, process.env);
  const hostMismatchDiagnostics = diagnoseConfig(hostMismatchConfig, process.env);

  assert.ok(
    publicBaseUrlDiagnostics.some((diagnostic) => diagnostic.code === "llama_base_url_public"),
  );
  assert.ok(
    portMismatchDiagnostics.some(
      (diagnostic) => diagnostic.code === "llama_base_url_launch_mismatch",
    ),
  );
  assert.ok(
    schemeMismatchDiagnostics.some(
      (diagnostic) => diagnostic.code === "llama_base_url_scheme_mismatch",
    ),
  );
  assert.ok(
    pathMismatchDiagnostics.some(
      (diagnostic) => diagnostic.code === "llama_base_url_path_mismatch",
    ),
  );
  assert.ok(
    hostMismatchDiagnostics.some(
      (diagnostic) => diagnostic.code === "llama_base_url_host_mismatch",
    ),
  );
});

test("diagnoseConfig errors when systemd EnvironmentFile paths are relative", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, { RAY_API_KEYS: "test-key" }, "ray.env");

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "env_file_relative"));
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
