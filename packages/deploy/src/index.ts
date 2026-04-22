import path from "node:path";
import { loadRayConfig, resolveAuthApiKeys } from "@ray/config";
import { type LlamaCppLaunchProfile, type RayConfig } from "@razroo/ray-core";

export interface SystemdServiceOptions {
  workingDirectory: string;
  configPath: string;
  user: string;
  envFile?: string;
  nodeBinary?: string;
}

export interface ReverseProxyOptions {
  domain: string;
  upstreamPort: number;
  requestBodyLimitBytes: number;
}

export interface LlamaCppServiceOptions {
  user: string;
  envFile?: string;
  launchProfile: LlamaCppLaunchProfile;
}

export interface DeploymentDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

function formatSystemdEnvironmentLine(name: string, value: string | number): string {
  return `Environment=${name}=${value}`;
}

function boolToEnv(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

export function renderSystemdService(options: SystemdServiceOptions): string {
  const nodeBinary = options.nodeBinary ?? "/usr/bin/node";
  const envFileLine = options.envFile ? `EnvironmentFile=${options.envFile}\n` : "";
  const absoluteConfigPath = path.resolve(options.workingDirectory, options.configPath);

  return `[Unit]
Description=Ray Gateway
After=network.target

[Service]
Type=simple
User=${options.user}
WorkingDirectory=${options.workingDirectory}
${envFileLine}Environment=NODE_ENV=production
ExecStart=${nodeBinary} ${path.join(options.workingDirectory, "apps/gateway/dist/index.js")} --config ${absoluteConfigPath}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectControlGroups=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
UMask=027
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

export function renderCaddyfile(options: ReverseProxyOptions): string {
  return `${options.domain} {
  encode zstd gzip
  request_body {
    max_size ${options.requestBodyLimitBytes}
  }
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    -Server
  }
  reverse_proxy 127.0.0.1:${options.upstreamPort} {
    health_uri /health
    health_interval 15s
  }
}
`;
}

export function renderLlamaCppService(options: LlamaCppServiceOptions): string {
  const envFileLine = options.envFile ? `EnvironmentFile=${options.envFile}\n` : "";
  const profile = options.launchProfile;
  const environmentLines = [
    formatSystemdEnvironmentLine("LLAMA_ARG_MODEL", profile.modelPath),
    ...(profile.alias ? [formatSystemdEnvironmentLine("LLAMA_ARG_ALIAS", profile.alias)] : []),
    formatSystemdEnvironmentLine("LLAMA_ARG_HOST", profile.host),
    formatSystemdEnvironmentLine("LLAMA_ARG_PORT", profile.port),
    formatSystemdEnvironmentLine("LLAMA_ARG_CTX_SIZE", profile.ctxSize),
    formatSystemdEnvironmentLine("LLAMA_ARG_N_PARALLEL", profile.parallel),
    formatSystemdEnvironmentLine("LLAMA_ARG_THREADS", profile.threads),
    ...(profile.threadsBatch !== undefined
      ? [formatSystemdEnvironmentLine("LLAMA_ARG_THREADS_BATCH", profile.threadsBatch)]
      : []),
    formatSystemdEnvironmentLine("LLAMA_ARG_THREADS_HTTP", profile.threadsHttp),
    formatSystemdEnvironmentLine("LLAMA_ARG_BATCH_SIZE", profile.batchSize),
    formatSystemdEnvironmentLine("LLAMA_ARG_UBATCH_SIZE", profile.ubatchSize),
    formatSystemdEnvironmentLine("LLAMA_ARG_CACHE_PROMPT", boolToEnv(profile.cachePrompt)),
    formatSystemdEnvironmentLine("LLAMA_ARG_CACHE_REUSE", profile.cacheReuse),
    formatSystemdEnvironmentLine("LLAMA_ARG_CONT_BATCHING", boolToEnv(profile.continuousBatching)),
    formatSystemdEnvironmentLine("LLAMA_ARG_ENDPOINT_METRICS", boolToEnv(profile.enableMetrics)),
    formatSystemdEnvironmentLine("LLAMA_ARG_ENDPOINT_SLOTS", boolToEnv(profile.exposeSlots)),
    ...(profile.warmup ? [] : [formatSystemdEnvironmentLine("LLAMA_ARG_NO_WARMUP", 1)]),
    ...(profile.contextShift
      ? []
      : [formatSystemdEnvironmentLine("LLAMA_ARG_NO_CONTEXT_SHIFT", 1)]),
  ]
    .map((line) => `${line}\n`)
    .join("");
  const extraArgs =
    profile.extraArgs && profile.extraArgs.length > 0 ? ` ${profile.extraArgs.join(" ")}` : "";

  return `[Unit]
Description=llama.cpp Server for Ray
After=network.target

[Service]
Type=simple
User=${options.user}
${envFileLine}${environmentLines}ExecStart=${profile.binaryPath}${extraArgs}
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectControlGroups=true
ProtectKernelTunables=true
LockPersonality=true
MemoryDenyWriteExecute=true
RestrictSUIDSGID=true
UMask=027
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}

