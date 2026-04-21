import { promises as fs } from "node:fs";
import path from "node:path";
import { RayError, isNonEmptyString, type LogLevel, type RayConfig, type RayProfile } from "@ray/core";
import { createDefaultConfig, mergeConfig, type DeepPartial } from "./defaults.js";

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
  if (value === "tiny" || value === "vps" || value === "balanced") {
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

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RayError(`${label} must be a positive integer`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
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
  assertPositiveInteger(config.scheduler.requestTimeoutMs, "scheduler.requestTimeoutMs");
  assertPositiveInteger(config.cache.maxEntries, "cache.maxEntries");
  assertPositiveInteger(config.cache.ttlMs, "cache.ttlMs");
  assertPositiveInteger(config.gracefulDegradation.maxPromptChars, "gracefulDegradation.maxPromptChars");
  assertPositiveInteger(config.gracefulDegradation.degradeToMaxTokens, "gracefulDegradation.degradeToMaxTokens");
  assertPositiveInteger(config.rateLimit.windowMs, "rateLimit.windowMs");
  assertPositiveInteger(config.rateLimit.maxRequests, "rateLimit.maxRequests");

  if (!isNonEmptyString(config.model.id) || !isNonEmptyString(config.model.family)) {
    throw new RayError("model.id and model.family must be non-empty strings", {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (config.auth.enabled && !isNonEmptyString(config.auth.apiKeyEnv)) {
    throw new RayError("auth.apiKeyEnv must be set when auth is enabled", {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (config.model.adapter.kind === "openai-compatible") {
    if (!isNonEmptyString(config.model.adapter.baseUrl) || !isNonEmptyString(config.model.adapter.modelRef)) {
      throw new RayError("openai-compatible adapters require baseUrl and modelRef", {
        code: "config_validation_error",
        status: 500,
      });
    }

    assertPositiveInteger(config.model.adapter.timeoutMs, "model.adapter.timeoutMs");
  }

  if (config.model.adapter.kind === "mock") {
    assertPositiveInteger(config.model.adapter.latencyMs, "model.adapter.latencyMs");
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

  const selectedProfile = fileConfig?.profile ?? parseProfile(env.RAY_PROFILE) ?? "vps";
  const defaultConfig = createDefaultConfig(selectedProfile);
  const mergedConfig = mergeConfig(defaultConfig, fileConfig);
  const config = validateConfig(applyEnvOverrides(mergedConfig, env));

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

  if (safe.model.adapter.kind === "openai-compatible" && safe.model.adapter.headers) {
    safe.model.adapter.headers = Object.fromEntries(
      Object.keys(safe.model.adapter.headers).map((key) => [key, "[redacted]"]),
    );
  }

  return safe as unknown as Record<string, unknown>;
}

export { createDefaultConfig, mergeConfig };
