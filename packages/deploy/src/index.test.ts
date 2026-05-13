import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
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

const repoRoot = process.cwd();
const compatibleLlamaCppHelp = [
  "--model",
  "--alias",
  "--host",
  "--port",
  "--ctx-size",
  "--parallel",
  "--threads",
  "--threads-batch",
  "--threads-http",
  "--batch-size",
  "--ubatch-size",
  "--cache-prompt",
  "--cache-reuse",
  "--cache-ram",
  "--cont-batching",
  "--metrics",
  "--slots",
  "--warmup",
  "--kv-unified",
  "--cache-idle-slots",
  "--context-shift",
].join("\n");

async function mkRayDeployTempDir(prefix: string): Promise<string> {
  // Linux CI checkouts usually live under /home, and tmpdir() is /tmp; both are
  // intentionally rejected for generated systemd WorkingDirectory values.
  const tempRoots = [
    "/proc/self/cwd/.ray/test-tmp",
    "/dev/shm/ray-deploy-tests",
    join(repoRoot, ".ray", "test-tmp"),
  ];
  let lastError: unknown;

  for (const tempRoot of tempRoots) {
    try {
      await mkdir(tempRoot, { recursive: true });
      return await mkdtemp(join(tempRoot, prefix));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Could not create deploy test temp dir");
}

test("renderSystemdService includes hardening directives", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.sub1b.public.json",
    user: "ray",
    envFile: "/etc/ray/ray.env",
    stateDirectory: "ray",
  });

  assert.match(
    service,
    /ExecStart=\/usr\/local\/bin\/bun \/srv\/ray\/apps\/gateway\/dist\/index\.js/,
  );
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=full/);
  assert.match(service, /EnvironmentFile=\/etc\/ray\/ray.env/);
  assert.match(service, /StateDirectory=ray/);
  assert.match(service, /StartLimitIntervalSec=60/);
  assert.match(service, /StartLimitBurst=10/);
  assert.match(service, /LogRateLimitIntervalSec=30s/);
  assert.match(service, /LogRateLimitBurst=200/);
  assert.match(service, /TimeoutStopSec=35/);
  assert.match(service, /KillSignal=SIGTERM/);
  assert.match(service, /KillMode=mixed/);
  assert.match(service, /OOMPolicy=stop/);
  assert.match(service, /OOMScoreAdjust=-250/);
  assert.match(service, /TasksMax=128/);
  assert.match(service, /CPUAccounting=true/);
  assert.match(service, /MemoryAccounting=true/);
  assert.match(service, /IOAccounting=true/);
  assert.match(service, /CapabilityBoundingSet=\n/);
  assert.match(service, /SystemCallArchitectures=native/);
  assert.match(service, /PrivateDevices=true/);
  assert.match(service, /ProtectClock=true/);
  assert.match(service, /ProtectHostname=true/);
  assert.match(service, /ProtectKernelModules=true/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(service, /RestrictNamespaces=true/);
  assert.match(service, /RestrictRealtime=true/);
  assert.doesNotMatch(service, /MemoryDenyWriteExecute=true/);
});

test("renderSystemdService renders optional memory controls", () => {
  const service = renderSystemdService({
    workingDirectory: "/srv/ray",
    configPath: "/etc/ray/ray.json",
    user: "ray",
    memoryHighMiB: 640,
    memoryMaxMiB: 896,
    memorySwapMaxMiB: 128,
    cpuWeight: 200,
  });

  assert.match(service, /MemoryHigh=640M/);
  assert.match(service, /MemoryMax=896M/);
  assert.match(service, /MemorySwapMax=128M/);
  assert.match(service, /CPUWeight=200/);
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
    /runtimeBinary must be an absolute path/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        runtimeBinary: "/home/ray/.bun/bin/bun",
      }),
    /runtimeBinary is under \/home, \/root, or \/run\/user/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
        runtimeBinary: "/tmp/bun",
      }),
    /runtimeBinary is under \/tmp or \/var\/tmp/,
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
        workingDirectory: "/home/ray/current",
        configPath: "/etc/ray/ray.json",
        user: "ray",
      }),
    /workingDirectory is under \/home, \/root, or \/run\/user/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/var/tmp/ray",
        configPath: "/etc/ray/ray.json",
        user: "ray",
      }),
    /workingDirectory is under \/tmp or \/var\/tmp/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/home/ray/ray.json",
        user: "ray",
      }),
    /configPath resolves under \/home, \/root, or \/run\/user/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        workingDirectory: "/srv/ray",
        configPath: "/tmp/ray.json",
        user: "ray",
      }),
    /configPath resolves under \/tmp or \/var\/tmp/,
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

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        memoryHighMiB: 0,
      }),
    /memoryHighMiB must be a positive integer/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        memorySwapMaxMiB: 0,
      }),
    /memorySwapMaxMiB must be a positive integer/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        memoryHighMiB: 1024,
        memoryMaxMiB: 768,
      }),
    /memoryHighMiB must be less than or equal to memoryMaxMiB/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        cpuWeight: 0,
      }),
    /cpuWeight must be a positive integer/,
  );

  assert.throws(
    () =>
      renderSystemdService({
        ...baseOptions,
        cpuWeight: 10_001,
      }),
    /cpuWeight must be less than or equal to 10000/,
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

test("diagnoseConfig warns when IP rate-limit proxy header posture is unsafe", () => {
  const publicBindConfig = mergeConfig(createDefaultConfig("vps"), {
    server: {
      host: "0.0.0.0",
    },
    rateLimit: {
      enabled: true,
      keyStrategy: "ip+api-key",
      trustProxyHeaders: true,
    },
  });
  const publicBindDiagnostic = diagnoseConfig(publicBindConfig, process.env).find(
    (entry) => entry.code === "rate_limit_proxy_headers_public_bind",
  );
  assert.ok(publicBindDiagnostic);
  assert.equal(publicBindDiagnostic.level, "warn");
  assert.match(publicBindDiagnostic.message, /X-Forwarded-For/);

  const loopbackProxyConfig = mergeConfig(createDefaultConfig("vps"), {
    server: {
      host: "127.0.0.1",
    },
    rateLimit: {
      enabled: true,
      keyStrategy: "ip",
      trustProxyHeaders: false,
    },
  });
  const loopbackProxyDiagnostic = diagnoseConfig(loopbackProxyConfig, process.env).find(
    (entry) => entry.code === "rate_limit_proxy_headers_disabled",
  );
  assert.ok(loopbackProxyDiagnostic);
  assert.equal(loopbackProxyDiagnostic.level, "warn");
  assert.match(loopbackProxyDiagnostic.message, /Caddy/);

  const apiKeyOnlyConfig = mergeConfig(createDefaultConfig("vps"), {
    rateLimit: {
      enabled: true,
      keyStrategy: "api-key",
      trustProxyHeaders: false,
    },
  });
  assert.ok(
    !diagnoseConfig(apiKeyOnlyConfig, process.env).some((entry) =>
      entry.code.startsWith("rate_limit_proxy_headers_"),
    ),
  );
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

test("diagnoseConfig can defer auth key checks to rendered systemd env files", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    auth: {
      enabled: true,
      apiKeyEnv: "RAY_API_KEYS",
    },
  });
  const diagnostics = diagnoseConfig(config, {}, "/etc/ray/ray.env", {
    allowMissingAuthKeys: true,
  });
  const diagnosticCodes = diagnostics.map((diagnostic) => diagnostic.code);

  assert.ok(diagnosticCodes.includes("auth_keys_unverified"));
  assert.ok(!diagnosticCodes.includes("auth_keys_missing"));
  assert.ok(!diagnosticCodes.includes("env_file_missing"));
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

test("renderEnvironmentFileExample documents gateway behavior switches", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    auth: {
      enabled: true,
    },
    asyncQueue: {
      enabled: true,
    },
  });
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_PROFILE=1b/);
  assert.match(envFile, /RAY_HOST=127\.0\.0\.1/);
  assert.match(envFile, /RAY_PORT=3000/);
  assert.match(envFile, /RAY_MODEL_WARM_ON_BOOT=true/);
  assert.match(envFile, /RAY_MODEL_BASE_URL=http:\/\/127\.0\.0\.1:8081/);
  assert.match(envFile, /RAY_MODEL_REF=qwen2\.5-1\.5b-instruct-q4_k_m/);
  assert.match(envFile, /RAY_MODEL_CONTEXT_WINDOW=8192/);
  assert.match(envFile, /RAY_MODEL_MAX_OUTPUT_TOKENS=192/);
  assert.match(envFile, /RAY_MODEL_TOKENS_PER_SECOND_TARGET=10/);
  assert.match(envFile, /RAY_MODEL_MEMORY_CLASS_MIB=4096/);
  assert.match(envFile, /RAY_MODEL_PREFERRED_CTX_SIZE=2048/);
  assert.match(envFile, /RAY_LOG_LEVEL=info/);
  assert.match(envFile, /RAY_TELEMETRY_SERVICE_NAME=ray-gateway/);
  assert.match(envFile, /RAY_TELEMETRY_INCLUDE_DEBUG_METRICS=true/);
  assert.match(envFile, /RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS=2200/);
  assert.doesNotMatch(envFile, /RAY_MODEL_API_KEY_ENV=/);
  assert.match(envFile, /RAY_REQUEST_BODY_LIMIT_BYTES=48000/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_ENABLED=true/);
  assert.match(envFile, /RAY_CACHE_ENABLED=true/);
  assert.match(envFile, /RAY_CACHE_MAX_ENTRIES=256/);
  assert.match(envFile, /RAY_CACHE_MAX_BYTES=2097152/);
  assert.match(envFile, /RAY_CACHE_TTL_MS=120000/);
  assert.match(envFile, /RAY_CACHE_KEY_STRATEGY=input\+params/);
  assert.match(envFile, /RAY_GRACEFUL_DEGRADATION_ENABLED=true/);
  assert.match(envFile, /RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD=10/);
  assert.match(envFile, /RAY_DEGRADATION_MAX_PROMPT_CHARS=5000/);
  assert.match(envFile, /RAY_DEGRADATION_MAX_TOKENS=128/);
  assert.match(envFile, /RAY_PROMPT_COMPILER_ENABLED=true/);
  assert.match(envFile, /RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=true/);
  assert.match(envFile, /RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=true/);
  assert.match(
    envFile,
    /RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=promptFamily,taskTemplate,template,useCase/,
  );
  assert.match(envFile, /RAY_ADAPTIVE_TUNING_ENABLED=true/);
  assert.match(envFile, /RAY_ADAPTIVE_SAMPLE_SIZE=32/);
  assert.match(envFile, /RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS=600/);
  assert.match(envFile, /RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND=8/);
  assert.match(envFile, /RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO=0\.5/);
  assert.match(envFile, /RAY_ADAPTIVE_MIN_OUTPUT_TOKENS=64/);
  assert.match(envFile, /RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED=true/);
  assert.match(envFile, /RAY_ADAPTIVE_FAMILY_HISTORY_SIZE=64/);
  assert.match(envFile, /RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES=8/);
  assert.match(envFile, /RAY_ADAPTIVE_DRAFT_PERCENTILE=0\.95/);
  assert.match(envFile, /RAY_ADAPTIVE_SHORT_PERCENTILE=0\.9/);
  assert.match(envFile, /RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS=24/);
  assert.match(envFile, /RAY_AUTH_ENABLED=true/);
  assert.match(envFile, /RAY_AUTH_API_KEY_ENV=RAY_API_KEYS/);
  assert.match(envFile, /RAY_RATE_LIMIT_ENABLED=true/);
  assert.match(envFile, /RAY_RATE_LIMIT_WINDOW_MS=60000/);
  assert.match(envFile, /RAY_RATE_LIMIT_MAX_REQUESTS=75/);
  assert.match(envFile, /RAY_RATE_LIMIT_MAX_KEYS=4096/);
  assert.match(envFile, /RAY_RATE_LIMIT_KEY_STRATEGY=ip\+api-key/);
  assert.match(envFile, /RAY_RATE_LIMIT_TRUST_PROXY_HEADERS=true/);
  assert.match(envFile, /RAY_SCHEDULER_MAX_QUEUE=40/);
  assert.match(envFile, /RAY_SCHEDULER_MAX_QUEUED_TOKENS=18000/);
  assert.match(envFile, /RAY_SCHEDULER_REQUEST_TIMEOUT_MS=32000/);
  assert.match(envFile, /RAY_SCHEDULER_DEDUPE_INFLIGHT=true/);
  assert.match(envFile, /RAY_SCHEDULER_BATCH_WINDOW_MS=5/);
  assert.match(envFile, /RAY_SCHEDULER_AFFINITY_LOOKAHEAD=12/);
  assert.match(envFile, /RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=96/);
});

