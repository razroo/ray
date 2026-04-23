import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type LlamaCppLaunchProfile,
  RayError,
  isNonEmptyString,
  type LogLevel,
  type RayConfig,
  type RayProfile,
} from "@razroo/ray-core";
import { createDefaultConfig, mergeConfig, type DeepPartial } from "./defaults.js";

const llamaCppLaunchPresets = new Set<LlamaCppLaunchProfile["preset"]>([
  "single-vps-sub1b",
  "single-vps-sub1b-cx23",
  "single-vps-sub1b-cax11",
  "single-vps-balanced",
]);

export interface LoadRayConfigOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedRayConfig {
  config: RayConfig;
  configPath?: string;
}

function parseConfigJson(raw: string, configPath: string): DeepPartial<RayConfig> {
  try {
    return JSON.parse(raw) as DeepPartial<RayConfig>;
  } catch (error) {
    throw new RayError(`Failed to parse config file: ${configPath}`, {
      code: "config_parse_error",
      status: 500,
      details: error,
    });
  }
}

function parseProfile(value: string | undefined): RayProfile | undefined {
  if (value === "tiny" || value === "sub1b" || value === "vps" || value === "balanced") {
    return value;
  }

  return undefined;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RayError(`Expected ${label} to be a positive integer`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  return undefined;
}

function isLlamaCppLaunchPreset(value: string): value is LlamaCppLaunchProfile["preset"] {
  return llamaCppLaunchPresets.has(value as LlamaCppLaunchProfile["preset"]);
}

function applyEnvOverrides(config: RayConfig, env: NodeJS.ProcessEnv): RayConfig {
  const next = structuredClone(config);
  const host = env.RAY_HOST;
  const port = parsePositiveInteger(env.RAY_PORT, "RAY_PORT");
  const logLevel = parseLogLevel(env.RAY_LOG_LEVEL);

  if (isNonEmptyString(host)) {
    next.server.host = host;
  }

  if (port !== undefined) {
    next.server.port = port;
  }

  if (logLevel !== undefined) {
    next.telemetry.logLevel = logLevel;
  }

  return next;
}

function resolveConfigPaths(config: RayConfig, cwd: string): RayConfig {
  const next = structuredClone(config);
  next.asyncQueue.storageDir = path.resolve(cwd, next.asyncQueue.storageDir);
  return next;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RayError(`${label} must be a positive integer`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RayError(`${label} must be a non-negative integer`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertIntegerAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RayError(`${label} must be an integer greater than or equal to ${minimum}`, {
      code: "config_validation_error",
      status: 500,
      details: { value, minimum },
    });
  }
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RayError(`${label} must be between 0 and 1`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RayError(`${label} must be a safe integer`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertResponseFormat(value: { type: string } | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (value.type !== "text" && value.type !== "json_object") {
    throw new RayError(`${label}.type must be 'text' or 'json_object'`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }
}

function assertStopSequences(value: string[] | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new RayError(`${label} must be a non-empty array of strings`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      throw new RayError(`${label} entries must be non-empty strings`, {
        code: "config_validation_error",
        status: 500,
        details: value,
      });
    }
  }
}

function assertTemplateVariables(value: Record<string, unknown> | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError(`${label} must be an object of template variable values`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!isNonEmptyString(key)) {
      throw new RayError(`${label} keys must be non-empty strings`, {
        code: "config_validation_error",
        status: 500,
        details: value,
      });
    }

    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new RayError(`${label}.${key} must be a string, number, or boolean`, {
        code: "config_validation_error",
        status: 500,
        details: entry,
      });
    }
  }
}

function assertWarmupRequest(
  request: {
    input?: string;
    maxTokens?: number;
    seed?: number;
    stop?: string[];
    responseFormat?: { type: string };
    templateId?: string;
    templateVariables?: Record<string, unknown>;
  },
  label: string,
): void {
  if (isNonEmptyString(request.templateId)) {
    if (request.input !== undefined) {
      throw new RayError(`${label}.input must be omitted when templateId is provided`, {
        code: "config_validation_error",
        status: 500,
      });
    }

    assertTemplateVariables(request.templateVariables, `${label}.templateVariables`);
  } else if (!isNonEmptyString(request.input)) {
    throw new RayError(`${label}.input must be a non-empty string`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (request.maxTokens !== undefined) {
    assertPositiveInteger(request.maxTokens, `${label}.maxTokens`);
  }

  if (request.seed !== undefined) {
    assertSafeInteger(request.seed, `${label}.seed`);
  }

  assertStopSequences(request.stop, `${label}.stop`);
  assertResponseFormat(request.responseFormat, `${label}.responseFormat`);
}

function assertStringArray(value: string[] | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new RayError(`${label} must be an array of non-empty strings`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }
}

function validateConfig(config: RayConfig): RayConfig {
  if (!isNonEmptyString(config.server.host)) {
    throw new RayError("server.host must be a non-empty string", {
      code: "config_validation_error",
      status: 500,
    });
  }

  assertPositiveInteger(config.server.port, "server.port");
  assertPositiveInteger(config.server.requestBodyLimitBytes, "server.requestBodyLimitBytes");
  assertPositiveInteger(config.model.contextWindow, "model.contextWindow");
  assertPositiveInteger(config.model.maxOutputTokens, "model.maxOutputTokens");
  assertPositiveInteger(config.scheduler.concurrency, "scheduler.concurrency");
  assertPositiveInteger(config.scheduler.maxQueue, "scheduler.maxQueue");
  assertPositiveInteger(config.scheduler.maxQueuedTokens, "scheduler.maxQueuedTokens");
  assertPositiveInteger(config.scheduler.maxInflightTokens, "scheduler.maxInflightTokens");
  assertPositiveInteger(config.scheduler.requestTimeoutMs, "scheduler.requestTimeoutMs");
  assertPositiveInteger(config.scheduler.affinityLookahead, "scheduler.affinityLookahead");
  assertPositiveInteger(config.scheduler.shortJobMaxTokens, "scheduler.shortJobMaxTokens");
  assertPositiveInteger(config.asyncQueue.pollIntervalMs, "asyncQueue.pollIntervalMs");
  assertPositiveInteger(config.asyncQueue.dispatchConcurrency, "asyncQueue.dispatchConcurrency");
  assertPositiveInteger(config.asyncQueue.maxAttempts, "asyncQueue.maxAttempts");
  assertPositiveInteger(config.asyncQueue.callbackTimeoutMs, "asyncQueue.callbackTimeoutMs");
  assertPositiveInteger(config.asyncQueue.maxCallbackAttempts, "asyncQueue.maxCallbackAttempts");
  assertPositiveInteger(config.cache.maxEntries, "cache.maxEntries");
  assertPositiveInteger(config.cache.ttlMs, "cache.ttlMs");
  assertPositiveInteger(
    config.gracefulDegradation.maxPromptChars,
    "gracefulDegradation.maxPromptChars",
  );
  assertPositiveInteger(
    config.gracefulDegradation.degradeToMaxTokens,
    "gracefulDegradation.degradeToMaxTokens",
  );
  assertPositiveInteger(config.adaptiveTuning.sampleSize, "adaptiveTuning.sampleSize");
  assertPositiveInteger(
    config.adaptiveTuning.familyHistorySize,
    "adaptiveTuning.familyHistorySize",
  );
  assertPositiveInteger(
    config.adaptiveTuning.learnedCapMinSamples,
    "adaptiveTuning.learnedCapMinSamples",
  );
  assertPositiveInteger(
    config.adaptiveTuning.queueLatencyThresholdMs,
    "adaptiveTuning.queueLatencyThresholdMs",
  );
  assertPositiveInteger(config.adaptiveTuning.minOutputTokens, "adaptiveTuning.minOutputTokens");
  assertPositiveInteger(
    config.adaptiveTuning.learnedCapHeadroomTokens,
    "adaptiveTuning.learnedCapHeadroomTokens",
  );
  assertPositiveInteger(config.rateLimit.windowMs, "rateLimit.windowMs");
  assertPositiveInteger(config.rateLimit.maxRequests, "rateLimit.maxRequests");
  assertUnitInterval(
    config.adaptiveTuning.maxOutputReductionRatio,
    "adaptiveTuning.maxOutputReductionRatio",
  );
  assertUnitInterval(config.adaptiveTuning.draftPercentile, "adaptiveTuning.draftPercentile");
  assertUnitInterval(config.adaptiveTuning.shortPercentile, "adaptiveTuning.shortPercentile");

  if (!isNonEmptyString(config.model.id) || !isNonEmptyString(config.model.family)) {
    throw new RayError("model.id and model.family must be non-empty strings", {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (!isNonEmptyString(config.asyncQueue.storageDir)) {
    throw new RayError("asyncQueue.storageDir must be a non-empty string", {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (
    !Array.isArray(config.promptCompiler.familyMetadataKeys) ||
    config.promptCompiler.familyMetadataKeys.some((value) => !isNonEmptyString(value))
  ) {
    throw new RayError("promptCompiler.familyMetadataKeys must be an array of non-empty strings", {
      code: "config_validation_error",
      status: 500,
      details: config.promptCompiler.familyMetadataKeys,
    });
  }

  if (config.auth.enabled && !isNonEmptyString(config.auth.apiKeyEnv)) {
    throw new RayError("auth.apiKeyEnv must be set when auth is enabled", {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (config.model.adapter.kind === "openai-compatible") {
    if (
      !isNonEmptyString(config.model.adapter.baseUrl) ||
      !isNonEmptyString(config.model.adapter.modelRef)
    ) {
      throw new RayError("openai-compatible adapters require baseUrl and modelRef", {
        code: "config_validation_error",
        status: 500,
      });
    }

    assertPositiveInteger(config.model.adapter.timeoutMs, "model.adapter.timeoutMs");

    for (const [index, request] of (config.model.adapter.warmupRequests ?? []).entries()) {
      assertWarmupRequest(
        request as {
          input?: string;
          maxTokens?: number;
          seed?: number;
          stop?: string[];
          responseFormat?: { type: string };
          templateId?: string;
          templateVariables?: Record<string, unknown>;
        },
        `model.adapter.warmupRequests[${index}]`,
      );
    }
  }

  if (config.model.adapter.kind === "mock") {
    assertPositiveInteger(config.model.adapter.latencyMs, "model.adapter.latencyMs");
  }

  if (config.model.adapter.kind === "llama.cpp") {
    if (
      !isNonEmptyString(config.model.adapter.baseUrl) ||
      !isNonEmptyString(config.model.adapter.modelRef)
    ) {
      throw new RayError("llama.cpp adapters require baseUrl and modelRef", {
        code: "config_validation_error",
        status: 500,
      });
    }

    assertPositiveInteger(config.model.adapter.timeoutMs, "model.adapter.timeoutMs");

    if (config.model.adapter.slotId !== undefined && config.model.adapter.slotId < 0) {
      throw new RayError("model.adapter.slotId must be zero or greater when provided", {
        code: "config_validation_error",
        status: 500,
        details: config.model.adapter.slotId,
      });
    }

    if (
      config.model.adapter.slotStateTtlMs !== undefined &&
      (!Number.isInteger(config.model.adapter.slotStateTtlMs) ||
        config.model.adapter.slotStateTtlMs <= 0)
    ) {
      throw new RayError("model.adapter.slotStateTtlMs must be a positive integer", {
        code: "config_validation_error",
        status: 500,
        details: config.model.adapter.slotStateTtlMs,
      });
    }

    if (
      config.model.adapter.promptScaffoldCacheEntries !== undefined &&
      (!Number.isInteger(config.model.adapter.promptScaffoldCacheEntries) ||
        config.model.adapter.promptScaffoldCacheEntries <= 0)
    ) {
      throw new RayError("model.adapter.promptScaffoldCacheEntries must be a positive integer", {
        code: "config_validation_error",
        status: 500,
        details: config.model.adapter.promptScaffoldCacheEntries,
      });
    }

    for (const [index, request] of (config.model.adapter.warmupRequests ?? []).entries()) {
      assertWarmupRequest(
        request as {
          input?: string;
          maxTokens?: number;
          seed?: number;
          stop?: string[];
          responseFormat?: { type: string };
          templateId?: string;
          templateVariables?: Record<string, unknown>;
        },
        `model.adapter.warmupRequests[${index}]`,
      );
    }

    if (config.model.adapter.launchProfile) {
      const profile = config.model.adapter.launchProfile;
      if (
        !isNonEmptyString(profile.binaryPath) ||
        !isNonEmptyString(profile.modelPath) ||
        !isNonEmptyString(profile.host)
      ) {
        throw new RayError("model.adapter.launchProfile requires binaryPath, modelPath, and host", {
          code: "config_validation_error",
          status: 500,
          details: profile,
        });
      }

      if (!isLlamaCppLaunchPreset(profile.preset)) {
        throw new RayError("model.adapter.launchProfile.preset is not recognized", {
          code: "config_validation_error",
          status: 500,
          details: profile.preset,
        });
      }

      assertPositiveInteger(profile.port, "model.adapter.launchProfile.port");
      assertPositiveInteger(profile.ctxSize, "model.adapter.launchProfile.ctxSize");
      assertPositiveInteger(profile.parallel, "model.adapter.launchProfile.parallel");
      assertPositiveInteger(profile.threads, "model.adapter.launchProfile.threads");
      assertPositiveInteger(profile.threadsHttp, "model.adapter.launchProfile.threadsHttp");
      assertPositiveInteger(profile.batchSize, "model.adapter.launchProfile.batchSize");
      assertPositiveInteger(profile.ubatchSize, "model.adapter.launchProfile.ubatchSize");
      assertNonNegativeInteger(profile.cacheReuse, "model.adapter.launchProfile.cacheReuse");
      if (profile.cacheRamMiB !== undefined) {
        assertIntegerAtLeast(profile.cacheRamMiB, -1, "model.adapter.launchProfile.cacheRamMiB");
      }

      if (profile.threadsBatch !== undefined) {
        assertPositiveInteger(profile.threadsBatch, "model.adapter.launchProfile.threadsBatch");
      }

      assertStringArray(profile.extraArgs, "model.adapter.launchProfile.extraArgs");
    }
  }

  return config;
}

export function resolveAuthApiKeys(config: RayConfig, env: NodeJS.ProcessEnv): Set<string> {
  if (!config.auth.enabled) {
    return new Set();
  }

  const envName = config.auth.apiKeyEnv;

  if (!isNonEmptyString(envName)) {
    throw new RayError("auth.apiKeyEnv must be set when auth is enabled", {
      code: "config_validation_error",
      status: 500,
    });
  }

  const raw = env[envName];

  if (!isNonEmptyString(raw)) {
    throw new RayError(`Auth is enabled but ${envName} is empty`, {
      code: "config_validation_error",
      status: 500,
      details: { envName },
    });
  }

  const keys = raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (keys.length === 0) {
    throw new RayError(`Auth is enabled but ${envName} does not contain any usable API keys`, {
      code: "config_validation_error",
      status: 500,
      details: { envName },
    });
  }

  return new Set(keys);
}

export async function loadRayConfig(options: LoadRayConfigOptions = {}): Promise<LoadedRayConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const absoluteConfigPath = options.configPath ? path.resolve(cwd, options.configPath) : undefined;

  let fileConfig: DeepPartial<RayConfig> | undefined;

  if (absoluteConfigPath) {
    const raw = await fs.readFile(absoluteConfigPath, "utf8");
    fileConfig = parseConfigJson(raw, absoluteConfigPath);
  }

  const selectedProfile = fileConfig?.profile ?? parseProfile(env.RAY_PROFILE) ?? "sub1b";
  const defaultConfig = createDefaultConfig(selectedProfile);
  const mergedConfig = mergeConfig(defaultConfig, fileConfig);
  const config = validateConfig(resolveConfigPaths(applyEnvOverrides(mergedConfig, env), cwd));

  if (absoluteConfigPath) {
    return {
      config,
      configPath: absoluteConfigPath,
    };
  }

  return { config };
}

export function sanitizeConfig(config: RayConfig): Record<string, unknown> {
  const safe = structuredClone(config) as RayConfig;

  if (
    (safe.model.adapter.kind === "openai-compatible" || safe.model.adapter.kind === "llama.cpp") &&
    safe.model.adapter.headers
  ) {
    safe.model.adapter.headers = Object.fromEntries(
      Object.keys(safe.model.adapter.headers).map((key) => [key, "[redacted]"]),
    );
  }

  return safe as unknown as Record<string, unknown>;
}

export { createDefaultConfig, mergeConfig };
