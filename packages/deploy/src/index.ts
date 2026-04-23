import { stat } from "node:fs/promises";
import { totalmem } from "node:os";
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

type MemoryBudgetSource = "override" | "preset" | "host";

export interface DeploymentPreflight {
  hostMemoryMiB?: number;
  memoryBudgetMiB?: number;
  memoryBudgetSource?: MemoryBudgetSource;
  modelFileBytes?: number;
  modelFilePath?: string;
  modelFileStatus?: "found" | "missing" | "unreadable";
  modelFileError?: string;
}

export interface LlamaCppMemoryEstimate {
  memoryBudgetMiB: number;
  memoryBudgetSource: MemoryBudgetSource;
  modelFileMiB: number;
  promptCacheMiB: number;
  kvCacheMiB: number;
  runtimeMiB: number;
  schedulerBufferMiB: number;
  reserveMiB: number;
  safeBudgetMiB: number;
  projectedWorkingSetMiB: number;
}

export interface DiagnoseConfigOptions {
  preflight?: DeploymentPreflight;
  strictFilesystem?: boolean;
}

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_CACHE_RAM_MIB = 8_192;
const RAY_RUNTIME_RESERVE_MIB = 192;
const LLAMA_CPP_RUNTIME_RESERVE_MIB = 160;
const MIN_SYSTEM_RESERVE_MIB = 768;
const SYSTEM_RESERVE_RATIO = 0.2;
const SCHEDULER_BYTES_PER_TOKEN = 768;
const TIGHT_MEMORY_RATIO = 0.9;

function isSub1bPreset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return (
    preset === "single-vps-sub1b" ||
    preset === "single-vps-sub1b-cx23" ||
    preset === "single-vps-sub1b-cax11"
  );
}

function isCax11Preset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-sub1b-cax11";
}

function formatSystemdEnvironmentLine(name: string, value: string | number): string {
  return `Environment=${name}=${value}`;
}