test("renderEnvironmentFileExample documents configured upstream API key env", () => {
  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        kind: "openai-compatible",
        apiKeyEnv: "RAY_UPSTREAM_API_KEY",
      },
    },
  });
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_UPSTREAM_API_KEY=replace-with-upstream-api-key/);
  assert.match(envFile, /RAY_MODEL_API_KEY_ENV=RAY_UPSTREAM_API_KEY/);
  assert.match(envFile, /RAY_MODEL_BASE_URL=http:\/\/127\.0\.0\.1:8081/);
  assert.match(envFile, /RAY_MODEL_REF=qwen2\.5-3b-instruct-q4_k_m/);
});

test("renderEnvironmentFileExample documents deploy-time overrides", () => {
  const config = createDefaultConfig("1b");
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_DEPLOY_SERVICE_USER=ray/);
  assert.match(envFile, /RAY_DEPLOY_DOMAIN=ray\.local/);
  assert.match(envFile, /RAY_DEPLOY_MEMORY_MIB=4096/);
  assert.match(envFile, /RAY_GATEWAY_RUNTIME_BINARY=\/usr\/local\/bin\/bun/);
  assert.match(envFile, /RAY_DEPLOY_CADDY_BINARY=\/usr\/bin\/caddy/);
});

test("renderEnvironmentFileExample documents portable llama.cpp model overrides", () => {
  const config = createDefaultConfig("1b");
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_MODEL_ID=/);
  assert.match(envFile, /RAY_MODEL_REF=/);
  assert.match(envFile, /RAY_MODEL_PATH=/);
  assert.match(envFile, /RAY_MODEL_FAMILY=/);
  assert.match(envFile, /RAY_MODEL_QUANTIZATION=/);
  assert.match(envFile, /RAY_LLAMA_CPP_BASE_URL=/);
  assert.match(envFile, /RAY_LLAMA_CPP_MODEL_REF=/);
  assert.match(envFile, /RAY_LLAMA_CPP_MODEL_PATH=/);
  assert.match(envFile, /RAY_LLAMA_CPP_BINARY_PATH=/);
  assert.match(envFile, /RAY_LLAMA_CPP_BINARY_SOURCE_PATH=\/tmp\/ray-artifacts\/llama-server/);
  assert.match(envFile, /RAY_LLAMA_CPP_BINARY_SHA256=replace-with-64-character-sha256/);
  assert.match(
    envFile,
    /RAY_MODEL_SOURCE_PATH=\/tmp\/ray-artifacts\/qwen2\.5-1\.5b-instruct-q4_k_m\.gguf/,
  );
  assert.match(envFile, /RAY_MODEL_SHA256=replace-with-64-character-sha256/);
  assert.match(envFile, /RAY_LLAMA_CPP_ALIAS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_HOST=/);
  assert.match(envFile, /RAY_LLAMA_CPP_PORT=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CTX_SIZE=/);
  assert.match(envFile, /RAY_LLAMA_CPP_PARALLEL=/);
  assert.match(envFile, /RAY_LLAMA_CPP_THREADS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_THREADS_BATCH=2/);
  assert.match(envFile, /RAY_LLAMA_CPP_THREADS_HTTP=/);
  assert.match(envFile, /RAY_LLAMA_CPP_BATCH_SIZE=/);
  assert.match(envFile, /RAY_LLAMA_CPP_UBATCH_SIZE=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CACHE_REUSE=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CACHE_PROMPT=/);
  assert.match(envFile, /RAY_LLAMA_CPP_SLOT_STATE_TTL_MS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CONTINUOUS_BATCHING=/);
  assert.match(envFile, /RAY_LLAMA_CPP_ENABLE_METRICS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_EXPOSE_SLOTS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_WARMUP=/);
  assert.match(envFile, /RAY_LLAMA_CPP_ENABLE_UNIFIED_KV=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CACHE_IDLE_SLOTS=/);
  assert.match(envFile, /RAY_LLAMA_CPP_CONTEXT_SHIFT=/);
  assert.match(envFile, /RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=/);
  assert.match(envFile, /RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=/);
  assert.match(envFile, /RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=/);
});