export function renderEnvironmentFileExample(config: RayConfig): string {
  const lines = ["# Ray environment variables"];

  if (config.auth.apiKeyEnv) {
    lines.push(`${config.auth.apiKeyEnv}=replace-with-comma-separated-client-api-keys`);
  }

  if (
    (config.model.adapter.kind === "openai-compatible" ||
      config.model.adapter.kind === "llama.cpp") &&
    config.model.adapter.apiKeyEnv
  ) {
    lines.push(`${config.model.adapter.apiKeyEnv}=replace-with-upstream-api-key`);
  }

  if (config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile) {
    lines.push(
      "# llama.cpp launch profile is rendered directly into the generated systemd service.",
    );
  }

  if (lines.length === 1) {
    lines.push("# No environment variables are required for this profile.");
  }

  return `${lines.join("\n")}\n`;
}

export function diagnoseConfig(
  config: RayConfig,
  env: NodeJS.ProcessEnv,
  envFile?: string,
): DeploymentDiagnostic[] {
  const diagnostics: DeploymentDiagnostic[] = [];

  if (
    config.server.host !== "127.0.0.1" &&
    config.server.host !== "::1" &&
    config.server.host !== "localhost"
  ) {
    diagnostics.push({
      level: "warn",
      code: "public_bind_address",
      message: "server.host is not loopback. The gateway is safer behind a local reverse proxy.",
    });
  }

  if (!config.auth.enabled) {
    diagnostics.push({
      level: "warn",
      code: "auth_disabled",
      message: "Inference auth is disabled. Public deployments should require Bearer API keys.",
    });
  } else {
    try {
      resolveAuthApiKeys(config, env);
    } catch {
      diagnostics.push({
        level: "error",
        code: "auth_keys_missing",
        message: `Auth is enabled but ${config.auth.apiKeyEnv} is not populated with API keys.`,
      });
    }

    if (!envFile) {
      diagnostics.push({
        level: "warn",
        code: "env_file_missing",
        message: "Auth is enabled but no EnvironmentFile was supplied for the systemd unit.",
      });
    }
  }

  if (!config.rateLimit.enabled) {
    diagnostics.push({
      level: "warn",
      code: "rate_limit_disabled",
      message:
        "Inference rate limiting is disabled. Public endpoints should have a bounded request budget.",
    });
  }

  if (
    config.model.adapter.kind === "openai-compatible" ||
    config.model.adapter.kind === "llama.cpp"
  ) {
    if (config.scheduler.requestTimeoutMs <= config.model.adapter.timeoutMs) {
      diagnostics.push({
        level: "warn",
        code: "timeout_budget_tight",
        message:
          "scheduler.requestTimeoutMs should exceed model.adapter.timeoutMs so gateway-level timeouts do not mask provider timeouts.",
      });
    }

    if (!config.model.warmOnBoot) {
      diagnostics.push({
        level: "warn",
        code: "warmup_disabled",
        message: "warmOnBoot is disabled. Cold starts on local backends will be less predictable.",
      });
    }
  }

  if (config.model.adapter.kind === "llama.cpp") {
    const launchProfile = config.model.adapter.launchProfile;
    if (!launchProfile) {
      diagnostics.push({
        level: "warn",
        code: "llama_launch_profile_missing",
        message:
          "No llama.cpp launchProfile is defined. Single-VPS deployments are easier to reproduce when Ray renders the backend service too.",
      });
    } else {
      const perSlotContext = Math.floor(
        launchProfile.ctxSize / Math.max(1, launchProfile.parallel),
      );

      if (!launchProfile.cachePrompt) {
        diagnostics.push({
          level: "warn",
          code: "cache_prompt_disabled",
          message: "llama.cpp cachePrompt is disabled. Prompt reuse and TTFT will be worse.",
        });
      }

      if (!launchProfile.enableMetrics || !launchProfile.exposeSlots) {
        diagnostics.push({
          level: "warn",
          code: "llama_endpoints_disabled",
          message:
            "llama.cpp metrics and slots endpoints should stay enabled so Ray can route work by slot and benchmark accurately.",
        });
      }

      if (config.scheduler.concurrency > launchProfile.parallel) {
        diagnostics.push({
          level: "warn",
          code: "scheduler_exceeds_parallel",
          message:
            "scheduler.concurrency is higher than llama.cpp parallel slots. Extra queued work will increase tail latency without increasing true concurrency.",
        });
      }

      if (perSlotContext >= 4096) {
        diagnostics.push({
          level: "warn",
          code: "ctx_per_slot_high",
          message:
            "The effective ctx-size per slot is high for a small-model VPS profile. Reducing ctx-size often improves throughput on 2 vCPU nodes.",
        });
      }

      if (perSlotContext < config.model.maxOutputTokens * 2) {
        diagnostics.push({
          level: "warn",
          code: "ctx_per_slot_tight",
          message:
            "The effective ctx-size per slot is close to the configured output budget. Longer prompts may be rejected or truncated sooner than expected.",
        });
      }
    }
  }

  if (diagnostics.length === 0) {
    diagnostics.push({
      level: "info",
      code: "config_ok",
      message: "No deployment issues were detected for the current config.",
    });
  }

  return diagnostics;
}