function boolToEnv(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

function bytesToMiBRoundedUp(value: number): number {
  return Math.ceil(value / BYTES_PER_MIB);
}

function formatMiB(value: number): string {
  return `${value.toLocaleString("en-US")} MiB`;
}

function getPresetMemoryBudgetMiB(preset: LlamaCppLaunchProfile["preset"]): number {
  return isSub1bPreset(preset) ? 4_096 : 8_192;
}

function estimateKvBytesPerToken(preset: LlamaCppLaunchProfile["preset"]): number {
  return isSub1bPreset(preset) ? 128 * 1_024 : 320 * 1_024;
}

function formatMemoryEstimateMessage(estimate: LlamaCppMemoryEstimate): string {
  return `Projected llama.cpp working set is about ${formatMiB(
    estimate.projectedWorkingSetMiB,
  )} against a safe budget of ${formatMiB(estimate.safeBudgetMiB)} on a ${formatMiB(
    estimate.memoryBudgetMiB,
  )} ${estimate.memoryBudgetSource} target. Components: model=${formatMiB(
    estimate.modelFileMiB,
  )}, cache-ram=${formatMiB(estimate.promptCacheMiB)}, kv=${formatMiB(
    estimate.kvCacheMiB,
  )}, runtime=${formatMiB(estimate.runtimeMiB)}, scheduler=${formatMiB(
    estimate.schedulerBufferMiB,
  )}, reserve=${formatMiB(estimate.reserveMiB)}.`;
}

function resolveMemoryBudget(options: {
  preset: LlamaCppLaunchProfile["preset"];
  overrideMemoryBudgetMiB?: number;
  hostMemoryMiB?: number;
}): { memoryBudgetMiB: number; memoryBudgetSource: MemoryBudgetSource } {
  if (options.overrideMemoryBudgetMiB !== undefined) {
    return {
      memoryBudgetMiB: options.overrideMemoryBudgetMiB,
      memoryBudgetSource: "override",
    };
  }

  const presetBudgetMiB = getPresetMemoryBudgetMiB(options.preset);
  const hostMemoryMiB = options.hostMemoryMiB;

  if (hostMemoryMiB !== undefined && hostMemoryMiB > 0) {
    if (hostMemoryMiB < presetBudgetMiB) {
      return {
        memoryBudgetMiB: hostMemoryMiB,
        memoryBudgetSource: "host",
      };
    }

    return {
      memoryBudgetMiB: presetBudgetMiB,
      memoryBudgetSource: "preset",
    };
  }

  return {
    memoryBudgetMiB: presetBudgetMiB,
    memoryBudgetSource: "preset",
  };
}

export function estimateLlamaCppMemoryFit(
  config: RayConfig,
  launchProfile: LlamaCppLaunchProfile,
  preflight: DeploymentPreflight,
): LlamaCppMemoryEstimate | undefined {
  if (
    preflight.memoryBudgetMiB === undefined ||
    preflight.memoryBudgetSource === undefined ||
    preflight.modelFileBytes === undefined
  ) {
    return undefined;
  }

  if (launchProfile.cacheRamMiB === -1) {
    return undefined;
  }

  const promptCacheMiB =
    launchProfile.cacheRamMiB === undefined
      ? DEFAULT_CACHE_RAM_MIB
      : Math.max(0, launchProfile.cacheRamMiB);
  const kvCacheMiB = bytesToMiBRoundedUp(
    launchProfile.ctxSize *
      Math.max(1, launchProfile.parallel) *
      estimateKvBytesPerToken(launchProfile.preset),
  );
  const schedulerBufferMiB = bytesToMiBRoundedUp(
    (config.scheduler.maxQueuedTokens + config.scheduler.maxInflightTokens) *
      SCHEDULER_BYTES_PER_TOKEN,
  );
  const runtimeMiB = RAY_RUNTIME_RESERVE_MIB + LLAMA_CPP_RUNTIME_RESERVE_MIB;
  const reserveMiB = Math.max(
    MIN_SYSTEM_RESERVE_MIB,
    Math.ceil(preflight.memoryBudgetMiB * SYSTEM_RESERVE_RATIO),
  );
  const safeBudgetMiB = Math.max(0, preflight.memoryBudgetMiB - reserveMiB);
  const modelFileMiB = bytesToMiBRoundedUp(preflight.modelFileBytes);
  const projectedWorkingSetMiB =
    modelFileMiB + promptCacheMiB + kvCacheMiB + runtimeMiB + schedulerBufferMiB;

  return {
    memoryBudgetMiB: preflight.memoryBudgetMiB,
    memoryBudgetSource: preflight.memoryBudgetSource,
    modelFileMiB,
    promptCacheMiB,
    kvCacheMiB,
    runtimeMiB,
    schedulerBufferMiB,
    reserveMiB,
    safeBudgetMiB,
    projectedWorkingSetMiB,
  };
}

export function buildLlamaCppEnvironment(profile: LlamaCppLaunchProfile): Record<string, string> {
  return {
    LLAMA_ARG_MODEL: profile.modelPath,
    ...(profile.alias ? { LLAMA_ARG_ALIAS: profile.alias } : {}),
    LLAMA_ARG_HOST: profile.host,
    LLAMA_ARG_PORT: profile.port.toString(),
    LLAMA_ARG_CTX_SIZE: profile.ctxSize.toString(),
    LLAMA_ARG_N_PARALLEL: profile.parallel.toString(),
    LLAMA_ARG_THREADS: profile.threads.toString(),
    ...(profile.threadsBatch !== undefined
      ? { LLAMA_ARG_THREADS_BATCH: profile.threadsBatch.toString() }
      : {}),
    LLAMA_ARG_THREADS_HTTP: profile.threadsHttp.toString(),
    LLAMA_ARG_BATCH_SIZE: profile.batchSize.toString(),
    LLAMA_ARG_UBATCH_SIZE: profile.ubatchSize.toString(),
    LLAMA_ARG_CACHE_PROMPT: boolToEnv(profile.cachePrompt),
    LLAMA_ARG_CACHE_REUSE: profile.cacheReuse.toString(),
    ...(profile.cacheRamMiB !== undefined
      ? { LLAMA_ARG_CACHE_RAM: profile.cacheRamMiB.toString() }
      : {}),
    LLAMA_ARG_CONT_BATCHING: boolToEnv(profile.continuousBatching),
    LLAMA_ARG_ENDPOINT_METRICS: boolToEnv(profile.enableMetrics),
    LLAMA_ARG_ENDPOINT_SLOTS: boolToEnv(profile.exposeSlots),
    LLAMA_ARG_WARMUP: boolToEnv(profile.warmup),
    LLAMA_ARG_KV_UNIFIED: boolToEnv(profile.enableUnifiedKv),
    LLAMA_ARG_CACHE_IDLE_SLOTS: boolToEnv(profile.cacheIdleSlots),
    LLAMA_ARG_CONTEXT_SHIFT: boolToEnv(profile.contextShift),
  };
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
  const environmentLines = Object.entries(buildLlamaCppEnvironment(profile))
    .map(([name, value]) => formatSystemdEnvironmentLine(name, value))
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
  options: DiagnoseConfigOptions = {},
): DeploymentDiagnostic[] {
  const diagnostics: DeploymentDiagnostic[] = [];
  const strictFilesystem = options.strictFilesystem === true;
  const preflight = options.preflight;

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

      if (launchProfile.cacheRamMiB === undefined) {
        diagnostics.push({
          level: "warn",
          code: "cache_ram_implicit",
          message:
            "llama.cpp cacheRamMiB is not pinned. The upstream cache-ram default is much larger than a 4 GB VPS target, so Ray should set an explicit budget.",
        });
      } else {
        if (launchProfile.cacheRamMiB === -1) {
          diagnostics.push({
            level: "warn",
            code: "cache_ram_unbounded",
            message:
              "llama.cpp cacheRamMiB is unlimited. Cheap VPS deployments should bound prompt cache RAM explicitly.",
          });
        }

        if (launchProfile.cacheRamMiB === 0 && launchProfile.cacheIdleSlots) {
          diagnostics.push({
            level: "warn",
            code: "cache_idle_slots_without_cache_ram",
            message:
              "cacheIdleSlots is enabled but cacheRamMiB is 0. llama.cpp idle-slot caching needs cache RAM to be enabled.",
          });
        }

        if (isSub1bPreset(launchProfile.preset) && launchProfile.cacheRamMiB > 1024) {
          diagnostics.push({
            level: "warn",
            code: "cache_ram_high_for_small_vps",
            message:
              "cacheRamMiB is high for a 4 GB VPS target. Sub-1B single-node profiles should keep prompt cache RAM tightly bounded.",
          });
        }
      }

      if (launchProfile.cacheIdleSlots && !launchProfile.enableUnifiedKv) {
        diagnostics.push({
          level: "warn",
          code: "cache_idle_slots_without_unified_kv",
          message:
            "cacheIdleSlots is enabled without unified KV. llama.cpp idle-slot caching expects unified KV to stay on.",
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

      if (isCax11Preset(launchProfile.preset) && launchProfile.parallel > 1) {
        diagnostics.push({
          level: "warn",
          code: "cax11_parallel_high",
          message:
            "The CAX11-class ARM preset is tuned for one active slot. Raising parallel above 1 usually hurts latency before it helps throughput on 2 vCPU ARM nodes.",
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

      if (strictFilesystem && preflight?.modelFileStatus === "missing") {
        diagnostics.push({
          level: "error",
          code: "model_file_missing",
          message: `The configured GGUF model file was not found at ${preflight.modelFilePath}. Doctor cannot estimate memory fit without the real model file.`,
        });
      } else if (strictFilesystem && preflight?.modelFileStatus === "unreadable") {
        diagnostics.push({
          level: "error",
          code: "model_file_unreadable",
          message: `The configured GGUF model file at ${preflight.modelFilePath} could not be read${preflight.modelFileError ? ` (${preflight.modelFileError})` : ""}. Doctor cannot estimate memory fit without the real model file.`,
        });
      }

      if (launchProfile.cacheRamMiB === -1 && preflight?.memoryBudgetMiB !== undefined) {
        diagnostics.push({
          level: "error",
          code: "memory_fit_unbounded",
          message:
            "cacheRamMiB is unlimited, so Ray cannot guarantee that the llama.cpp working set will fit within the target memory budget.",
        });
      }

      const memoryEstimate = estimateLlamaCppMemoryFit(config, launchProfile, preflight ?? {});
      if (memoryEstimate) {
        const message = formatMemoryEstimateMessage(memoryEstimate);

        if (memoryEstimate.projectedWorkingSetMiB > memoryEstimate.safeBudgetMiB) {
          diagnostics.push({
            level: "error",
            code: "memory_fit_exceeded",
            message,
          });
        } else if (
          memoryEstimate.projectedWorkingSetMiB >
          Math.floor(memoryEstimate.safeBudgetMiB * TIGHT_MEMORY_RATIO)
        ) {
          diagnostics.push({
            level: "warn",
            code: "memory_fit_tight",
            message,
          });
        } else {
          diagnostics.push({
            level: "info",
            code: "memory_fit_ok",
            message,
          });
        }
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
  memoryBudgetMiB?: number;
  strictFilesystem?: boolean;
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
  const preflight = await collectDeploymentPreflight(loaded.config, {
    ...(options.memoryBudgetMiB !== undefined ? { memoryBudgetMiB: options.memoryBudgetMiB } : {}),
    ...(options.strictFilesystem !== undefined
      ? { strictFilesystem: options.strictFilesystem }
      : {}),
  });

  return {
    config: loaded.config,
    diagnostics: diagnoseConfig(loaded.config, options.env ?? process.env, options.envFile, {
      preflight,
      ...(options.strictFilesystem !== undefined
        ? { strictFilesystem: options.strictFilesystem }
        : {}),
    }),
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
  memoryBudgetMiB?: number;
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

async function collectDeploymentPreflight(
  config: RayConfig,
  options: {
    memoryBudgetMiB?: number;
    strictFilesystem?: boolean;
  },
): Promise<DeploymentPreflight> {
  const hostMemoryMiB = Math.max(1, Math.floor(totalmem() / BYTES_PER_MIB));

  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    return {
      hostMemoryMiB,
    };
  }

  const launchProfile = config.model.adapter.launchProfile;
  const budget = resolveMemoryBudget({
    preset: launchProfile.preset,
    ...(options.memoryBudgetMiB !== undefined
      ? { overrideMemoryBudgetMiB: options.memoryBudgetMiB }
      : {}),
    hostMemoryMiB,
  });
  const preflight: DeploymentPreflight = {
    hostMemoryMiB,
    memoryBudgetMiB: budget.memoryBudgetMiB,
    memoryBudgetSource: budget.memoryBudgetSource,
    modelFilePath: launchProfile.modelPath,
  };

  try {
    const fileStat = await stat(launchProfile.modelPath);
    if (!fileStat.isFile()) {
      return {
        ...preflight,
        modelFileStatus: "unreadable",
        modelFileError: "not a regular file",
      };
    }

    return {
      ...preflight,
      modelFileBytes: fileStat.size,
      modelFileStatus: "found",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (!options.strictFilesystem) {
      return preflight;
    }

    return {
      ...preflight,
      modelFileStatus: isMissing ? "missing" : "unreadable",
      modelFileError: message,
    };
  }
}