test("renderEnvironmentFileExample documents async queue retention overrides", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      maxJobs: 500,
      minFreeStorageMiB: 192,
      completedTtlMs: 3_600_000,
      pollIntervalMs: 250,
      dispatchConcurrency: 2,
      maxAttempts: 4,
      callbackTimeoutMs: 1_500,
      maxCallbackAttempts: 3,
      callbackAllowedHosts: ["callback.example", "*.trusted.example"],
    },
  });
  const envFile = renderEnvironmentFileExample(config);

  assert.match(envFile, /RAY_ASYNC_QUEUE_STORAGE_DIR=\/var\/lib\/ray\/async-queue/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_MAX_JOBS=500/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=192/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=3600000/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_POLL_INTERVAL_MS=250/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY=2/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_MAX_ATTEMPTS=4/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS=1500/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS=3/);
  assert.match(envFile, /RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=false/);
  assert.match(
    envFile,
    /RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback\.example,\*\.trusted\.example/,
  );
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
    runtimeBinary: "/usr/local/bin/bun",
  });

  assert.match(bundle.service, /Ray Gateway/);
  assert.match(
    bundle.service,
    new RegExp(`WorkingDirectory=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(bundle.service, /ExecStart=\/usr\/local\/bin\/bun/);
  assert.match(bundle.service, /StateDirectory=ray/);
  assert.match(bundle.service, /Wants=ray-llama-cpp\.service/);
  assert.match(bundle.service, /After=network\.target ray-llama-cpp\.service/);
  assert.match(bundle.service, /MemoryHigh=640M/);
  assert.match(bundle.service, /MemoryMax=896M/);
  assert.match(bundle.service, /MemorySwapMax=128M/);
  assert.match(bundle.service, /CPUWeight=200/);
  assert.equal(bundle.summary.preflight.memoryBudgetMiB, 4096);
  assert.equal(bundle.summary.preflight.memoryBudgetSource, "override");
  assert.equal(typeof bundle.summary.preflight.hostCpuCount, "number");
  assert.ok((bundle.summary.preflight.hostCpuCount ?? 0) >= 1);
  assert.deepEqual(bundle.summary.systemd.gateway, {
    memoryHighMiB: 640,
    memoryMaxMiB: 896,
    memorySwapMaxMiB: 128,
    cpuWeight: 200,
  });
  assert.deepEqual(bundle.summary.systemd.llamaCpp, {
    memoryHighMiB: 2775,
    memoryMaxMiB: 3084,
    memorySwapMaxMiB: 771,
    cpuWeight: 80,
  });
  assert.match(bundle.caddyfile, /response_header_timeout 37s/);
  assert.match(bundle.caddyfile, /read_timeout 37s/);
  assert.match(bundle.llamaCppService ?? "", /llama\.cpp Server for Ray/);
  assert.doesNotMatch(bundle.llamaCppService ?? "", /EnvironmentFile=\/etc\/ray\/ray.env/);
  assert.match(bundle.llamaCppService ?? "", /MemoryHigh=2775M/);
  assert.match(bundle.llamaCppService ?? "", /MemoryMax=3084M/);
  assert.match(bundle.llamaCppService ?? "", /MemorySwapMax=771M/);
  assert.match(bundle.llamaCppService ?? "", /CPUWeight=80/);
  assert.match(
    bundle.llamaCppService ?? "",
    /LLAMA_ARG_MODEL=\/var\/lib\/ray\/models\/local-1b-q4\.gguf/,
  );
});

test("renderDeploymentBundle accepts every public example deployment profile", async () => {
  const configDir = join(process.cwd(), "examples/config");
  const publicConfigFiles = (await readdir(configDir))
    .filter((entry) => entry.endsWith(".public.json"))
    .sort();

  assert.ok(publicConfigFiles.length > 0);

  for (const configFile of publicConfigFiles) {
    const bundle = await renderDeploymentBundle({
      cwd: process.cwd(),
      configPath: `./examples/config/${configFile}`,
      user: "ray",
      domain: "ray.example.com",
      envFile: "/etc/ray/ray.env",
      env: {
        RAY_API_KEYS: "test-key",
      },
      memoryBudgetMiB: configFile.includes("8gb") ? 8192 : 4096,
      runtimeBinary: "/usr/local/bin/bun",
    });

    const errorCodes = bundle.summary.diagnostics
      .filter((diagnostic) => diagnostic.level === "error")
      .map((diagnostic) => diagnostic.code);

    assert.deepEqual(errorCodes, [], `${configFile} should render without errors`);
    assert.match(bundle.service, /Description=Ray Gateway/);
    assert.match(bundle.caddyfile, /^ray\.example\.com \{/m);
  }
});

test("renderDeploymentBundle redacts adapter headers from summary output", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-summary-redaction-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.json");
  const config = mergeConfig(createDefaultConfig("vps"), {
    model: {
      adapter: {
        headers: {
          authorization: "Bearer upstream-secret",
          "x-provider-token": "shared-secret",
        },
      },
    },
  });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

  const bundle = await renderDeploymentBundle({
    cwd: tempDir,
    configPath,
    user: "ray",
    domain: "ray.example.com",
  });
  const { adapter } = bundle.summary.model;

  if (adapter.kind !== "openai-compatible" && adapter.kind !== "llama.cpp") {
    throw new Error("Expected HTTP adapter with headers");
  }

  assert.deepEqual(adapter.headers, {
    authorization: "[redacted]",
    "x-provider-token": "[redacted]",
  });
  assert.doesNotMatch(JSON.stringify(bundle.summary), /upstream-secret|shared-secret/);
});

test("renderDeploymentBundle warns when generated services run as root", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-root-service-user-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

  const bundle = await renderDeploymentBundle({
    cwd: tempDir,
    configPath,
    user: "root",
    domain: "ray.example.com",
  });

  const diagnostic = bundle.summary.diagnostics.find((entry) => entry.code === "service_user_root");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /non-root service account/);
  assert.equal(bundle.summary.preflight.serviceUser, "root");
});

test("renderDeploymentBundle warns when the Caddy site address is still local", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-local-caddy-site-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");

  const bundle = await renderDeploymentBundle({
    cwd: tempDir,
    configPath,
    user: "ray",
    domain: "ray.local",
  });

  const diagnostic = bundle.summary.diagnostics.find(
    (entry) => entry.code === "caddy_site_address_local",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /RAY_DEPLOY_DOMAIN/);
  assert.equal(bundle.summary.preflight.caddySiteAddress, "ray.local");
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
          threadsBatch: 2,
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
    memoryHighMiB: 1024,
    memoryMaxMiB: 2048,
    memorySwapMaxMiB: 512,
    cpuWeight: 80,
  });
  assert.match(service, /LLAMA_ARG_CTX_SIZE=3072/);
  assert.match(service, /LLAMA_ARG_N_PARALLEL=2/);
  assert.match(service, /LLAMA_ARG_THREADS_BATCH=2/);
  assert.match(service, /LLAMA_ARG_CACHE_RAM=512/);
  assert.match(service, /LLAMA_ARG_WARMUP=1/);
  assert.match(service, /LLAMA_ARG_KV_UNIFIED=1/);
  assert.match(service, /LLAMA_ARG_CACHE_IDLE_SLOTS=1/);
  assert.match(service, /LLAMA_ARG_CONTEXT_SHIFT=1/);
  assert.match(service, /ExecStart=\/usr\/local\/bin\/llama-server/);
  assert.match(
    service,
    /ExecStart=\/usr\/local\/bin\/llama-server --model \/models\/qwen\.gguf --host 127\.0\.0\.1 --port 8081/,
  );
  assert.match(
    service,
    /--ctx-size 3072 --parallel 2 --threads 2 --threads-batch 2 --threads-http 2 --batch-size 256 --ubatch-size 128/,
  );
  assert.match(
    service,
    /--cache-prompt --cache-reuse 256 --cache-ram 512 --cont-batching --metrics --slots --warmup --kv-unified --cache-idle-slots --context-shift/,
  );
  assert.match(service, /StartLimitIntervalSec=60/);
  assert.match(service, /StartLimitBurst=10/);
  assert.match(service, /LogRateLimitIntervalSec=30s/);
  assert.match(service, /LogRateLimitBurst=200/);
  assert.match(service, /TimeoutStopSec=35/);
  assert.match(service, /KillSignal=SIGTERM/);
  assert.match(service, /KillMode=mixed/);
  assert.match(service, /OOMPolicy=stop/);
  assert.match(service, /OOMScoreAdjust=250/);
  assert.match(service, /TasksMax=256/);
  assert.match(service, /CPUAccounting=true/);
  assert.match(service, /MemoryAccounting=true/);
  assert.match(service, /IOAccounting=true/);
  assert.match(service, /MemoryHigh=1024M/);
  assert.match(service, /MemoryMax=2048M/);
  assert.match(service, /MemorySwapMax=512M/);
  assert.match(service, /CPUWeight=80/);
  assert.match(service, /CapabilityBoundingSet=\n/);
  assert.match(service, /SystemCallArchitectures=native/);
  assert.match(service, /PrivateDevices=true/);
  assert.match(service, /ProtectClock=true/);
  assert.match(service, /ProtectHostname=true/);
  assert.match(service, /ProtectKernelModules=true/);
  assert.match(service, /MemoryDenyWriteExecute=true/);
  assert.match(service, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(service, /RestrictNamespaces=true/);
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
          binaryPath: "/home/ray/bin/llama-server",
        },
      }),
    /model\.adapter\.launchProfile\.binaryPath is under \/home, \/root, or \/run\/user/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          binaryPath: "/var/tmp/llama-server",
        },
      }),
    /model\.adapter\.launchProfile\.binaryPath is under \/tmp or \/var\/tmp/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          modelPath: "/root/models/local-1b.gguf",
        },
      }),
    /model\.adapter\.launchProfile\.modelPath is under \/home, \/root, or \/run\/user/,
  );

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          modelPath: "/tmp/local-1b.gguf",
        },
      }),
    /model\.adapter\.launchProfile\.modelPath is under \/tmp or \/var\/tmp/,
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

  assert.throws(
    () =>
      renderLlamaCppService({
        user: "ray",
        launchProfile: {
          ...launchProfile,
          extraArgs: ["--port=8082"],
        },
      }),
    /model\.adapter\.launchProfile\.extraArgs\[0\] must not override --port/,
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
    /--context-shift --log-prefix "ray 100%%" "--jinja-template=\{\{ role == \\"user\\" \}\}"/,
  );
});

test("renderLlamaCppService emits disabled launch flags explicitly", () => {
  const service = renderLlamaCppService({
    user: "ray",
    launchProfile: {
      preset: "single-vps-1b-cx23",
      binaryPath: "/usr/local/bin/llama-server",
      modelPath: "/var/lib/ray/models/local-1b.gguf",
      host: "127.0.0.1",
      port: 8081,
      ctxSize: 2048,
      parallel: 1,
      threads: 2,
      threadsHttp: 2,
      batchSize: 192,
      ubatchSize: 96,
      cachePrompt: false,
      cacheReuse: 0,
      continuousBatching: false,
      enableMetrics: false,
      exposeSlots: false,
      warmup: false,
      enableUnifiedKv: false,
      cacheIdleSlots: false,
      contextShift: false,
    },
  });

  assert.match(
    service,
    /--no-cache-prompt --cache-reuse 0 --no-cont-batching --no-slots --no-warmup --no-kv-unified --no-cache-idle-slots --no-context-shift/,
  );
  assert.doesNotMatch(service, / --metrics/);
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
    threadsBatch: 2,
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
  assert.equal(environment.LLAMA_ARG_BATCH, "256");
  assert.equal(environment.LLAMA_ARG_BATCH_SIZE, "256");
  assert.equal(environment.LLAMA_ARG_UBATCH, "128");
  assert.equal(environment.LLAMA_ARG_UBATCH_SIZE, "128");
  assert.equal(environment.LLAMA_ARG_THREADS_BATCH, "2");
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

test("diagnoseConfig errors when a sub1b launch profile targets the wrong host architecture", () => {
  const config = createDefaultConfig("sub1b-cax11");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      hostArchitecture: "x64",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "llama_launch_profile_architecture_mismatch",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /single-vps-sub1b-cax11/);
  assert.match(diagnostic.message, /arm64/);
  assert.match(diagnostic.message, /x64/);
});

test("diagnoseConfig reports a matching sub1b launch profile host architecture", () => {
  const config = createDefaultConfig("sub1b-cax11");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      hostArchitecture: "arm64",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "llama_launch_profile_architecture_ok",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /single-vps-sub1b-cax11/);
  assert.match(diagnostic.message, /arm64/);
});

test("diagnoseConfig warns when llama.cpp compute threads exceed host CPUs", () => {
  const config = createDefaultConfig("sub1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.ok(config.model.adapter.launchProfile);

  config.model.adapter.launchProfile.threads = 4;

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      hostCpuCount: 2,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "llama_threads_exceed_host_cpu");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
});

test("diagnoseConfig accepts default sub1b thread count on a 2 vCPU host", () => {
  const config = createDefaultConfig("sub1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      hostCpuCount: 2,
    },
  });

  assert.equal(
    diagnostics.some((entry) => entry.code === "llama_threads_exceed_host_cpu"),
    false,
  );
});

test("diagnoseConfig warns when a small VPS llama.cpp profile has no swap cushion", () => {
  const config = createDefaultConfig("1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "preset",
      swapStatus: "missing",
      swapTotalMiB: 0,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "swap_missing");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /bun run swap:plan/);
});

test("diagnoseConfig points low small-VPS swap warnings at the swap helper", () => {
  const config = createDefaultConfig("1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "preset",
      swapStatus: "available",
      swapTotalMiB: 512,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "swap_low");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /bun run swap:plan -- --size-mib 1024/);
});

test("diagnoseConfig reports adequate swap for a small VPS llama.cpp profile", () => {
  const config = createDefaultConfig("1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "preset",
      swapStatus: "available",
      swapTotalMiB: 2_048,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "swap_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /2,048 MiB/);
});

test("diagnoseConfig warns when small-VPS swappiness is high", () => {
  const config = createDefaultConfig("1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "preset",
      swapStatus: "available",
      swapTotalMiB: 2_048,
      swappinessStatus: "available",
      swappiness: 60,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "swap_swappiness_high");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /--swappiness 10/);
});

test("diagnoseConfig reports conservative small-VPS swappiness", () => {
  const config = createDefaultConfig("1b");

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "preset",
      swapStatus: "available",
      swapTotalMiB: 2_048,
      swappinessStatus: "available",
      swappiness: 10,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "swap_swappiness_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /vm\.swappiness is 10/);
});

test("diagnoseConfig skips swap warnings for roomier llama.cpp profiles", () => {
  const config = createDefaultConfig("1b");
  assert.equal(config.model.adapter.kind, "llama.cpp");
  assert.ok(config.model.adapter.launchProfile);
  config.model.adapter.launchProfile.preset = "single-vps-1b-8gb";

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      memoryBudgetMiB: 8_192,
      memoryBudgetSource: "preset",
      swapStatus: "missing",
      swapTotalMiB: 0,
    },
  });

  assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "swap_missing"));
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

test("diagnoseConfig warns when async callbacks bypass network guardrails", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      callbackAllowPrivateNetwork: true,
      callbackAllowedHosts: ["callback.internal", "*.trusted.example"],
    },
  });

  const diagnostics = diagnoseConfig(config, process.env);
  const privateBypass = diagnostics.find(
    (diagnostic) => diagnostic.code === "async_callback_private_network_allowed",
  );
  const trustedHosts = diagnostics.find(
    (diagnostic) => diagnostic.code === "async_callback_hosts_allowlisted",
  );

  assert.ok(privateBypass);
  assert.equal(privateBypass.level, "warn");
  assert.match(privateBypass.message, /callbackAllowPrivateNetwork/);
  assert.match(privateBypass.message, /callbackAllowedHosts/);
  assert.ok(trustedHosts);
  assert.equal(trustedHosts.level, "warn");
  assert.match(trustedHosts.message, /2 host pattern/);
  assert.match(trustedHosts.message, /bypass DNS\/network address blocking/);
});

test("diagnoseConfig warns when non-strict async queue storage is below reserved headroom", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      minFreeStorageMiB: 256,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib/ray",
      asyncQueueStorageStatus: "parent",
      asyncQueueStorageAvailableMiB: 127,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "async_queue_storage_low");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /127 MiB free/);
  assert.match(diagnostic.message, /256 MiB/);
});

test("diagnoseConfig errors when strict async queue storage is below reserved headroom", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      minFreeStorageMiB: 256,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib/ray",
      asyncQueueStorageStatus: "parent",
      asyncQueueStorageAvailableMiB: 127,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "async_queue_storage_low");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /127 MiB free/);
  assert.match(diagnostic.message, /256 MiB/);
});

test("diagnoseConfig skips non-strict async queue reserve results when free space is unresolved", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      minFreeStorageMiB: 256,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib",
      asyncQueueStorageStatus: "parent",
    },
  });

  assert.ok(!diagnostics.some((entry) => entry.code === "async_queue_storage_low"));
  assert.ok(!diagnostics.some((entry) => entry.code === "async_queue_storage_ok"));
  assert.ok(!diagnostics.some((entry) => entry.code === "async_queue_storage_unreadable"));
});

test("diagnoseConfig warns when non-strict async queue storage is blocked by a file", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib/ray",
      asyncQueueStorageStatus: "not_directory",
      asyncQueueStorageError: "not a directory",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "async_queue_storage_not_directory",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
});

test("diagnoseConfig errors when strict async queue storage is blocked by a file", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib/ray",
      asyncQueueStorageStatus: "not_directory",
      asyncQueueStorageError: "not a directory",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "async_queue_storage_not_directory",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
});

test("diagnoseConfig errors when the generated service user cannot write async queue storage", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "ray",
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib/ray",
      asyncQueueStorageStatus: "parent",
      asyncQueueStorageAvailableMiB: 8_192,
      asyncQueueStorageAccessStatus: "blocked",
      asyncQueueStorageAccessError: "write/execute permission is not granted on /var/lib/ray",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "async_queue_storage_service_user_inaccessible",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /ray/);
  assert.match(diagnostic.message, /write\/execute permission/);
});

test("diagnoseConfig treats the default async queue root as systemd-managed", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/var/lib/ray/async-queue",
      minFreeStorageMiB: 256,
    },
  });

  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "ray",
      asyncQueueStoragePath: "/var/lib/ray/async-queue",
      asyncQueueStorageCheckPath: "/var/lib",
      asyncQueueStorageStatus: "parent",
      asyncQueueStorageAvailableMiB: 8_192,
      asyncQueueStorageAccessStatus: "blocked",
      asyncQueueStorageAccessError: "write/execute permission is not granted on /var/lib",
      asyncQueueStorageManagedByStateDirectory: true,
    },
  });

  assert.ok(
    !diagnostics.some((entry) => entry.code === "async_queue_storage_service_user_inaccessible"),
  );
  const diagnostic = diagnostics.find((entry) => entry.code === "async_queue_storage_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /StateDirectory=ray/);
  assert.match(diagnostic.message, /\/var\/lib\/ray/);
});

test("diagnoseConfig errors when async queue storage is read-only under ProtectSystem", () => {
  const config = mergeConfig(createDefaultConfig("1b"), {
    asyncQueue: {
      enabled: true,
      storageDir: "/etc/ray/async-queue",
    },
  });

  const diagnostics = diagnoseConfig(config, process.env);
  const diagnostic = diagnostics.find(
    (entry) => entry.code === "async_queue_storage_protect_system_readonly",
  );

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /ProtectSystem=full/);
  assert.match(diagnostic.message, /\/var\/lib\/ray\/async-queue/);
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

  const strictDiagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      workingDirectoryPath: "/home/ray/current",
      workingDirectoryStatus: "found",
    },
  });
  assert.ok(
    strictDiagnostics.some((diagnostic) => diagnostic.code === "working_directory_home_protected"),
  );
});

test("diagnoseConfig errors when generated llama.cpp paths use temporary storage", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.model.adapter.launchProfile.binaryPath = "/tmp/llama-server";
  config.model.adapter.launchProfile.modelPath = "/var/tmp/local-1b.gguf";

  const diagnostics = diagnoseConfig(config, process.env);

  const binaryDiagnostic = diagnostics.find(
    (diagnostic) => diagnostic.code === "llama_binary_path_private_tmp",
  );
  assert.ok(binaryDiagnostic);
  assert.equal(binaryDiagnostic.level, "error");
  assert.match(binaryDiagnostic.message, /PrivateTmp=true/);
  assert.match(binaryDiagnostic.message, /\/usr\/local\/bin\/llama-server/);

  const modelDiagnostic = diagnostics.find(
    (diagnostic) => diagnostic.code === "llama_model_path_private_tmp",
  );
  assert.ok(modelDiagnostic);
  assert.equal(modelDiagnostic.level, "error");
  assert.match(modelDiagnostic.message, /PrivateTmp=true/);
  assert.match(modelDiagnostic.message, /\/var\/lib\/ray\/models/);
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

test("diagnoseConfig errors when generated gateway and llama.cpp ports conflict", () => {
  const config = createDefaultConfig("1b");

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.server.port = config.model.adapter.launchProfile.port;

  const diagnostics = diagnoseConfig(config, process.env);
  const diagnostic = diagnostics.find((entry) => entry.code === "gateway_llama_port_conflict");

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /ray-gateway\.service/);
  assert.match(diagnostic.message, /ray-llama-cpp\.service/);
  assert.match(diagnostic.message, /distinct local sockets/);
});

test("diagnoseConfig errors when adapter baseUrl points at the gateway socket", () => {
  const config = createDefaultConfig("vps");

  if (config.model.adapter.kind !== "openai-compatible") {
    throw new Error("Expected OpenAI-compatible adapter");
  }

  config.model.adapter.baseUrl = `http://localhost:${config.server.port}`;

  const diagnostics = diagnoseConfig(config, process.env);
  const diagnostic = diagnostics.find((entry) => entry.code === "adapter_base_url_gateway_loop");

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /Ray gateway listen socket/);
  assert.match(diagnostic.message, /model backend/);
  assert.match(diagnostic.message, /recursively call the gateway/);
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

test("diagnoseConfig warns when the generated Caddy site address is local", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    preflight: {
      caddySiteAddress: "localhost:8443",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "caddy_site_address_local");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /real public DNS name/);
});