export async function loadAndDiagnoseDeployment(options: {
  cwd: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
}): Promise<{
  config: RayConfig;
  configPath?: string;
  diagnostics: DeploymentDiagnostic[];
}> {
  const loaded = await loadRayConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    ...(options.env ? { env: options.env } : {}),
  });

  return {
    config: loaded.config,
    diagnostics: diagnoseConfig(loaded.config, options.env ?? process.env, options.envFile),
    ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
  };
}

export async function renderDeploymentBundle(options: {
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  service: string;
  caddyfile: string;
  envFileExample: string;
  llamaCppService?: string;
  summary: Record<string, unknown>;
}> {
  const inspected = await loadAndDiagnoseDeployment(options);

  return {
    service: renderSystemdService({
      workingDirectory: options.cwd,
      configPath: options.configPath,
      user: options.user,
      ...(options.envFile ? { envFile: options.envFile } : {}),
    }),
    caddyfile: renderCaddyfile({
      domain: options.domain,
      upstreamPort: inspected.config.server.port,
      requestBodyLimitBytes: inspected.config.server.requestBodyLimitBytes,
    }),
    envFileExample: renderEnvironmentFileExample(inspected.config),
    ...(inspected.config.model.adapter.kind === "llama.cpp" &&
    inspected.config.model.adapter.launchProfile
      ? {
          llamaCppService: renderLlamaCppService({
            user: options.user,
            ...(options.envFile ? { envFile: options.envFile } : {}),
            launchProfile: inspected.config.model.adapter.launchProfile,
          }),
        }
      : {}),
    summary: {
      profile: inspected.config.profile,
      model: inspected.config.model,
      server: inspected.config.server,
      diagnostics: inspected.diagnostics,
    },
  };
}