test("loadAndDiagnoseDeployment warns when EnvironmentFile permissions are open in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-env-file-mode-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const envFile = join(tempDir, "ray.env");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(envFile, "RAY_API_KEYS=secret\n");
  await chmod(envFile, 0o644);

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    envFile,
    strictFilesystem: true,
    env: { RAY_API_KEYS: "secret" },
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "env_file_permissions_open",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /0644/);
});

test("diagnoseConfig errors when the generated service user is missing in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "ray-missing",
      serviceUserStatus: "missing",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "service_user_missing");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
});

test("diagnoseConfig warns when the generated service user resolves to root", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "0",
      serviceUserStatus: "found",
      serviceUserUid: 0,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "service_user_root");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /root/);
  assert.match(diagnostic.message, /systemd hardening/);
});

test("diagnoseConfig errors when the target host cannot run systemd units", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      systemdStatus: "missing",
      systemdError: "/run/systemd/system was not found",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "systemd_host_missing");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /systemd/);
  assert.match(diagnostic.message, /ray-gateway\.service/);
});

test("diagnoseConfig reports an available systemd host in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      systemdStatus: "available",
      systemdVersion: "systemd 255",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "systemd_host_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /systemd 255/);
});

test("diagnoseConfig errors when generated systemd units fail verification", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      systemdUnitStatus: "invalid",
      systemdUnitError: "Unknown key MemorySwapMax",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "systemd_units_invalid");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /systemd-analyze/);
  assert.match(diagnostic.message, /MemorySwapMax/);
});

test("diagnoseConfig reports verified generated systemd units in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      systemdUnitStatus: "valid",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "systemd_units_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /systemd-analyze/);
});

test("diagnoseConfig errors when Caddy is missing in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      caddyStatus: "missing",
      caddyError: "caddy was not found",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "caddy_runtime_missing");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /Caddyfile/);
  assert.match(diagnostic.message, /public HTTPS/);
});

test("diagnoseConfig reports an available Caddy runtime in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      caddyStatus: "available",
      caddyVersion: "v2.8.4",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "caddy_runtime_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /v2\.8\.4/);
});

test("diagnoseConfig errors when the generated Caddyfile is invalid in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      caddyConfigStatus: "invalid",
      caddyConfigError: "bad directive",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "caddy_config_invalid");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /generated Caddyfile/);
  assert.match(diagnostic.message, /bad directive/);
});

test("diagnoseConfig reports a valid generated Caddyfile in strict mode", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      caddyConfigStatus: "valid",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "caddy_config_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /validates/);
});

test("loadAndDiagnoseDeployment validates the generated Caddyfile in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-caddyfile-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const binDir = join(tempDir, "bin");
  const caddyArgsPath = join(tempDir, "caddy-args.txt");
  await mkdir(binDir);
  const caddyPath = join(binDir, "caddy");
  await writeFile(
    caddyPath,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "v2.8.4"
  exit 0
fi
if [ "$1" = "validate" ]; then
  printf '%s\\n' "$@" > "${caddyArgsPath}"
  test "$2" = "--config" || exit 2
  grep -q 'example.com {' "$3" || exit 3
  grep -q 'reverse_proxy 127.0.0.1:${config.server.port}' "$3" || exit 4
  exit 0
fi
exit 5
`,
  );
  await chmod(caddyPath, 0o755);

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    domain: "example.com",
    caddyBinary: caddyPath,
    strictFilesystem: true,
  });

  assert.equal(inspected.preflight.caddyStatus, "available");
  assert.equal(inspected.preflight.caddyBinaryPath, caddyPath);
  assert.equal(inspected.preflight.caddyConfigStatus, "valid");
  assert.match(await readFile(caddyArgsPath, "utf8"), /^validate\n--config\n/m);
  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "caddy_config_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
});

test("diagnoseConfig errors when the generated service user cannot access gateway paths", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "cli_ray",
      serviceUserPrimaryGroup: "rayops",
      configFilePath: "/etc/ray/ray.json",
      configFileStatus: "found",
      configFileAccessStatus: "blocked",
      configFileAccessError: "read permission is not granted on ray.json",
      gatewayRuntimeBinaryPath: "/usr/local/bin/bun",
      gatewayRuntimeBinaryStatus: "found",
      gatewayRuntimeBinaryAccessStatus: "blocked",
      gatewayRuntimeBinaryAccessError: "execute permission is not granted on bun",
      workingDirectoryPath: "/srv/ray",
      workingDirectoryStatus: "found",
      workingDirectoryAccessStatus: "blocked",
      workingDirectoryAccessError: "execute permission is not granted on /srv",
      gatewayEntrypointPath: "/srv/ray/apps/gateway/dist/index.js",
      gatewayEntrypointStatus: "found",
      gatewayEntrypointAccessStatus: "blocked",
      gatewayEntrypointAccessError: "read permission is not granted on index.js",
      gatewayEntrypointImportStatus: "failed",
      gatewayEntrypointImportError: "Cannot find package '@ray/config'",
    },
  });

  const configDiagnostic = diagnostics.find(
    (entry) => entry.code === "config_file_service_user_inaccessible",
  );
  assert.ok(configDiagnostic);
  assert.equal(configDiagnostic.level, "error");
  assert.match(configDiagnostic.message, /cli_ray/);
  assert.match(configDiagnostic.message, /read permission/);
  assert.match(configDiagnostic.message, /root:rayops ownership/);
  assert.doesNotMatch(configDiagnostic.message, /root:ray ownership/);

  const runtimeDiagnostic = diagnostics.find(
    (entry) => entry.code === "gateway_runtime_service_user_inaccessible",
  );
  assert.ok(runtimeDiagnostic);
  assert.equal(runtimeDiagnostic.level, "error");
  assert.match(runtimeDiagnostic.message, /ray/);
  assert.match(runtimeDiagnostic.message, /execute permission/);

  const workingDirectoryDiagnostic = diagnostics.find(
    (entry) => entry.code === "working_directory_service_user_inaccessible",
  );
  assert.ok(workingDirectoryDiagnostic);
  assert.equal(workingDirectoryDiagnostic.level, "error");
  assert.match(workingDirectoryDiagnostic.message, /ray/);
  assert.match(workingDirectoryDiagnostic.message, /execute permission/);

  const entrypointDiagnostic = diagnostics.find(
    (entry) => entry.code === "gateway_entrypoint_service_user_inaccessible",
  );
  assert.ok(entrypointDiagnostic);
  assert.equal(entrypointDiagnostic.level, "error");
  assert.match(entrypointDiagnostic.message, /ray/);
  assert.match(entrypointDiagnostic.message, /read permission/);

  const importDiagnostic = diagnostics.find(
    (entry) => entry.code === "gateway_entrypoint_import_failed",
  );
  assert.ok(importDiagnostic);
  assert.equal(importDiagnostic.level, "error");
  assert.match(importDiagnostic.message, /bun install --frozen-lockfile/);
  assert.match(importDiagnostic.message, /bun run build/);
  assert.match(importDiagnostic.message, /bun install --production --frozen-lockfile/);
  assert.match(importDiagnostic.message, /Cannot find package '@ray\/config'/);
});

test("diagnoseConfig errors when strict working directory storage is below the deploy cushion", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      workingDirectoryPath: "/srv/ray",
      workingDirectoryStatus: "found",
      workingDirectoryAvailableMiB: 511,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "working_directory_storage_low");

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /511 MiB/);
  assert.match(diagnostic.message, /512 MiB/);
  assert.match(diagnostic.message, /Bun production install/);
});

test("diagnoseConfig reports adequate working directory storage for strict deploys", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      workingDirectoryPath: "/srv/ray",
      workingDirectoryStatus: "found",
      workingDirectoryAvailableMiB: 512,
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "working_directory_storage_ok");

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /512 MiB/);
  assert.match(diagnostic.message, /deployment cushion/);
});

test("diagnoseConfig errors when strict working directory storage cannot be inspected", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      workingDirectoryPath: "/srv/ray",
      workingDirectoryStatus: "found",
      workingDirectoryStorageStatus: "unreadable",
      workingDirectoryStorageError: "statfs failed",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "working_directory_storage_unreadable",
  );

  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /statfs failed/);
  assert.match(diagnostic.message, /free space/);
});

test("diagnoseConfig errors when the generated gateway config is hidden by ProtectHome", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      configFilePath: "/root/ray.json",
      configFileStatus: "found",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "config_file_home_protected");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /ProtectHome=true/);
  assert.match(diagnostic.message, /\/etc\/ray\/ray\.json/);
});

test("diagnoseConfig errors when generated gateway paths use temporary storage", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      workingDirectoryPath: "/tmp/ray",
      workingDirectoryStatus: "found",
      configFilePath: "/var/tmp/ray.json",
      configFileStatus: "found",
      gatewayRuntimeBinaryPath: "/tmp/bun",
      gatewayRuntimeBinaryStatus: "found",
    },
  });

  const workingDirectoryDiagnostic = diagnostics.find(
    (entry) => entry.code === "working_directory_private_tmp",
  );
  assert.ok(workingDirectoryDiagnostic);
  assert.equal(workingDirectoryDiagnostic.level, "error");
  assert.match(workingDirectoryDiagnostic.message, /PrivateTmp=true/);
  assert.match(workingDirectoryDiagnostic.message, /\/srv\/ray/);

  const configDiagnostic = diagnostics.find((entry) => entry.code === "config_file_private_tmp");
  assert.ok(configDiagnostic);
  assert.equal(configDiagnostic.level, "error");
  assert.match(configDiagnostic.message, /PrivateTmp=true/);
  assert.match(configDiagnostic.message, /\/etc\/ray\/ray\.json/);

  const runtimeDiagnostic = diagnostics.find(
    (entry) => entry.code === "gateway_runtime_private_tmp",
  );
  assert.ok(runtimeDiagnostic);
  assert.equal(runtimeDiagnostic.level, "error");
  assert.match(runtimeDiagnostic.message, /PrivateTmp=true/);
  assert.match(runtimeDiagnostic.message, /\/usr\/local\/bin\/bun/);
});

test("diagnoseConfig errors when the configured gateway runtime is hidden by ProtectHome", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      gatewayRuntimeBinaryPath: "/home/ray/.bun/bin/bun",
      gatewayRuntimeBinaryStatus: "found",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "gateway_runtime_home_protected");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /ProtectHome=true/);
  assert.match(diagnostic.message, /\/usr\/local\/bin\/bun/);
});

test("diagnoseConfig errors when the configured Bun runtime is too old", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      gatewayRuntimeBinaryPath: "/usr/local/bin/bun",
      gatewayRuntimeBinaryStatus: "found",
      gatewayRuntimeKind: "bun",
      gatewayRuntimeVersion: "1.2.9",
      gatewayRuntimeVersionStatus: "too_old",
    },
  });

  const diagnostic = diagnostics.find(
    (entry) => entry.code === "gateway_runtime_version_unsupported",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /Bun/);
  assert.match(diagnostic.message, /1\.2\.9/);
  assert.match(diagnostic.message, />= 1\.3\.0/);
});

test("diagnoseConfig reports a compatible configured Bun runtime", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      gatewayRuntimeBinaryPath: "/usr/local/bin/bun",
      gatewayRuntimeBinaryStatus: "found",
      gatewayRuntimeKind: "bun",
      gatewayRuntimeVersion: "1.3.9",
      gatewayRuntimeVersionStatus: "ok",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "gateway_runtime_version_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /Bun version 1\.3\.9/);
});

test("diagnoseConfig warns when the configured gateway runtime is Node", () => {
  const config = createDefaultConfig("tiny");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      gatewayRuntimeBinaryPath: "/usr/local/bin/node",
      gatewayRuntimeBinaryStatus: "found",
      gatewayRuntimeKind: "node",
      gatewayRuntimeVersion: "22.12.0",
      gatewayRuntimeVersionStatus: "ok",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "gateway_runtime_node_fallback");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, /Node\.js/);
  assert.match(diagnostic.message, /preferred small-VPS runtime/);
  assert.match(diagnostic.message, /\/usr\/local\/bin\/bun/);
});

test("diagnoseConfig errors when the configured GGUF model header is invalid", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      modelFilePath: "/var/lib/ray/models/local-1b.gguf",
      modelFileStatus: "found",
      modelFileFormatStatus: "invalid",
      modelFileFormatError: "expected GGUF magic header",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "model_file_format_invalid");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /GGUF header/);
  assert.match(diagnostic.message, /model:stage/);
});

test("diagnoseConfig reports a valid configured GGUF model header", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      modelFilePath: "/var/lib/ray/models/local-1b.gguf",
      modelFileStatus: "found",
      modelFileFormatStatus: "valid",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "model_file_format_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /valid GGUF header/);
});

test("diagnoseConfig errors when the generated service user cannot access llama.cpp paths", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      serviceUser: "ray",
      llamaCppBinaryPath: "/usr/local/bin/llama-server",
      llamaCppBinaryStatus: "found",
      llamaCppBinaryAccessStatus: "blocked",
      llamaCppBinaryAccessError: "execute permission is not granted on llama-server",
      modelFilePath: "/var/lib/ray/models/local-1b.gguf",
      modelFileStatus: "found",
      modelFileBytes: 512 * 1_024 * 1_024,
      modelFileAccessStatus: "blocked",
      modelFileAccessError: "read permission is not granted on local-1b.gguf",
      memoryBudgetMiB: 4_096,
      memoryBudgetSource: "override",
    },
  });

  const binaryDiagnostic = diagnostics.find(
    (entry) => entry.code === "llama_binary_service_user_inaccessible",
  );
  assert.ok(binaryDiagnostic);
  assert.equal(binaryDiagnostic.level, "error");
  assert.match(binaryDiagnostic.message, /ray/);
  assert.match(binaryDiagnostic.message, /execute permission/);

  const modelDiagnostic = diagnostics.find(
    (entry) => entry.code === "model_file_service_user_inaccessible",
  );
  assert.ok(modelDiagnostic);
  assert.equal(modelDiagnostic.level, "error");
  assert.match(modelDiagnostic.message, /ray/);
  assert.match(modelDiagnostic.message, /read permission/);
});

test("diagnoseConfig errors when the configured llama.cpp binary cannot start", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      llamaCppBinaryPath: "/usr/local/bin/llama-server",
      llamaCppBinaryStatus: "found",
      llamaCppBinaryProbeStatus: "failed",
      llamaCppBinaryProbeError: "missing shared library: libgomp.so.1",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "llama_binary_probe_failed");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /missing shared library/);
  assert.match(diagnostic.message, /compatible llama-server/);
});

test("diagnoseConfig reports when the configured llama.cpp binary starts", () => {
  const config = createDefaultConfig("1b");
  const diagnostics = diagnoseConfig(config, process.env, undefined, {
    strictFilesystem: true,
    preflight: {
      llamaCppBinaryPath: "/usr/local/bin/llama-server",
      llamaCppBinaryStatus: "found",
      llamaCppBinaryProbeStatus: "ok",
    },
  });

  const diagnostic = diagnostics.find((entry) => entry.code === "llama_binary_probe_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /--help/);
});

test("loadAndDiagnoseDeployment reports an existing generated service user in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-service-user-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    user: "root",
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "service_user_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
});

test("loadAndDiagnoseDeployment reports oversized host passwd as unreadable in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-service-user-passwd-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const passwdPath = join(tempDir, "passwd");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(passwdPath, "x".repeat(256 * 1024 + 1));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    user: "ray",
    strictFilesystem: true,
    hostFiles: {
      passwd: passwdPath,
    },
  });

  assert.equal(inspected.preflight.serviceUserStatus, "unreadable");
  assert.match(inspected.preflight.serviceUserError ?? "", /host passwd file must be at most/);
  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "service_user_unreadable",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
});

test("loadAndDiagnoseDeployment bounds host swap preflight files", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-host-swap-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const meminfoPath = join(tempDir, "meminfo");
  const swappinessPath = join(tempDir, "swappiness");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(meminfoPath, "x".repeat(64 * 1024 + 1));
  await writeFile(swappinessPath, "10\n");

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    hostFiles: {
      meminfo: meminfoPath,
      swappiness: swappinessPath,
    },
  });

  assert.equal(inspected.preflight.swappinessStatus, "available");
  assert.equal(inspected.preflight.swappiness, 10);
  assert.equal(inspected.preflight.swapStatus, "unreadable");
  assert.match(inspected.preflight.swapError ?? "", /host meminfo file must be at most/);
});

test("loadAndDiagnoseDeployment reports a service-readable gateway config in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-config-file-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    user: "root",
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "config_file_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /by "root"/);
  assert.match(diagnostic.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("loadAndDiagnoseDeployment errors when the generated working directory is missing in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-working-directory-missing-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const missingWorkingDirectory = join(tempDir, "missing-ray");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: missingWorkingDirectory,
    configPath,
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "working_directory_missing",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /WorkingDirectory/);
  assert.match(
    diagnostic.message,
    new RegExp(missingWorkingDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("loadAndDiagnoseDeployment reports the generated working directory in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-working-directory-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "working_directory_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("loadAndDiagnoseDeployment errors when the built gateway entrypoint is missing in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-gateway-entrypoint-missing-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_entrypoint_missing",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /bun run build/);
});

test("loadAndDiagnoseDeployment reports the built gateway entrypoint in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-gateway-entrypoint-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const entrypointPath = join(tempDir, "apps", "gateway", "dist", "index.js");
  await mkdir(join(tempDir, "apps", "gateway", "dist"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(entrypointPath, "export {};\n");

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    runtimeBinary: process.execPath,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "gateway_entrypoint_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(
    diagnostic.message,
    new RegExp(entrypointPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const importDiagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_entrypoint_import_ok",
  );
  assert.ok(importDiagnostic);
  assert.equal(importDiagnostic.level, "info");
  assert.match(importDiagnostic.message, /Bun production dependency install/);
});

test("loadAndDiagnoseDeployment errors when the built gateway cannot import dependencies", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-gateway-import-missing-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  const entrypointPath = join(tempDir, "apps", "gateway", "dist", "index.js");
  await mkdir(join(tempDir, "apps", "gateway", "dist"), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await writeFile(entrypointPath, "import '@ray/definitely-missing';\n");

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    runtimeBinary: process.execPath,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_entrypoint_import_failed",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /definitely-missing/);
  assert.match(diagnostic.message, /bun install --frozen-lockfile/);
  assert.match(diagnostic.message, /bun run build/);
  assert.match(diagnostic.message, /bun install --production --frozen-lockfile/);
});

test("loadAndDiagnoseDeployment errors when the projected memory fit exceeds a 4 GB target", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-memory-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "oversized.gguf");
  await writeFile(modelPath, "GGUF");
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
    scheduler: {
      maxInflightTokens: 4_096,
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
  const tempDir = await mkRayDeployTempDir("ray-deploy-model-missing-");
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
    scheduler: {
      maxInflightTokens: 4_096,
    },
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    env: {
      RAY_LLAMA_CPP_BINARY_SOURCE_PATH: join(tempDir, "llama-server"),
      RAY_MODEL_SOURCE_PATH: join(tempDir, "source.gguf"),
    },
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "model_file_missing");
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /was not found/);
  assert.match(diagnostic.message, /RAY_LLAMA_CPP_BINARY_SOURCE_PATH/);
  assert.match(diagnostic.message, /bun run model:stage -- --config <same-config>/);
  assert.match(diagnostic.message, /--apply/);
});

test("loadAndDiagnoseDeployment errors when the configured model file is not GGUF", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-model-format-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "model.gguf");
  const binaryPath = join(tempDir, "llama-server");
  await writeFile(modelPath, "NOPE");
  await writeFile(binaryPath, "#!/bin/sh\n");
  await chmod(binaryPath, 0o755);

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  config.model.adapter.launchProfile.binaryPath = binaryPath;
  config.model.adapter.launchProfile.modelPath = modelPath;

  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    env: {
      RAY_LLAMA_CPP_BINARY_SOURCE_PATH: join(tempDir, "source-llama-server"),
      RAY_MODEL_SOURCE_PATH: join(tempDir, "model-source.gguf"),
    },
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  assert.equal(inspected.preflight.modelFileFormatStatus, "invalid");
  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "model_file_format_invalid",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /GGUF header/);
});

test("loadAndDiagnoseDeployment errors when the configured llama.cpp binary is missing in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-llama-binary-missing-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "model.gguf");
  await writeFile(modelPath, "GGUF");

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  config.model.adapter.launchProfile.binaryPath = join(tempDir, "missing-llama-server");
  config.model.adapter.launchProfile.modelPath = modelPath;

  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    env: {
      RAY_LLAMA_CPP_BINARY_SOURCE_PATH: join(tempDir, "source-llama-server"),
      RAY_MODEL_SOURCE_PATH: join(tempDir, "model-source.gguf"),
    },
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "llama_binary_missing");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /RAY_MODEL_SOURCE_PATH/);
  assert.match(diagnostic.message, /bun run model:stage -- --config <same-config>/);
  assert.match(diagnostic.message, /--apply/);
});

test("loadAndDiagnoseDeployment reports an executable llama.cpp binary in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-llama-binary-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "model.gguf");
  const binaryPath = join(tempDir, "llama-server");
  await writeFile(modelPath, "GGUF");
  await writeFile(binaryPath, `#!/bin/sh\ncat <<'EOF'\n${compatibleLlamaCppHelp}\nEOF\n`);
  await chmod(binaryPath, 0o755);

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  config.model.adapter.launchProfile.binaryPath = binaryPath;
  config.model.adapter.launchProfile.modelPath = modelPath;

  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "llama_binary_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, new RegExp(binaryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(inspected.preflight.llamaCppBinaryProbeStatus, "ok");
  const probeDiagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "llama_binary_probe_ok",
  );
  assert.ok(probeDiagnostic);
  assert.equal(probeDiagnostic.level, "info");
  assert.equal(inspected.preflight.llamaCppBinaryLaunchFlagsStatus, "ok");
  const launchFlagsDiagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "llama_binary_launch_flags_ok",
  );
  assert.ok(launchFlagsDiagnostic);
  assert.equal(launchFlagsDiagnostic.level, "info");
});

test("loadAndDiagnoseDeployment errors when llama.cpp binary lacks generated launch flags", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-llama-binary-flags-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "model.gguf");
  const binaryPath = join(tempDir, "llama-server");
  await writeFile(modelPath, "GGUF");
  await writeFile(binaryPath, "#!/bin/sh\nprintf '%s\\n' '--model' '--host' '--port'\n");
  await chmod(binaryPath, 0o755);

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  config.model.adapter.launchProfile.binaryPath = binaryPath;
  config.model.adapter.launchProfile.modelPath = modelPath;

  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  assert.equal(inspected.preflight.llamaCppBinaryProbeStatus, "ok");
  assert.equal(inspected.preflight.llamaCppBinaryLaunchFlagsStatus, "unsupported");
  assert.ok(inspected.preflight.llamaCppBinaryUnsupportedLaunchFlags?.includes("--ctx-size"));
  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "llama_binary_launch_flags_unsupported",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /--ctx-size/);
  assert.match(diagnostic.message, /newer compatible llama-server/);
});

test("loadAndDiagnoseDeployment errors when the configured llama.cpp binary fails startup probe", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-llama-binary-probe-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const modelPath = join(tempDir, "model.gguf");
  const binaryPath = join(tempDir, "llama-server");
  await writeFile(modelPath, "GGUF");
  await writeFile(binaryPath, "#!/bin/sh\necho 'missing shared library' >&2\nexit 126\n");
  await chmod(binaryPath, 0o755);

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  config.model.adapter.launchProfile.binaryPath = binaryPath;
  config.model.adapter.launchProfile.modelPath = modelPath;

  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
    memoryBudgetMiB: 4_096,
  });

  assert.equal(inspected.preflight.llamaCppBinaryProbeStatus, "failed");
  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "llama_binary_probe_failed",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /missing shared library/);
});

test("loadAndDiagnoseDeployment errors when the configured gateway runtime is missing in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-runtime-missing-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    runtimeBinary: join(tempDir, "missing-bun"),
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_runtime_missing",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
});

test("loadAndDiagnoseDeployment reports an executable gateway runtime in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-runtime-ok-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const runtimePath = join(tempDir, "bun");
  await writeFile(runtimePath, "#!/bin/sh\necho 1.3.9\n");
  await chmod(runtimePath, 0o755);

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    runtimeBinary: runtimePath,
    user: "root",
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find((entry) => entry.code === "gateway_runtime_ok");
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.message, /by "root"/);

  const versionDiagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_runtime_version_ok",
  );
  assert.ok(versionDiagnostic);
  assert.equal(versionDiagnostic.level, "info");
  assert.match(versionDiagnostic.message, /Bun version 1\.3\.9/);
});

test("loadAndDiagnoseDeployment runs gateway runtime version probe as the service user", async (t) => {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() === 0
  ) {
    return;
  }

  const tempDir = await mkRayDeployTempDir("ray-deploy-runtime-service-user-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const runtimePath = join(tempDir, "bun");
  const versionSecretPath = join(tempDir, "runtime-version");
  const quotedVersionSecretPath = `'${versionSecretPath.replace(/'/g, "'\\''")}'`;
  await writeFile(versionSecretPath, "1.3.9\n");
  await chmod(versionSecretPath, 0o600);
  await writeFile(runtimePath, `#!/bin/sh\ncat ${quotedVersionSecretPath}\n`);
  await chmod(runtimePath, 0o755);

  const serviceUid = process.getuid() === 65_534 ? 65_533 : 65_534;
  const serviceGid = process.getgid() === 65_534 ? 65_533 : 65_534;
  const passwdPath = join(tempDir, "passwd");
  const groupPath = join(tempDir, "group");
  await writeFile(
    passwdPath,
    `rayprobe:x:${serviceUid}:${serviceGid}:Ray probe:/nonexistent:/usr/sbin/nologin\n`,
  );
  await writeFile(groupPath, `rayprobe:x:${serviceGid}:\n`);

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const originalGetuid = process.getuid;
  Object.defineProperty(process, "getuid", {
    value: () => 0,
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(process, "getuid", {
      value: originalGetuid,
      configurable: true,
    });
  });

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    runtimeBinary: runtimePath,
    user: "rayprobe",
    strictFilesystem: true,
    hostFiles: {
      passwd: passwdPath,
      group: groupPath,
    },
  });

  assert.equal(inspected.preflight.gatewayRuntimeBinaryStatus, "found");
  assert.equal(inspected.preflight.gatewayRuntimeVersionStatus, "unreadable");
  assert.match(
    inspected.preflight.gatewayRuntimeVersionError ?? "",
    /EPERM|operation not permitted|permission|uid/i,
  );
});

test("loadAndDiagnoseDeployment errors when the configured Bun runtime is too old in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-runtime-old-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const runtimePath = join(tempDir, "bun");
  await writeFile(runtimePath, "#!/bin/sh\necho 1.2.9\n");
  await chmod(runtimePath, 0o755);

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    runtimeBinary: runtimePath,
    strictFilesystem: true,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "gateway_runtime_version_unsupported",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "error");
  assert.match(diagnostic.message, /1\.2\.9/);
});

test("loadAndDiagnoseDeployment reports async queue storage headroom from the nearest existing parent", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-storage-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const storageDir = join(tempDir, "state", "async-queue");
  const config = mergeConfig(createDefaultConfig("vps"), {
    asyncQueue: {
      enabled: true,
      storageDir,
      minFreeStorageMiB: 1,
    },
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "async_queue_storage_ok" || entry.code === "async_queue_storage_low",
  );
  assert.ok(diagnostic);
  assert.match(diagnostic.message, new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(diagnostic.message, /asyncQueue\.minFreeStorageMiB/);
});

test("loadAndDiagnoseDeployment records working directory storage headroom in strict mode", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-workdir-storage-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig("tiny");
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    strictFilesystem: true,
  });

  assert.equal(inspected.preflight.workingDirectoryPath, tempDir);
  assert.equal(inspected.preflight.workingDirectoryStatus, "found");
  assert.equal(inspected.preflight.workingDirectoryStorageStatus, "available");
  assert.equal(typeof inspected.preflight.workingDirectoryAvailableMiB, "number");
  assert.ok((inspected.preflight.workingDirectoryAvailableMiB ?? 0) >= 0);
  assert.ok(
    inspected.diagnostics.some((entry) =>
      ["working_directory_storage_ok", "working_directory_storage_low"].includes(entry.code),
    ),
  );
});

test("loadAndDiagnoseDeployment warns when non-strict async queue storage is blocked by an existing file", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-storage-file-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const blockedPath = join(tempDir, "blocked");
  await writeFile(blockedPath, "");

  const config = mergeConfig(createDefaultConfig("vps"), {
    asyncQueue: {
      enabled: true,
      storageDir: join(blockedPath, "async-queue"),
      minFreeStorageMiB: 1,
    },
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
  });

  const diagnostic = inspected.diagnostics.find(
    (entry) => entry.code === "async_queue_storage_not_directory",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.level, "warn");
  assert.match(diagnostic.message, new RegExp(blockedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("loadAndDiagnoseDeployment can skip host async queue storage probes", async (t) => {
  const tempDir = await mkRayDeployTempDir("ray-deploy-storage-skip-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const blockedPath = join(tempDir, "blocked");
  await writeFile(blockedPath, "");

  const config = mergeConfig(createDefaultConfig("vps"), {
    asyncQueue: {
      enabled: true,
      storageDir: join(blockedPath, "async-queue"),
      minFreeStorageMiB: 1,
    },
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const inspected = await loadAndDiagnoseDeployment({
    cwd: tempDir,
    configPath,
    inspectHostStorage: false,
  });

  assert.equal(inspected.preflight.asyncQueueStorageStatus, undefined);
  assert.equal(inspected.preflight.asyncQueueStorageAvailableMiB, undefined);
  assert.equal(
    inspected.diagnostics.some((entry) =>
      [
        "async_queue_storage_low",
        "async_queue_storage_ok",
        "async_queue_storage_not_directory",
        "async_queue_storage_unreadable",
        "async_queue_storage_service_user_inaccessible",
      ].includes(entry.code),
    ),
    false,
  );
});
