import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import {
  type LlamaCppLaunchProfile,
  RayError,
  getLlamaCppLaunchProfileExtraArgOverride,
  isNonEmptyString,
  type LogLevel,
  type Quantization,
  type RayConfig,
  type RayProfile,
  type RateLimitKeyStrategy,
} from "@razroo/ray-core";
import { createDefaultConfig, mergeConfig, type DeepPartial } from "./defaults.js";

const llamaCppLaunchPresets = new Set<LlamaCppLaunchProfile["preset"]>([
  "single-vps-sub1b",
  "single-vps-sub1b-cx23",
  "single-vps-sub1b-cax11",
  "single-vps-1b-cx23",
  "single-vps-1b-8gb",
  "single-vps-balanced",
]);
const rayProfiles = new Set<RayProfile>([
  "tiny",
  "sub1b",
  "sub1b-cax11",
  "1b",
  "1b-8gb",
  "vps",
  "balanced",
]);
const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const cacheKeyStrategies = new Set<RayConfig["cache"]["keyStrategy"]>(["input", "input+params"]);
const rateLimitKeyStrategies = new Set<RateLimitKeyStrategy>(["ip", "api-key", "ip+api-key"]);
const quantizations = new Set<Quantization>([
  "q4_0",
  "q4_k_m",
  "q5_k_m",
  "q8_0",
  "fp16",
  "unknown",
]);
const MAX_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_SCHEDULER_CONCURRENCY = 8;
const MAX_SCHEDULER_QUEUE_DEPTH = 512;
const MAX_SCHEDULER_QUEUED_TOKENS = 262_144;
const MAX_SCHEDULER_INFLIGHT_TOKENS = 65_536;
const MAX_SCHEDULER_BATCH_WINDOW_MS = 1_000;
const MAX_ASYNC_DISPATCH_CONCURRENCY = 8;
const MAX_ASYNC_QUEUE_JOBS = 2_000;
const MAX_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB = 1_048_576;
const MAX_CACHE_ENTRIES = 4_096;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_RATE_LIMIT_KEYS = 16_384;
const MAX_CONFIG_RECORD_ENTRIES = 64;
const MAX_CONFIG_RECORD_KEY_CHARS = 128;
const MAX_CONFIG_RECORD_VALUE_CHARS = 4_096;
const MAX_CONFIG_STRING_ARRAY_ENTRIES = 64;
const MAX_CONFIG_STRING_ARRAY_ENTRY_CHARS = 4_096;
const MAX_CONFIG_HOST_CHARS = 253;
const MAX_CONFIG_IDENTIFIER_CHARS = 256;
const MAX_CONFIG_PATH_CHARS = 4_096;
const MAX_CONFIG_URL_CHARS = 2_048;
const MAX_CONFIG_ENV_NAME_CHARS = 128;
const MAX_TELEMETRY_SERVICE_NAME_CHARS = 128;
const MAX_CALLBACK_ALLOWED_HOST_CHARS = 253;
const MAX_PROMPT_FAMILY_METADATA_KEYS = 16;
const MAX_PROMPT_FAMILY_METADATA_KEY_CHARS = 128;
const MAX_WARMUP_REQUESTS = 8;
const MAX_WARMUP_TEXT_CHARS = 8_192;
const MAX_WARMUP_STOP_SEQUENCES = 16;
const MAX_WARMUP_STOP_SEQUENCE_CHARS = 256;
const MAX_WARMUP_TEMPLATE_VARIABLES = 32;
const MAX_WARMUP_TEMPLATE_VARIABLE_KEY_CHARS = 128;
const MAX_WARMUP_TEMPLATE_VARIABLE_VALUE_CHARS = 16_384;
const MAX_MODEL_CONTEXT_WINDOW = 32_768;
const MAX_MODEL_OUTPUT_TOKENS = 2_048;
const MAX_MODEL_TOKENS_PER_SECOND_TARGET = 1_000;
const MAX_MODEL_MEMORY_CLASS_MIB = 65_536;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ADAPTER_TIMEOUT_MS = 120_000;
const MAX_ASYNC_COMPLETED_TTL_MS = 604_800_000;
const MAX_ASYNC_POLL_INTERVAL_MS = 60_000;
const MAX_CALLBACK_TIMEOUT_MS = 30_000;
const MAX_ASYNC_ATTEMPTS = 100;
const MAX_CACHE_TTL_MS = 86_400_000;
const MAX_GRACEFUL_DEGRADATION_PROMPT_CHARS = 65_536;
const MAX_GRACEFUL_DEGRADATION_MEMORY_RSS_MIB = 65_536;
const MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD = 100;
const MAX_ADAPTIVE_SAMPLE_SIZE = 512;
const MAX_ADAPTIVE_FAMILY_HISTORY_SIZE = 1_024;
const MAX_ADAPTIVE_LATENCY_THRESHOLD_MS = 120_000;
const MAX_RATE_LIMIT_WINDOW_MS = 3_600_000;
const MAX_RATE_LIMIT_REQUESTS = 10_000;
const MAX_MOCK_LATENCY_MS = 120_000;
const MAX_MOCK_SEED_CHARS = 512;
const MAX_LLAMA_CTX_SIZE = 32_768;
const MAX_LLAMA_PARALLEL = 8;
const MAX_LLAMA_THREADS = 32;
const MAX_LLAMA_HTTP_THREADS = 16;
const MAX_LLAMA_BATCH_SIZE = 4_096;
const MAX_LLAMA_CACHE_REUSE = 32_768;
const MAX_LLAMA_CACHE_RAM_MIB = 8_192;
const MAX_PROMPT_SCAFFOLD_CACHE_ENTRIES = 4_096;
const MAX_AUTH_API_KEY_ENV_CHARS = 64 * 1024;
const MAX_AUTH_API_KEYS = 128;
const MAX_AUTH_API_KEY_CHARS = 1_024;
const MIN_PROMPT_TOKEN_BUDGET = 1;
const DNS_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const unsafeConfigRecordKeys = new Set(["__proto__", "constructor", "prototype"]);
const reservedAdapterHeaderNames = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
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

async function readConfigFileBounded(configPath: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    fileHandle = await fs.open(configPath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new RayError(`Config path must be a file: ${configPath}`, {
        code: "config_validation_error",
        status: 500,
      });
    }

    if (stats.size > MAX_CONFIG_FILE_BYTES) {
      throw new RayError(`Config file must be at most ${MAX_CONFIG_FILE_BYTES} bytes`, {
        code: "config_validation_error",
        status: 500,
        details: {
          configPath,
          actualBytes: stats.size,
          maxBytes: MAX_CONFIG_FILE_BYTES,
        },
      });
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function assertConfigPathInput(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RayError(`${label} must be a non-empty path`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (/[\0\r\n]/.test(value)) {
    throw new RayError(`${label} must not contain control characters`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (value.trim() !== value) {
    throw new RayError(`${label} must be a path without surrounding whitespace`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  if (value.length > MAX_CONFIG_PATH_CHARS) {
    throw new RayError(`${label} must be at most ${MAX_CONFIG_PATH_CHARS} characters`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualChars: value.length,
        maxChars: MAX_CONFIG_PATH_CHARS,
      },
    });
  }
}

function parseProfile(value: unknown, label: string): RayProfile | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && rayProfiles.has(value as RayProfile)) {
    return value as RayProfile;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }

  throw new RayError(`Expected ${label} to be a supported Ray profile`, {
    code: "config_validation_error",
    status: 500,
    details: { value, supported: [...rayProfiles] },
  });
}

function parseBoolean(value: string | undefined, label: string): boolean | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new RayError(`Expected ${label} to be a boolean`, {
        code: "config_validation_error",
        status: 500,
        details: {
          value,
          supported: ["true", "false", "1", "0", "yes", "no", "on", "off"],
        },
      });
  }
}

function parseCommaSeparatedStrings(
  value: string | undefined,
  label: string,
  maxEntries = MAX_CONFIG_STRING_ARRAY_ENTRIES,
  maxEntryChars = MAX_CONFIG_STRING_ARRAY_ENTRY_CHARS,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const maxChars = maxEntries * maxEntryChars + Math.max(0, maxEntries - 1);
  if (value.length > maxChars) {
    throw new RayError(`Expected ${label} to be at most ${maxChars} characters`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualChars: value.length,
        maxChars,
      },
    });
  }

  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const entries: string[] = [];
  let start = 0;

  while (start <= value.length) {
    if (entries.length >= maxEntries) {
      throw new RayError(`Expected ${label} to contain at most ${maxEntries} values`, {
        code: "config_validation_error",
        status: 500,
        details: {
          maxEntries,
        },
      });
    }

    const separatorIndex = value.indexOf(",", start);
    const end = separatorIndex === -1 ? value.length : separatorIndex;
    const entry = value.slice(start, end).trim();

    if (entry.length === 0) {
      throw new RayError(`Expected ${label} to be comma-separated non-empty values`, {
        code: "config_validation_error",
        status: 500,
        details: { value },
      });
    }

    if (entry.length > maxEntryChars) {
      throw new RayError(`Expected ${label} entries to be at most ${maxEntryChars} characters`, {
        code: "config_validation_error",
        status: 500,
        details: {
          actualChars: entry.length,
          maxChars: maxEntryChars,
        },
      });
    }

    entries.push(entry);

    if (separatorIndex === -1) {
      break;
    }

    start = separatorIndex + 1;
  }

  return entries;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RayError(`Expected ${label} to be a positive integer`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  return parsed;
}

function parsePositiveUnitInterval(value: string | undefined, label: string): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new RayError(`Expected ${label} to be greater than 0 and less than or equal to 1`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  return parsed;
}

function parsePositiveNumberAtMost(
  value: string | undefined,
  label: string,
  maximum: number,
): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new RayError(
      `Expected ${label} to be greater than 0 and less than or equal to ${maximum}`,
      {
        code: "config_validation_error",
        status: 500,
        details: { value, maximum },
      },
    );
  }

  return parsed;
}

function parseUnitInterval(value: string | undefined, label: string): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const parsed = Number(value.trim());

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RayError(`Expected ${label} to be between 0 and 1`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  return parsed;
}

function parseTcpPort(value: string | undefined, label: string): number | undefined {
  const parsed = parsePositiveInteger(value, label);

  if (parsed !== undefined && parsed > 65_535) {
    throw new RayError(`Expected ${label} to be less than or equal to 65535`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  return parsed;
}

function parseLogLevel(value: unknown, label: string): LogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string" && logLevels.has(value as LogLevel)) {
    return value as LogLevel;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }

  throw new RayError(`Expected ${label} to be a supported log level`, {
    code: "config_validation_error",
    status: 500,
    details: { value, supported: [...logLevels] },
  });
}

function parseRateLimitKeyStrategy(
  value: string | undefined,
  label: string,
): RateLimitKeyStrategy | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  if (rateLimitKeyStrategies.has(normalized as RateLimitKeyStrategy)) {
    return normalized as RateLimitKeyStrategy;
  }

  throw new RayError(`Expected ${label} to be a supported rate-limit key strategy`, {
    code: "config_validation_error",
    status: 500,
    details: {
      value,
      supported: [...rateLimitKeyStrategies],
    },
  });
}

function parseCacheKeyStrategy(
  value: string | undefined,
  label: string,
): RayConfig["cache"]["keyStrategy"] | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  if (cacheKeyStrategies.has(normalized as RayConfig["cache"]["keyStrategy"])) {
    return normalized as RayConfig["cache"]["keyStrategy"];
  }

  throw new RayError(`Expected ${label} to be a supported cache key strategy`, {
    code: "config_validation_error",
    status: 500,
    details: {
      value,
      supported: [...cacheKeyStrategies],
    },
  });
}

function parseQuantization(value: string | undefined): Quantization | undefined {
  if (typeof value === "string" && quantizations.has(value as Quantization)) {
    return value as Quantization;
  }

  if (isNonEmptyString(value)) {
    throw new RayError("Expected RAY_MODEL_QUANTIZATION to be a supported quantization", {
      code: "config_validation_error",
      status: 500,
      details: { value, supported: [...quantizations] },
    });
  }

  return undefined;
}

function parseIntegerAtLeast(
  value: string | undefined,
  minimum: number,
  label: string,
): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!/^-?\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RayError(`Expected ${label} to be an integer greater than or equal to ${minimum}`, {
      code: "config_validation_error",
      status: 500,
      details: { value, minimum },
    });
  }

  return parsed;
}

function isLlamaCppLaunchPreset(value: string): value is LlamaCppLaunchProfile["preset"] {
  return llamaCppLaunchPresets.has(value as LlamaCppLaunchProfile["preset"]);
}

function firstNonEmptyEnvValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => isNonEmptyString(value));
}

function applyEnvOverrides(config: RayConfig, env: NodeJS.ProcessEnv): RayConfig {
  const next = structuredClone(config);
  const host = env.RAY_HOST;
  const port = parseTcpPort(env.RAY_PORT, "RAY_PORT");
  const requestBodyLimitBytes = parsePositiveInteger(
    env.RAY_REQUEST_BODY_LIMIT_BYTES,
    "RAY_REQUEST_BODY_LIMIT_BYTES",
  );
  const logLevel = parseLogLevel(env.RAY_LOG_LEVEL, "RAY_LOG_LEVEL");
  const telemetryServiceName = env.RAY_TELEMETRY_SERVICE_NAME;
  const telemetryIncludeDebugMetrics = parseBoolean(
    env.RAY_TELEMETRY_INCLUDE_DEBUG_METRICS,
    "RAY_TELEMETRY_INCLUDE_DEBUG_METRICS",
  );
  const telemetrySlowRequestThresholdMs = parsePositiveInteger(
    env.RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS,
    "RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS",
  );
  const modelId = env.RAY_MODEL_ID;
  const modelFamily = env.RAY_MODEL_FAMILY;
  const quantization = parseQuantization(env.RAY_MODEL_QUANTIZATION);
  const modelWarmOnBoot = parseBoolean(env.RAY_MODEL_WARM_ON_BOOT, "RAY_MODEL_WARM_ON_BOOT");
  const modelContextWindow = parsePositiveInteger(
    env.RAY_MODEL_CONTEXT_WINDOW,
    "RAY_MODEL_CONTEXT_WINDOW",
  );
  const modelMaxOutputTokens = parsePositiveInteger(
    env.RAY_MODEL_MAX_OUTPUT_TOKENS,
    "RAY_MODEL_MAX_OUTPUT_TOKENS",
  );
  const modelTokensPerSecondTarget = parsePositiveInteger(
    env.RAY_MODEL_TOKENS_PER_SECOND_TARGET,
    "RAY_MODEL_TOKENS_PER_SECOND_TARGET",
  );
  const modelMemoryClassMiB = parsePositiveInteger(
    env.RAY_MODEL_MEMORY_CLASS_MIB,
    "RAY_MODEL_MEMORY_CLASS_MIB",
  );
  const modelPreferredCtxSize = parsePositiveInteger(
    env.RAY_MODEL_PREFERRED_CTX_SIZE,
    "RAY_MODEL_PREFERRED_CTX_SIZE",
  );
  const schedulerConcurrency = parsePositiveInteger(
    env.RAY_SCHEDULER_CONCURRENCY,
    "RAY_SCHEDULER_CONCURRENCY",
  );
  const schedulerMaxQueue = parsePositiveInteger(
    env.RAY_SCHEDULER_MAX_QUEUE,
    "RAY_SCHEDULER_MAX_QUEUE",
  );
  const schedulerMaxQueuedTokens = parsePositiveInteger(
    env.RAY_SCHEDULER_MAX_QUEUED_TOKENS,
    "RAY_SCHEDULER_MAX_QUEUED_TOKENS",
  );
  const schedulerMaxInflightTokens = parsePositiveInteger(
    env.RAY_SCHEDULER_MAX_INFLIGHT_TOKENS,
    "RAY_SCHEDULER_MAX_INFLIGHT_TOKENS",
  );
  const schedulerRequestTimeoutMs = parsePositiveInteger(
    env.RAY_SCHEDULER_REQUEST_TIMEOUT_MS,
    "RAY_SCHEDULER_REQUEST_TIMEOUT_MS",
  );
  const schedulerDedupeInflight = parseBoolean(
    env.RAY_SCHEDULER_DEDUPE_INFLIGHT,
    "RAY_SCHEDULER_DEDUPE_INFLIGHT",
  );
  const schedulerBatchWindowMs = parseIntegerAtLeast(
    env.RAY_SCHEDULER_BATCH_WINDOW_MS,
    0,
    "RAY_SCHEDULER_BATCH_WINDOW_MS",
  );
  const schedulerAffinityLookahead = parsePositiveInteger(
    env.RAY_SCHEDULER_AFFINITY_LOOKAHEAD,
    "RAY_SCHEDULER_AFFINITY_LOOKAHEAD",
  );
  const schedulerShortJobMaxTokens = parsePositiveInteger(
    env.RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS,
    "RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS",
  );
  const asyncQueueStorageDir = env.RAY_ASYNC_QUEUE_STORAGE_DIR;
  const asyncQueueMaxJobs = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_MAX_JOBS,
    "RAY_ASYNC_QUEUE_MAX_JOBS",
  );
  const asyncQueueMinFreeStorageMiB = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB,
    "RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB",
  );
  const asyncQueueCompletedTtlMs = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_COMPLETED_TTL_MS,
    "RAY_ASYNC_QUEUE_COMPLETED_TTL_MS",
  );
  const asyncQueueEnabled = parseBoolean(env.RAY_ASYNC_QUEUE_ENABLED, "RAY_ASYNC_QUEUE_ENABLED");
  const asyncQueuePollIntervalMs = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_POLL_INTERVAL_MS,
    "RAY_ASYNC_QUEUE_POLL_INTERVAL_MS",
  );
  const asyncQueueDispatchConcurrency = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY,
    "RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY",
  );
  const asyncQueueMaxAttempts = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_MAX_ATTEMPTS,
    "RAY_ASYNC_QUEUE_MAX_ATTEMPTS",
  );
  const asyncQueueCallbackTimeoutMs = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS,
    "RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS",
  );
  const asyncQueueMaxCallbackAttempts = parsePositiveInteger(
    env.RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS,
    "RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS",
  );
  const asyncQueueCallbackAllowPrivateNetwork = parseBoolean(
    env.RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK,
    "RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK",
  );
  const asyncQueueCallbackAllowedHosts = parseCommaSeparatedStrings(
    env.RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS,
    "RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS",
    MAX_CONFIG_STRING_ARRAY_ENTRIES,
    MAX_CALLBACK_ALLOWED_HOST_CHARS,
  );
  const cacheEnabled = parseBoolean(env.RAY_CACHE_ENABLED, "RAY_CACHE_ENABLED");
  const cacheMaxEntries = parsePositiveInteger(env.RAY_CACHE_MAX_ENTRIES, "RAY_CACHE_MAX_ENTRIES");
  const cacheMaxBytes = parsePositiveInteger(env.RAY_CACHE_MAX_BYTES, "RAY_CACHE_MAX_BYTES");
  const cacheTtlMs = parsePositiveInteger(env.RAY_CACHE_TTL_MS, "RAY_CACHE_TTL_MS");
  const cacheKeyStrategy = parseCacheKeyStrategy(
    env.RAY_CACHE_KEY_STRATEGY,
    "RAY_CACHE_KEY_STRATEGY",
  );
  const degradationEnabled = parseBoolean(
    env.RAY_GRACEFUL_DEGRADATION_ENABLED,
    "RAY_GRACEFUL_DEGRADATION_ENABLED",
  );
  const degradationQueueDepthThreshold = parsePositiveInteger(
    env.RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD,
    "RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD",
  );
  const degradationMaxPromptChars = parsePositiveInteger(
    env.RAY_DEGRADATION_MAX_PROMPT_CHARS,
    "RAY_DEGRADATION_MAX_PROMPT_CHARS",
  );
  const degradationMaxTokens = parsePositiveInteger(
    env.RAY_DEGRADATION_MAX_TOKENS,
    "RAY_DEGRADATION_MAX_TOKENS",
  );
  const degradationMemoryRssThresholdMiB = parsePositiveInteger(
    env.RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB,
    "RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB",
  );
  const degradationMemoryCgroupPressureRatioThreshold = parsePositiveUnitInterval(
    env.RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD,
    "RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD",
  );
  const degradationCpuThrottledRatioThreshold = parsePositiveUnitInterval(
    env.RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD,
    "RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD",
  );
  const degradationMemoryPsiSomeAvg10Threshold = parsePositiveNumberAtMost(
    env.RAY_DEGRADATION_MEMORY_PSI_SOME_AVG10_THRESHOLD,
    "RAY_DEGRADATION_MEMORY_PSI_SOME_AVG10_THRESHOLD",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  const degradationMemoryPsiFullAvg10Threshold = parsePositiveNumberAtMost(
    env.RAY_DEGRADATION_MEMORY_PSI_FULL_AVG10_THRESHOLD,
    "RAY_DEGRADATION_MEMORY_PSI_FULL_AVG10_THRESHOLD",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  const degradationCpuPsiSomeAvg10Threshold = parsePositiveNumberAtMost(
    env.RAY_DEGRADATION_CPU_PSI_SOME_AVG10_THRESHOLD,
    "RAY_DEGRADATION_CPU_PSI_SOME_AVG10_THRESHOLD",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  const degradationCpuPsiFullAvg10Threshold = parsePositiveNumberAtMost(
    env.RAY_DEGRADATION_CPU_PSI_FULL_AVG10_THRESHOLD,
    "RAY_DEGRADATION_CPU_PSI_FULL_AVG10_THRESHOLD",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  const promptCompilerEnabled = parseBoolean(
    env.RAY_PROMPT_COMPILER_ENABLED,
    "RAY_PROMPT_COMPILER_ENABLED",
  );
  const promptCompilerCollapseWhitespace = parseBoolean(
    env.RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE,
    "RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE",
  );
  const promptCompilerDedupeRepeatedLines = parseBoolean(
    env.RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES,
    "RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES",
  );
  const promptCompilerFamilyMetadataKeys = parseCommaSeparatedStrings(
    env.RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS,
    "RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS",
    MAX_PROMPT_FAMILY_METADATA_KEYS,
    MAX_PROMPT_FAMILY_METADATA_KEY_CHARS,
  );
  const adaptiveTuningEnabled = parseBoolean(
    env.RAY_ADAPTIVE_TUNING_ENABLED,
    "RAY_ADAPTIVE_TUNING_ENABLED",
  );
  const adaptiveSampleSize = parsePositiveInteger(
    env.RAY_ADAPTIVE_SAMPLE_SIZE,
    "RAY_ADAPTIVE_SAMPLE_SIZE",
  );
  const adaptiveQueueLatencyThresholdMs = parsePositiveInteger(
    env.RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS,
    "RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS",
  );
  const adaptiveMinCompletionTokensPerSecond = parsePositiveInteger(
    env.RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND,
    "RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND",
  );
  const adaptiveMaxOutputReductionRatio = parseUnitInterval(
    env.RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO,
    "RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO",
  );
  const adaptiveMinOutputTokens = parsePositiveInteger(
    env.RAY_ADAPTIVE_MIN_OUTPUT_TOKENS,
    "RAY_ADAPTIVE_MIN_OUTPUT_TOKENS",
  );
  const adaptiveLearnedFamilyCapEnabled = parseBoolean(
    env.RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED,
    "RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED",
  );
  const adaptiveFamilyHistorySize = parsePositiveInteger(
    env.RAY_ADAPTIVE_FAMILY_HISTORY_SIZE,
    "RAY_ADAPTIVE_FAMILY_HISTORY_SIZE",
  );
  const adaptiveLearnedCapMinSamples = parsePositiveInteger(
    env.RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES,
    "RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES",
  );
  const adaptiveDraftPercentile = parseUnitInterval(
    env.RAY_ADAPTIVE_DRAFT_PERCENTILE,
    "RAY_ADAPTIVE_DRAFT_PERCENTILE",
  );
  const adaptiveShortPercentile = parseUnitInterval(
    env.RAY_ADAPTIVE_SHORT_PERCENTILE,
    "RAY_ADAPTIVE_SHORT_PERCENTILE",
  );
  const adaptiveLearnedCapHeadroomTokens = parsePositiveInteger(
    env.RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS,
    "RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS",
  );
  const authEnabled = parseBoolean(env.RAY_AUTH_ENABLED, "RAY_AUTH_ENABLED");
  const authApiKeyEnv = env.RAY_AUTH_API_KEY_ENV;
  const rateLimitEnabled = parseBoolean(env.RAY_RATE_LIMIT_ENABLED, "RAY_RATE_LIMIT_ENABLED");
  const rateLimitWindowMs = parsePositiveInteger(
    env.RAY_RATE_LIMIT_WINDOW_MS,
    "RAY_RATE_LIMIT_WINDOW_MS",
  );
  const rateLimitMaxRequests = parsePositiveInteger(
    env.RAY_RATE_LIMIT_MAX_REQUESTS,
    "RAY_RATE_LIMIT_MAX_REQUESTS",
  );
  const rateLimitMaxKeys = parsePositiveInteger(
    env.RAY_RATE_LIMIT_MAX_KEYS,
    "RAY_RATE_LIMIT_MAX_KEYS",
  );
  const rateLimitKeyStrategy = parseRateLimitKeyStrategy(
    env.RAY_RATE_LIMIT_KEY_STRATEGY,
    "RAY_RATE_LIMIT_KEY_STRATEGY",
  );
  const rateLimitTrustProxyHeaders = parseBoolean(
    env.RAY_RATE_LIMIT_TRUST_PROXY_HEADERS,
    "RAY_RATE_LIMIT_TRUST_PROXY_HEADERS",
  );

  if (isNonEmptyString(host)) {
    next.server.host = host;
  }

  if (port !== undefined) {
    next.server.port = port;
  }

  if (requestBodyLimitBytes !== undefined) {
    next.server.requestBodyLimitBytes = requestBodyLimitBytes;
  }

  if (logLevel !== undefined) {
    next.telemetry.logLevel = logLevel;
  }

  if (isNonEmptyString(telemetryServiceName)) {
    next.telemetry.serviceName = telemetryServiceName;
  }

  if (telemetryIncludeDebugMetrics !== undefined) {
    next.telemetry.includeDebugMetrics = telemetryIncludeDebugMetrics;
  }

  if (telemetrySlowRequestThresholdMs !== undefined) {
    next.telemetry.slowRequestThresholdMs = telemetrySlowRequestThresholdMs;
  }

  if (isNonEmptyString(modelId)) {
    next.model.id = modelId;
  }

  if (isNonEmptyString(modelFamily)) {
    next.model.family = modelFamily;
  }

  if (quantization !== undefined) {
    next.model.quantization = quantization;
  }

  if (modelWarmOnBoot !== undefined) {
    next.model.warmOnBoot = modelWarmOnBoot;
  }

  if (modelContextWindow !== undefined) {
    next.model.contextWindow = modelContextWindow;
  }

  if (modelMaxOutputTokens !== undefined) {
    next.model.maxOutputTokens = modelMaxOutputTokens;
  }

  if (next.model.operational) {
    if (modelTokensPerSecondTarget !== undefined) {
      next.model.operational.tokensPerSecondTarget = modelTokensPerSecondTarget;
    }

    if (modelMemoryClassMiB !== undefined) {
      next.model.operational.memoryClassMiB = modelMemoryClassMiB;
    }

    if (modelPreferredCtxSize !== undefined) {
      next.model.operational.preferredCtxSize = modelPreferredCtxSize;
    }
  }

  if (next.model.adapter.kind === "openai-compatible" || next.model.adapter.kind === "llama.cpp") {
    const adapterBaseUrl =
      next.model.adapter.kind === "llama.cpp"
        ? firstNonEmptyEnvValue(env.RAY_MODEL_BASE_URL, env.RAY_LLAMA_CPP_BASE_URL)
        : env.RAY_MODEL_BASE_URL;
    const adapterModelRef =
      next.model.adapter.kind === "llama.cpp"
        ? firstNonEmptyEnvValue(env.RAY_MODEL_REF, env.RAY_LLAMA_CPP_MODEL_REF)
        : env.RAY_MODEL_REF;
    const adapterApiKeyEnv = env.RAY_MODEL_API_KEY_ENV;
    const adapterTimeoutMs = parsePositiveInteger(env.RAY_MODEL_TIMEOUT_MS, "RAY_MODEL_TIMEOUT_MS");

    if (isNonEmptyString(adapterBaseUrl)) {
      next.model.adapter.baseUrl = adapterBaseUrl;
    }

    if (isNonEmptyString(adapterModelRef)) {
      next.model.adapter.modelRef = adapterModelRef;
    } else if (isNonEmptyString(modelId)) {
      next.model.adapter.modelRef = modelId;
    }

    if (adapterTimeoutMs !== undefined) {
      next.model.adapter.timeoutMs = adapterTimeoutMs;
    }

    if (isNonEmptyString(adapterApiKeyEnv)) {
      next.model.adapter.apiKeyEnv = adapterApiKeyEnv;
    }
  }

  if (next.model.adapter.kind === "llama.cpp") {
    const cachePrompt = parseBoolean(env.RAY_LLAMA_CPP_CACHE_PROMPT, "RAY_LLAMA_CPP_CACHE_PROMPT");
    const slotId = parseIntegerAtLeast(env.RAY_LLAMA_CPP_SLOT_ID, 0, "RAY_LLAMA_CPP_SLOT_ID");
    const slotStateTtlMs = parsePositiveInteger(
      env.RAY_LLAMA_CPP_SLOT_STATE_TTL_MS,
      "RAY_LLAMA_CPP_SLOT_STATE_TTL_MS",
    );
    const slotSnapshotTimeoutMs = parsePositiveInteger(
      env.RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS,
      "RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS",
    );
    const promptScaffoldCacheEntries = parsePositiveInteger(
      env.RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES,
      "RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES",
    );

    if (cachePrompt !== undefined) {
      next.model.adapter.cachePrompt = cachePrompt;
    }

    if (slotId !== undefined) {
      next.model.adapter.slotId = slotId;
    }

    if (slotStateTtlMs !== undefined) {
      next.model.adapter.slotStateTtlMs = slotStateTtlMs;
    }

    if (slotSnapshotTimeoutMs !== undefined) {
      next.model.adapter.slotSnapshotTimeoutMs = slotSnapshotTimeoutMs;
    }

    if (promptScaffoldCacheEntries !== undefined) {
      next.model.adapter.promptScaffoldCacheEntries = promptScaffoldCacheEntries;
    }
  }

  if (next.model.adapter.kind === "llama.cpp" && next.model.adapter.launchProfile) {
    const profile = next.model.adapter.launchProfile;
    const binaryPath = env.RAY_LLAMA_CPP_BINARY_PATH;
    const modelPath = firstNonEmptyEnvValue(env.RAY_MODEL_PATH, env.RAY_LLAMA_CPP_MODEL_PATH);
    const alias = env.RAY_LLAMA_CPP_ALIAS;
    const llamaHost = env.RAY_LLAMA_CPP_HOST;
    const llamaPort = parseTcpPort(env.RAY_LLAMA_CPP_PORT, "RAY_LLAMA_CPP_PORT");
    const ctxSize = parsePositiveInteger(env.RAY_LLAMA_CPP_CTX_SIZE, "RAY_LLAMA_CPP_CTX_SIZE");
    const parallel = parsePositiveInteger(env.RAY_LLAMA_CPP_PARALLEL, "RAY_LLAMA_CPP_PARALLEL");
    const threads = parsePositiveInteger(env.RAY_LLAMA_CPP_THREADS, "RAY_LLAMA_CPP_THREADS");
    const threadsBatch = parsePositiveInteger(
      env.RAY_LLAMA_CPP_THREADS_BATCH,
      "RAY_LLAMA_CPP_THREADS_BATCH",
    );
    const threadsHttp = parsePositiveInteger(
      env.RAY_LLAMA_CPP_THREADS_HTTP,
      "RAY_LLAMA_CPP_THREADS_HTTP",
    );
    const batchSize = parsePositiveInteger(
      env.RAY_LLAMA_CPP_BATCH_SIZE,
      "RAY_LLAMA_CPP_BATCH_SIZE",
    );
    const ubatchSize = parsePositiveInteger(
      env.RAY_LLAMA_CPP_UBATCH_SIZE,
      "RAY_LLAMA_CPP_UBATCH_SIZE",
    );
    const cacheReuse = parseIntegerAtLeast(
      env.RAY_LLAMA_CPP_CACHE_REUSE,
      0,
      "RAY_LLAMA_CPP_CACHE_REUSE",
    );
    const cacheRamMiB = parseIntegerAtLeast(
      env.RAY_LLAMA_CPP_CACHE_RAM_MIB,
      -1,
      "RAY_LLAMA_CPP_CACHE_RAM_MIB",
    );
    const cachePrompt = parseBoolean(env.RAY_LLAMA_CPP_CACHE_PROMPT, "RAY_LLAMA_CPP_CACHE_PROMPT");
    const continuousBatching = parseBoolean(
      env.RAY_LLAMA_CPP_CONTINUOUS_BATCHING,
      "RAY_LLAMA_CPP_CONTINUOUS_BATCHING",
    );
    const enableMetrics = parseBoolean(
      env.RAY_LLAMA_CPP_ENABLE_METRICS,
      "RAY_LLAMA_CPP_ENABLE_METRICS",
    );
    const exposeSlots = parseBoolean(env.RAY_LLAMA_CPP_EXPOSE_SLOTS, "RAY_LLAMA_CPP_EXPOSE_SLOTS");
    const warmup = parseBoolean(env.RAY_LLAMA_CPP_WARMUP, "RAY_LLAMA_CPP_WARMUP");
    const enableUnifiedKv = parseBoolean(
      env.RAY_LLAMA_CPP_ENABLE_UNIFIED_KV,
      "RAY_LLAMA_CPP_ENABLE_UNIFIED_KV",
    );
    const cacheIdleSlots = parseBoolean(
      env.RAY_LLAMA_CPP_CACHE_IDLE_SLOTS,
      "RAY_LLAMA_CPP_CACHE_IDLE_SLOTS",
    );
    const contextShift = parseBoolean(
      env.RAY_LLAMA_CPP_CONTEXT_SHIFT,
      "RAY_LLAMA_CPP_CONTEXT_SHIFT",
    );

    if (isNonEmptyString(binaryPath)) {
      profile.binaryPath = binaryPath;
    }

    if (isNonEmptyString(modelPath)) {
      profile.modelPath = modelPath;
    }

    if (isNonEmptyString(alias)) {
      profile.alias = alias;
    } else if (isNonEmptyString(modelId)) {
      profile.alias = modelId;
    }

    if (isNonEmptyString(llamaHost)) {
      profile.host = llamaHost;
    }

    if (llamaPort !== undefined) {
      profile.port = llamaPort;
    }

    if (ctxSize !== undefined) {
      profile.ctxSize = ctxSize;
      if (next.model.operational && modelPreferredCtxSize === undefined) {
        next.model.operational.preferredCtxSize = ctxSize;
      }
    }

    if (parallel !== undefined) {
      profile.parallel = parallel;
    }

    if (threads !== undefined) {
      profile.threads = threads;
    }

    if (threadsBatch !== undefined) {
      profile.threadsBatch = threadsBatch;
    }

    if (threadsHttp !== undefined) {
      profile.threadsHttp = threadsHttp;
    }

    if (batchSize !== undefined) {
      profile.batchSize = batchSize;
    }

    if (ubatchSize !== undefined) {
      profile.ubatchSize = ubatchSize;
    }

    if (cacheReuse !== undefined) {
      profile.cacheReuse = cacheReuse;
    }

    if (cacheRamMiB !== undefined) {
      profile.cacheRamMiB = cacheRamMiB;
    }

    if (cachePrompt !== undefined) {
      profile.cachePrompt = cachePrompt;
    }

    if (continuousBatching !== undefined) {
      profile.continuousBatching = continuousBatching;
    }

    if (enableMetrics !== undefined) {
      profile.enableMetrics = enableMetrics;
    }

    if (exposeSlots !== undefined) {
      profile.exposeSlots = exposeSlots;
    }

    if (warmup !== undefined) {
      profile.warmup = warmup;
    }

    if (enableUnifiedKv !== undefined) {
      profile.enableUnifiedKv = enableUnifiedKv;
    }

    if (cacheIdleSlots !== undefined) {
      profile.cacheIdleSlots = cacheIdleSlots;
    }

    if (contextShift !== undefined) {
      profile.contextShift = contextShift;
    }

    if (
      !isNonEmptyString(env.RAY_MODEL_BASE_URL) &&
      !isNonEmptyString(env.RAY_LLAMA_CPP_BASE_URL) &&
      (isNonEmptyString(llamaHost) || llamaPort !== undefined)
    ) {
      next.model.adapter.baseUrl = `http://${formatHostForHttpBaseUrl(profile.host)}:${profile.port}`;
    }
  }

  if (schedulerConcurrency !== undefined) {
    next.scheduler.concurrency = schedulerConcurrency;
  }

  if (schedulerMaxQueue !== undefined) {
    next.scheduler.maxQueue = schedulerMaxQueue;
  }

  if (schedulerMaxQueuedTokens !== undefined) {
    next.scheduler.maxQueuedTokens = schedulerMaxQueuedTokens;
  }

  if (schedulerMaxInflightTokens !== undefined) {
    next.scheduler.maxInflightTokens = schedulerMaxInflightTokens;
  }

  if (schedulerRequestTimeoutMs !== undefined) {
    next.scheduler.requestTimeoutMs = schedulerRequestTimeoutMs;
  }

  if (schedulerDedupeInflight !== undefined) {
    next.scheduler.dedupeInflight = schedulerDedupeInflight;
  }

  if (schedulerBatchWindowMs !== undefined) {
    next.scheduler.batchWindowMs = schedulerBatchWindowMs;
  }

  if (schedulerAffinityLookahead !== undefined) {
    next.scheduler.affinityLookahead = schedulerAffinityLookahead;
  }

  if (schedulerShortJobMaxTokens !== undefined) {
    next.scheduler.shortJobMaxTokens = schedulerShortJobMaxTokens;
  }

  if (isNonEmptyString(asyncQueueStorageDir)) {
    next.asyncQueue.storageDir = asyncQueueStorageDir;
  }

  if (asyncQueueMaxJobs !== undefined) {
    next.asyncQueue.maxJobs = asyncQueueMaxJobs;
  }

  if (asyncQueueMinFreeStorageMiB !== undefined) {
    next.asyncQueue.minFreeStorageMiB = asyncQueueMinFreeStorageMiB;
  }

  if (asyncQueueCompletedTtlMs !== undefined) {
    next.asyncQueue.completedTtlMs = asyncQueueCompletedTtlMs;
  }

  if (asyncQueueEnabled !== undefined) {
    next.asyncQueue.enabled = asyncQueueEnabled;
  }

  if (asyncQueuePollIntervalMs !== undefined) {
    next.asyncQueue.pollIntervalMs = asyncQueuePollIntervalMs;
  }

  if (asyncQueueDispatchConcurrency !== undefined) {
    next.asyncQueue.dispatchConcurrency = asyncQueueDispatchConcurrency;
  }

  if (asyncQueueMaxAttempts !== undefined) {
    next.asyncQueue.maxAttempts = asyncQueueMaxAttempts;
  }

  if (asyncQueueCallbackTimeoutMs !== undefined) {
    next.asyncQueue.callbackTimeoutMs = asyncQueueCallbackTimeoutMs;
  }

  if (asyncQueueMaxCallbackAttempts !== undefined) {
    next.asyncQueue.maxCallbackAttempts = asyncQueueMaxCallbackAttempts;
  }

  if (asyncQueueCallbackAllowPrivateNetwork !== undefined) {
    next.asyncQueue.callbackAllowPrivateNetwork = asyncQueueCallbackAllowPrivateNetwork;
  }

  if (asyncQueueCallbackAllowedHosts !== undefined) {
    next.asyncQueue.callbackAllowedHosts = asyncQueueCallbackAllowedHosts;
  }

  if (cacheEnabled !== undefined) {
    next.cache.enabled = cacheEnabled;
  }

  if (cacheMaxEntries !== undefined) {
    next.cache.maxEntries = cacheMaxEntries;
  }

  if (cacheMaxBytes !== undefined) {
    next.cache.maxBytes = cacheMaxBytes;
  }

  if (cacheTtlMs !== undefined) {
    next.cache.ttlMs = cacheTtlMs;
  }

  if (cacheKeyStrategy !== undefined) {
    next.cache.keyStrategy = cacheKeyStrategy;
  }

  if (degradationEnabled !== undefined) {
    next.gracefulDegradation.enabled = degradationEnabled;
  }

  if (degradationQueueDepthThreshold !== undefined) {
    next.gracefulDegradation.queueDepthThreshold = degradationQueueDepthThreshold;
  }

  if (degradationMaxPromptChars !== undefined) {
    next.gracefulDegradation.maxPromptChars = degradationMaxPromptChars;
  }

  if (degradationMaxTokens !== undefined) {
    next.gracefulDegradation.degradeToMaxTokens = degradationMaxTokens;
  }

  if (degradationMemoryRssThresholdMiB !== undefined) {
    next.gracefulDegradation.memoryRssThresholdMiB = degradationMemoryRssThresholdMiB;
  }

  if (degradationMemoryCgroupPressureRatioThreshold !== undefined) {
    next.gracefulDegradation.memoryCgroupPressureRatioThreshold =
      degradationMemoryCgroupPressureRatioThreshold;
  }

  if (degradationCpuThrottledRatioThreshold !== undefined) {
    next.gracefulDegradation.cpuThrottledRatioThreshold = degradationCpuThrottledRatioThreshold;
  }

  if (degradationMemoryPsiSomeAvg10Threshold !== undefined) {
    next.gracefulDegradation.memoryPsiSomeAvg10Threshold = degradationMemoryPsiSomeAvg10Threshold;
  }

  if (degradationMemoryPsiFullAvg10Threshold !== undefined) {
    next.gracefulDegradation.memoryPsiFullAvg10Threshold = degradationMemoryPsiFullAvg10Threshold;
  }

  if (degradationCpuPsiSomeAvg10Threshold !== undefined) {
    next.gracefulDegradation.cpuPsiSomeAvg10Threshold = degradationCpuPsiSomeAvg10Threshold;
  }

  if (degradationCpuPsiFullAvg10Threshold !== undefined) {
    next.gracefulDegradation.cpuPsiFullAvg10Threshold = degradationCpuPsiFullAvg10Threshold;
  }

  if (promptCompilerEnabled !== undefined) {
    next.promptCompiler.enabled = promptCompilerEnabled;
  }

  if (promptCompilerCollapseWhitespace !== undefined) {
    next.promptCompiler.collapseWhitespace = promptCompilerCollapseWhitespace;
  }

  if (promptCompilerDedupeRepeatedLines !== undefined) {
    next.promptCompiler.dedupeRepeatedLines = promptCompilerDedupeRepeatedLines;
  }

  if (promptCompilerFamilyMetadataKeys !== undefined) {
    next.promptCompiler.familyMetadataKeys = promptCompilerFamilyMetadataKeys;
  }

  if (adaptiveTuningEnabled !== undefined) {
    next.adaptiveTuning.enabled = adaptiveTuningEnabled;
  }

  if (adaptiveSampleSize !== undefined) {
    next.adaptiveTuning.sampleSize = adaptiveSampleSize;
  }

  if (adaptiveQueueLatencyThresholdMs !== undefined) {
    next.adaptiveTuning.queueLatencyThresholdMs = adaptiveQueueLatencyThresholdMs;
  }

  if (adaptiveMinCompletionTokensPerSecond !== undefined) {
    next.adaptiveTuning.minCompletionTokensPerSecond = adaptiveMinCompletionTokensPerSecond;
  }

  if (adaptiveMaxOutputReductionRatio !== undefined) {
    next.adaptiveTuning.maxOutputReductionRatio = adaptiveMaxOutputReductionRatio;
  }

  if (adaptiveMinOutputTokens !== undefined) {
    next.adaptiveTuning.minOutputTokens = adaptiveMinOutputTokens;
  }

  if (adaptiveLearnedFamilyCapEnabled !== undefined) {
    next.adaptiveTuning.learnedFamilyCapEnabled = adaptiveLearnedFamilyCapEnabled;
  }

  if (adaptiveFamilyHistorySize !== undefined) {
    next.adaptiveTuning.familyHistorySize = adaptiveFamilyHistorySize;
  }

  if (adaptiveLearnedCapMinSamples !== undefined) {
    next.adaptiveTuning.learnedCapMinSamples = adaptiveLearnedCapMinSamples;
  }

  if (adaptiveDraftPercentile !== undefined) {
    next.adaptiveTuning.draftPercentile = adaptiveDraftPercentile;
  }

  if (adaptiveShortPercentile !== undefined) {
    next.adaptiveTuning.shortPercentile = adaptiveShortPercentile;
  }

  if (adaptiveLearnedCapHeadroomTokens !== undefined) {
    next.adaptiveTuning.learnedCapHeadroomTokens = adaptiveLearnedCapHeadroomTokens;
  }

  if (authEnabled !== undefined) {
    next.auth.enabled = authEnabled;
  }

  if (isNonEmptyString(authApiKeyEnv)) {
    next.auth.apiKeyEnv = authApiKeyEnv;
  }

  if (rateLimitEnabled !== undefined) {
    next.rateLimit.enabled = rateLimitEnabled;
  }

  if (rateLimitWindowMs !== undefined) {
    next.rateLimit.windowMs = rateLimitWindowMs;
  }

  if (rateLimitMaxRequests !== undefined) {
    next.rateLimit.maxRequests = rateLimitMaxRequests;
  }

  if (rateLimitMaxKeys !== undefined) {
    next.rateLimit.maxKeys = rateLimitMaxKeys;
  }

  if (rateLimitKeyStrategy !== undefined) {
    next.rateLimit.keyStrategy = rateLimitKeyStrategy;
  }

  if (rateLimitTrustProxyHeaders !== undefined) {
    next.rateLimit.trustProxyHeaders = rateLimitTrustProxyHeaders;
  }

  return next;
}

function resolveConfigPaths(config: RayConfig, cwd: string): RayConfig {
  const next = structuredClone(config);
  assertConfigPathInput(next.asyncQueue.storageDir, "asyncQueue.storageDir");
  next.asyncQueue.storageDir = path.resolve(cwd, next.asyncQueue.storageDir);

  if (next.model.adapter.kind === "llama.cpp" && next.model.adapter.launchProfile) {
    const profile = next.model.adapter.launchProfile;
    assertConfigPathInput(profile.modelPath, "model.adapter.launchProfile.modelPath");
    assertConfigPathInput(profile.binaryPath, "model.adapter.launchProfile.binaryPath");

    if (!path.isAbsolute(profile.modelPath)) {
      profile.modelPath = path.resolve(cwd, profile.modelPath);
    }

    if (!path.isAbsolute(profile.binaryPath) && profile.binaryPath.includes("/")) {
      profile.binaryPath = path.resolve(cwd, profile.binaryPath);
    }
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

function assertTcpPort(value: number, label: string): void {
  assertPositiveInteger(value, label);

  if (value > 65_535) {
    throw new RayError(`${label} must be less than or equal to 65535`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertAbsolutePath(value: string, label: string): void {
  if (path.isAbsolute(value)) {
    return;
  }

  throw new RayError(`${label} must be an absolute path`, {
    code: "config_validation_error",
    status: 500,
    details: { value },
  });
}

function assertHttpBaseUrl(value: string, label: string): URL {
  if (/[\0-\x20\x7f]/.test(value)) {
    throw new RayError(`${label} must not contain unencoded whitespace or control characters`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new RayError(`${label} must be an absolute HTTP or HTTPS URL`, {
      code: "config_validation_error",
      status: 500,
      details: { value, error },
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RayError(`${label} must use the http or https scheme`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  if (parsed.username || parsed.password) {
    throw new RayError(`${label} must not include credentials; use headers or apiKeyEnv instead`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  if (parsed.search || parsed.hash) {
    throw new RayError(`${label} must not include a query string or fragment`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }

  return parsed;
}

function getUrlPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function normalizeHostLiteral(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return ipv4FromMappedIpv6(unbracketed) ?? unbracketed;
}

function ipv4FromMappedIpv6(value: string): string | undefined {
  const dottedMapped = value.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMapped && isIP(dottedMapped[1] ?? "") === 4) {
    return dottedMapped[1];
  }

  const mapped = value.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);

  if (!mapped) {
    return undefined;
  }

  const high = Number.parseInt(mapped[1] ?? "", 16);
  const low = Number.parseInt(mapped[2] ?? "", 16);

  if (!Number.isInteger(high) || !Number.isInteger(low)) {
    return undefined;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function formatHostForHttpBaseUrl(value: string): string {
  const host = normalizeHostLiteral(value);
  return isIP(host) === 6 ? `[${host}]` : host;
}

function isLoopbackHost(value: string): boolean {
  const host = normalizeHostLiteral(value);

  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (isIP(host) === 4) {
    const firstOctet = Number(host.split(".")[0]);
    return firstOctet === 127;
  }

  return false;
}

function isWildcardBindHost(value: string): boolean {
  const host = normalizeHostLiteral(value);
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
}

function localBindHostsOverlap(left: string, right: string): boolean {
  const leftHost = normalizeHostLiteral(left);
  const rightHost = normalizeHostLiteral(right);

  if (isWildcardBindHost(leftHost) || isWildcardBindHost(rightHost)) {
    return true;
  }

  if (leftHost === rightHost) {
    return true;
  }

  return (
    (leftHost === "localhost" || rightHost === "localhost") &&
    isLoopbackHost(leftHost) &&
    isLoopbackHost(rightHost)
  );
}

function assertAdapterDoesNotTargetGateway(
  config: RayConfig,
  adapterBaseUrl: URL,
  label: string,
): void {
  if (getUrlPort(adapterBaseUrl) !== config.server.port) {
    return;
  }

  const gatewayHost = normalizeHostLiteral(config.server.host);
  const adapterHost = normalizeHostLiteral(adapterBaseUrl.hostname);
  if (
    (!isLoopbackHost(adapterHost) && adapterHost !== gatewayHost) ||
    !localBindHostsOverlap(gatewayHost, adapterHost)
  ) {
    return;
  }

  throw new RayError(
    `${label} must not point at server.host/server.port because that would recursively call the Ray gateway instead of the model backend`,
    {
      code: "config_validation_error",
      status: 500,
      details: {
        baseUrl: adapterBaseUrl.toString(),
        serverHost: config.server.host,
        serverPort: config.server.port,
      },
    },
  );
}

function assertLaunchProfileDoesNotConflictWithGateway(
  config: RayConfig,
  profile: LlamaCppLaunchProfile,
): void {
  if (
    config.server.port !== profile.port ||
    !localBindHostsOverlap(config.server.host, profile.host)
  ) {
    return;
  }

  throw new RayError(
    "model.adapter.launchProfile.port must not overlap server.port on the same local bind address",
    {
      code: "config_validation_error",
      status: 500,
      details: {
        serverHost: config.server.host,
        serverPort: config.server.port,
        launchHost: profile.host,
        launchPort: profile.port,
      },
    },
  );
}

function assertLaunchProfileHostIsLoopback(profile: LlamaCppLaunchProfile): void {
  if (isLoopbackHost(profile.host)) {
    return;
  }

  throw new RayError(
    "model.adapter.launchProfile.host must be a loopback host so generated llama.cpp services stay behind Ray",
    {
      code: "config_validation_error",
      status: 500,
      details: {
        launchHost: profile.host,
      },
    },
  );
}

function launchHostRequiresExactBaseUrlHost(value: string): boolean {
  return isIP(normalizeHostLiteral(value)) > 0;
}

function assertLaunchProfileBaseUrlMatches(
  profile: LlamaCppLaunchProfile,
  adapterBaseUrl: URL,
): void {
  if (adapterBaseUrl.protocol !== "http:") {
    throw new RayError(
      "model.adapter.baseUrl must use plain HTTP when model.adapter.launchProfile is configured",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          baseUrl: adapterBaseUrl.toString(),
        },
      },
    );
  }

  if (!isLoopbackHost(adapterBaseUrl.hostname)) {
    throw new RayError(
      "model.adapter.baseUrl must be loopback when model.adapter.launchProfile is configured",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          baseUrl: adapterBaseUrl.toString(),
          launchHost: profile.host,
        },
      },
    );
  }

  if (
    launchHostRequiresExactBaseUrlHost(profile.host) &&
    normalizeHostLiteral(adapterBaseUrl.hostname) !== normalizeHostLiteral(profile.host)
  ) {
    throw new RayError(
      "model.adapter.baseUrl host must match model.adapter.launchProfile.host when launchProfile.host is a literal IP",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          baseUrl: adapterBaseUrl.toString(),
          launchHost: profile.host,
        },
      },
    );
  }

  if (getUrlPort(adapterBaseUrl) !== profile.port) {
    throw new RayError(
      "model.adapter.baseUrl port must match model.adapter.launchProfile.port when launchProfile is configured",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          baseUrl: adapterBaseUrl.toString(),
          launchPort: profile.port,
        },
      },
    );
  }

  if (adapterBaseUrl.pathname !== "/") {
    throw new RayError(
      "model.adapter.baseUrl must point at the generated llama.cpp service root when launchProfile is configured",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          baseUrl: adapterBaseUrl.toString(),
        },
      },
    );
  }
}

function assertRequestBodyLimitBytes(value: number): void {
  assertPositiveInteger(value, "server.requestBodyLimitBytes");

  if (value > MAX_REQUEST_BODY_LIMIT_BYTES) {
    throw new RayError(
      `server.requestBodyLimitBytes must be less than or equal to ${MAX_REQUEST_BODY_LIMIT_BYTES}`,
      {
        code: "config_validation_error",
        status: 500,
        details: {
          value,
          maxBytes: MAX_REQUEST_BODY_LIMIT_BYTES,
        },
      },
    );
  }
}

function assertSchedulerTokenBudgetCanAdmitDefaultRequest(config: RayConfig): void {
  const minimumRequestTokens = config.model.maxOutputTokens + MIN_PROMPT_TOKEN_BUDGET;

  if (config.scheduler.maxInflightTokens < minimumRequestTokens) {
    throw new RayError(
      "scheduler.maxInflightTokens must be at least model.maxOutputTokens plus one prompt token",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          maxInflightTokens: config.scheduler.maxInflightTokens,
          maxOutputTokens: config.model.maxOutputTokens,
          minimumRequestTokens,
        },
      },
    );
  }

  if (config.scheduler.maxQueuedTokens < minimumRequestTokens) {
    throw new RayError(
      "scheduler.maxQueuedTokens must be at least model.maxOutputTokens plus one prompt token",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          maxQueuedTokens: config.scheduler.maxQueuedTokens,
          maxOutputTokens: config.model.maxOutputTokens,
          minimumRequestTokens,
        },
      },
    );
  }
}

function assertPositiveIntegerAtMost(value: number, label: string, maximum: number): void {
  assertPositiveInteger(value, label);

  if (value > maximum) {
    throw new RayError(`${label} must be less than or equal to ${maximum}`, {
      code: "config_validation_error",
      status: 500,
      details: {
        value,
        maximum,
      },
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

function assertNonNegativeIntegerAtMost(value: number, label: string, maximum: number): void {
  assertNonNegativeInteger(value, label);

  if (value > maximum) {
    throw new RayError(`${label} must be less than or equal to ${maximum}`, {
      code: "config_validation_error",
      status: 500,
      details: {
        value,
        maximum,
      },
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

function assertPositiveUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RayError(`${label} must be greater than 0 and less than or equal to 1`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertPositiveNumberAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new RayError(`${label} must be greater than 0 and less than or equal to ${maximum}`, {
      code: "config_validation_error",
      status: 500,
      details: { value, maximum },
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

function assertStringLength(value: string, label: string, maxChars: number): void {
  if (value.length > maxChars) {
    throw new RayError(`${label} must be at most ${maxChars} characters`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualChars: value.length,
        maxChars,
      },
    });
  }
}

function assertNonEmptyStringLength(value: unknown, label: string, maxChars: number): void {
  if (!isNonEmptyString(value)) {
    throw new RayError(`${label} must be a non-empty string`, {
      code: "config_validation_error",
      status: 500,
    });
  }

  assertStringLength(value, label, maxChars);
}

function assertOptionalStringLength(value: unknown, label: string, maxChars: number): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    throw new RayError(`${label} must be a string`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  assertStringLength(value, label, maxChars);
}

function assertEnvironmentVariableName(value: unknown, label: string): void {
  assertNonEmptyStringLength(value, label, MAX_CONFIG_ENV_NAME_CHARS);

  if (
    typeof value !== "string" ||
    !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(value) ||
    unsafeConfigRecordKeys.has(value)
  ) {
    throw new RayError(`${label} must be a valid environment variable name`, {
      code: "config_validation_error",
      status: 500,
      details: {
        value,
        pattern: ENVIRONMENT_VARIABLE_NAME_PATTERN.source,
      },
    });
  }
}

function assertOptionalEnvironmentVariableName(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  assertEnvironmentVariableName(value, label);
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") {
    throw new RayError(`${label} must be a boolean`, {
      code: "config_validation_error",
      status: 500,
      details: { value },
    });
  }
}

function assertEnumValue<T extends string>(
  value: unknown,
  supported: Set<T>,
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !supported.has(value as T)) {
    throw new RayError(`${label} is not supported`, {
      code: "config_validation_error",
      status: 500,
      details: { value, supported: [...supported] },
    });
  }
}

function assertSafeConfigRecordKey(key: string, label: string): void {
  if (unsafeConfigRecordKeys.has(key)) {
    throw new RayError(`${label} must not contain unsafe key "${key}"`, {
      code: "config_validation_error",
      status: 500,
      details: { key },
    });
  }
}

function assertStringRecord(
  value: Record<string, string>,
  label: string,
  maxEntries = MAX_CONFIG_RECORD_ENTRIES,
  maxKeyChars = MAX_CONFIG_RECORD_KEY_CHARS,
  maxValueChars = MAX_CONFIG_RECORD_VALUE_CHARS,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError(`${label} must be an object of string values`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  const entries = Object.entries(value);

  if (entries.length > maxEntries) {
    throw new RayError(`${label} must contain at most ${maxEntries} entries`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualEntries: entries.length,
        maxEntries,
      },
    });
  }

  for (const [key, entry] of entries) {
    if (!isNonEmptyString(key) || typeof entry !== "string") {
      throw new RayError(`${label} must be an object of string values`, {
        code: "config_validation_error",
        status: 500,
        details: value,
      });
    }

    assertSafeConfigRecordKey(key, label);
    assertStringLength(key, `${label} keys`, maxKeyChars);
    assertStringLength(entry, `${label}.${key}`, maxValueChars);
  }
}

function assertHttpHeaderRecord(value: Record<string, string>, label: string): void {
  assertStringRecord(value, label);

  const seenHeaderNames = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (!HTTP_HEADER_NAME_PATTERN.test(key)) {
      throw new RayError(`${label} names must be valid HTTP header token strings`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }

    const normalizedKey = key.toLowerCase();
    if (seenHeaderNames.has(normalizedKey)) {
      throw new RayError(`${label} must not contain duplicate header name "${key}"`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }
    seenHeaderNames.add(normalizedKey);

    if (reservedAdapterHeaderNames.has(normalizedKey)) {
      throw new RayError(`${label}.${key} must not use a transport-controlled header name`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }

    if (/[\0\r\n]/.test(entry)) {
      throw new RayError(`${label}.${key} must not contain NUL, CR, or LF characters`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }
  }
}

function assertResponseFormat(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError(`${label} must be an object with a type`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  for (const [key] of Object.entries(value)) {
    assertSafeConfigRecordKey(key, label);

    if (key !== "type") {
      throw new RayError(`${label} must not contain unsupported key "${key}"`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }
  }

  const type = (value as { type?: unknown }).type;
  if (type !== "text" && type !== "json_object") {
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

  if (value.length > MAX_WARMUP_STOP_SEQUENCES) {
    throw new RayError(`${label} must contain at most ${MAX_WARMUP_STOP_SEQUENCES} entries`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualEntries: value.length,
        maxEntries: MAX_WARMUP_STOP_SEQUENCES,
      },
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

    assertStringLength(entry, `${label} entries`, MAX_WARMUP_STOP_SEQUENCE_CHARS);
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

  const entries = Object.entries(value);

  if (entries.length > MAX_WARMUP_TEMPLATE_VARIABLES) {
    throw new RayError(`${label} must contain at most ${MAX_WARMUP_TEMPLATE_VARIABLES} entries`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualEntries: entries.length,
        maxEntries: MAX_WARMUP_TEMPLATE_VARIABLES,
      },
    });
  }

  for (const [key, entry] of entries) {
    if (!isNonEmptyString(key)) {
      throw new RayError(`${label} keys must be non-empty strings`, {
        code: "config_validation_error",
        status: 500,
        details: value,
      });
    }

    assertSafeConfigRecordKey(key, label);
    assertStringLength(key, `${label} keys`, MAX_WARMUP_TEMPLATE_VARIABLE_KEY_CHARS);

    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new RayError(`${label}.${key} must be a string, number, or boolean`, {
        code: "config_validation_error",
        status: 500,
        details: entry,
      });
    }

    assertStringLength(String(entry), `${label}.${key}`, MAX_WARMUP_TEMPLATE_VARIABLE_VALUE_CHARS);
  }
}

const warmupRequestKeys = new Set([
  "input",
  "system",
  "maxTokens",
  "seed",
  "stop",
  "responseFormat",
  "templateId",
  "templateVariables",
]);

function assertWarmupRequest(
  request: {
    input?: string;
    system?: string;
    maxTokens?: number;
    seed?: number;
    stop?: string[];
    responseFormat?: unknown;
    templateId?: string;
    templateVariables?: Record<string, unknown>;
  },
  label: string,
  maxOutputTokens: number,
): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new RayError(`${label} must be an object`, {
      code: "config_validation_error",
      status: 500,
      details: request,
    });
  }

  for (const [key] of Object.entries(request)) {
    assertSafeConfigRecordKey(key, label);

    if (!warmupRequestKeys.has(key)) {
      throw new RayError(`${label} must not contain unsupported key "${key}"`, {
        code: "config_validation_error",
        status: 500,
        details: { key },
      });
    }
  }

  if (isNonEmptyString(request.templateId)) {
    assertStringLength(request.templateId, `${label}.templateId`, MAX_CONFIG_RECORD_KEY_CHARS);

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

  if (isNonEmptyString(request.input)) {
    assertStringLength(request.input, `${label}.input`, MAX_WARMUP_TEXT_CHARS);
  }

  if (request.system !== undefined) {
    if (typeof request.system !== "string") {
      throw new RayError(`${label}.system must be a string when provided`, {
        code: "config_validation_error",
        status: 500,
        details: request.system,
      });
    }

    assertStringLength(request.system, `${label}.system`, MAX_WARMUP_TEXT_CHARS);
  }

  if (request.maxTokens !== undefined) {
    assertPositiveInteger(request.maxTokens, `${label}.maxTokens`);

    if (request.maxTokens > maxOutputTokens) {
      throw new RayError(`${label}.maxTokens must be less than or equal to model.maxOutputTokens`, {
        code: "config_validation_error",
        status: 500,
        details: {
          value: request.maxTokens,
          maxOutputTokens,
        },
      });
    }
  }

  if (request.seed !== undefined) {
    assertSafeInteger(request.seed, `${label}.seed`);
  }

  assertStopSequences(request.stop, `${label}.stop`);
  assertResponseFormat(request.responseFormat, `${label}.responseFormat`);
}

function assertWarmupRequests(value: unknown, label: string, maxOutputTokens: number): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new RayError(`${label} must be an array`, {
      code: "config_validation_error",
      status: 500,
      details: value,
    });
  }

  if (value.length > MAX_WARMUP_REQUESTS) {
    throw new RayError(`${label} must contain at most ${MAX_WARMUP_REQUESTS} entries`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualEntries: value.length,
        maxEntries: MAX_WARMUP_REQUESTS,
      },
    });
  }

  for (const [index, request] of value.entries()) {
    assertWarmupRequest(
      request as {
        input?: string;
        system?: string;
        maxTokens?: number;
        seed?: number;
        stop?: string[];
        responseFormat?: unknown;
        templateId?: string;
        templateVariables?: Record<string, unknown>;
      },
      `${label}[${index}]`,
      maxOutputTokens,
    );
  }
}

function assertStringArray(
  value: string[] | undefined,
  label: string,
  maxEntries = MAX_CONFIG_STRING_ARRAY_ENTRIES,
  maxEntryChars = MAX_CONFIG_STRING_ARRAY_ENTRY_CHARS,
): void {
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

  if (value.length > maxEntries) {
    throw new RayError(`${label} must contain at most ${maxEntries} entries`, {
      code: "config_validation_error",
      status: 500,
      details: {
        actualEntries: value.length,
        maxEntries,
      },
    });
  }

  for (const entry of value) {
    assertStringLength(entry, `${label} entries`, maxEntryChars);
  }
}

function assertLlamaCppLaunchProfileExtraArgs(value: string[] | undefined): void {
  assertStringArray(value, "model.adapter.launchProfile.extraArgs");

  for (const [index, entry] of (value ?? []).entries()) {
    const override = getLlamaCppLaunchProfileExtraArgOverride(entry);
    if (override) {
      throw new RayError(
        `model.adapter.launchProfile.extraArgs[${index}] must not override ${override}; use the launchProfile field or RAY_LLAMA_CPP_* env override instead`,
        {
          code: "config_validation_error",
          status: 500,
          details: {
            index,
            value: entry,
            override,
          },
        },
      );
    }
  }
}

function isValidDnsHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CALLBACK_ALLOWED_HOST_CHARS) {
    return false;
  }

  return value.split(".").every((entry) => DNS_HOST_LABEL_PATTERN.test(entry));
}

function isValidCallbackAllowedHostPattern(value: string): boolean {
  if (value.trim() !== value) {
    return false;
  }

  const normalized = value.toLowerCase().replace(/\.$/, "");

  if (normalized.length === 0 || normalized.includes("://") || /[/?#@]/.test(normalized)) {
    return false;
  }

  if (normalized.startsWith("[") || normalized.endsWith("]")) {
    if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
      return false;
    }

    return isIP(normalized.slice(1, -1)) === 6;
  }

  if (normalized.startsWith("*.")) {
    return isValidDnsHostname(normalized.slice(2));
  }

  if (normalized.includes("*")) {
    return false;
  }

  return isIP(normalized) > 0 || isValidDnsHostname(normalized);
}

function assertCallbackAllowedHosts(value: string[] | undefined, label: string): void {
  assertStringArray(value, label, MAX_CONFIG_STRING_ARRAY_ENTRIES, MAX_CALLBACK_ALLOWED_HOST_CHARS);

  for (const entry of value ?? []) {
    if (!isValidCallbackAllowedHostPattern(entry)) {
      throw new RayError(
        `${label} entries must be exact host/IP literals or wildcard DNS patterns like *.example.com`,
        {
          code: "config_validation_error",
          status: 500,
          details: { value: entry },
        },
      );
    }
  }
}

function assertModelOperationalMetadata(config: RayConfig): void {
  const metadata = config.model.operational;

  if (!metadata) {
    return;
  }

  if (
    metadata.recommendedPromptFormat !== "native-template" &&
    metadata.recommendedPromptFormat !== "openai-chat" &&
    metadata.recommendedPromptFormat !== "plain-completion"
  ) {
    throw new RayError(
      "model.operational.recommendedPromptFormat must be native-template, openai-chat, or plain-completion",
      {
        code: "config_validation_error",
        status: 500,
        details: metadata,
      },
    );
  }

  assertPositiveIntegerAtMost(
    metadata.tokensPerSecondTarget,
    "model.operational.tokensPerSecondTarget",
    MAX_MODEL_TOKENS_PER_SECOND_TARGET,
  );
  assertPositiveIntegerAtMost(
    metadata.memoryClassMiB,
    "model.operational.memoryClassMiB",
    MAX_MODEL_MEMORY_CLASS_MIB,
  );
  assertPositiveIntegerAtMost(
    metadata.preferredCtxSize,
    "model.operational.preferredCtxSize",
    config.model.contextWindow,
  );
  assertBoolean(metadata.supportsJsonMode, "model.operational.supportsJsonMode");
  assertBoolean(metadata.chatTemplateKnown, "model.operational.chatTemplateKnown");
}

function validateConfig(config: RayConfig): RayConfig {
  assertEnumValue(config.profile, rayProfiles, "profile");
  assertEnumValue(config.model.quantization, quantizations, "model.quantization");
  assertEnumValue(config.telemetry.logLevel, logLevels, "telemetry.logLevel");

  assertNonEmptyStringLength(config.server.host, "server.host", MAX_CONFIG_HOST_CHARS);
  assertNonEmptyStringLength(
    config.telemetry.serviceName,
    "telemetry.serviceName",
    MAX_TELEMETRY_SERVICE_NAME_CHARS,
  );

  assertTcpPort(config.server.port, "server.port");
  assertRequestBodyLimitBytes(config.server.requestBodyLimitBytes);
  assertPositiveIntegerAtMost(
    config.telemetry.slowRequestThresholdMs,
    "telemetry.slowRequestThresholdMs",
    MAX_REQUEST_TIMEOUT_MS,
  );
  assertPositiveIntegerAtMost(
    config.model.contextWindow,
    "model.contextWindow",
    MAX_MODEL_CONTEXT_WINDOW,
  );
  assertPositiveIntegerAtMost(
    config.model.maxOutputTokens,
    "model.maxOutputTokens",
    MAX_MODEL_OUTPUT_TOKENS,
  );
  if (config.model.maxOutputTokens > config.model.contextWindow) {
    throw new RayError("model.maxOutputTokens must be less than or equal to model.contextWindow", {
      code: "config_validation_error",
      status: 500,
      details: {
        maxOutputTokens: config.model.maxOutputTokens,
        contextWindow: config.model.contextWindow,
      },
    });
  }
  assertPositiveIntegerAtMost(
    config.scheduler.concurrency,
    "scheduler.concurrency",
    MAX_SCHEDULER_CONCURRENCY,
  );
  assertPositiveIntegerAtMost(
    config.scheduler.maxQueue,
    "scheduler.maxQueue",
    MAX_SCHEDULER_QUEUE_DEPTH,
  );
  assertPositiveIntegerAtMost(
    config.scheduler.maxQueuedTokens,
    "scheduler.maxQueuedTokens",
    MAX_SCHEDULER_QUEUED_TOKENS,
  );
  assertPositiveIntegerAtMost(
    config.scheduler.maxInflightTokens,
    "scheduler.maxInflightTokens",
    MAX_SCHEDULER_INFLIGHT_TOKENS,
  );
  assertPositiveIntegerAtMost(
    config.scheduler.requestTimeoutMs,
    "scheduler.requestTimeoutMs",
    MAX_REQUEST_TIMEOUT_MS,
  );
  assertNonNegativeIntegerAtMost(
    config.scheduler.batchWindowMs,
    "scheduler.batchWindowMs",
    MAX_SCHEDULER_BATCH_WINDOW_MS,
  );
  assertPositiveInteger(config.scheduler.affinityLookahead, "scheduler.affinityLookahead");
  assertPositiveInteger(config.scheduler.shortJobMaxTokens, "scheduler.shortJobMaxTokens");
  if (config.scheduler.batchWindowMs >= config.scheduler.requestTimeoutMs) {
    throw new RayError("scheduler.batchWindowMs must be less than scheduler.requestTimeoutMs", {
      code: "config_validation_error",
      status: 500,
      details: {
        batchWindowMs: config.scheduler.batchWindowMs,
        requestTimeoutMs: config.scheduler.requestTimeoutMs,
      },
    });
  }
  if (config.scheduler.affinityLookahead > config.scheduler.maxQueue) {
    throw new RayError("scheduler.affinityLookahead must be less than or equal to maxQueue", {
      code: "config_validation_error",
      status: 500,
      details: {
        affinityLookahead: config.scheduler.affinityLookahead,
        maxQueue: config.scheduler.maxQueue,
      },
    });
  }
  if (config.scheduler.shortJobMaxTokens > config.model.maxOutputTokens) {
    throw new RayError(
      "scheduler.shortJobMaxTokens must be less than or equal to model.maxOutputTokens",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          shortJobMaxTokens: config.scheduler.shortJobMaxTokens,
          maxOutputTokens: config.model.maxOutputTokens,
        },
      },
    );
  }
  assertSchedulerTokenBudgetCanAdmitDefaultRequest(config);
  assertPositiveIntegerAtMost(
    config.asyncQueue.maxJobs,
    "asyncQueue.maxJobs",
    MAX_ASYNC_QUEUE_JOBS,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.minFreeStorageMiB,
    "asyncQueue.minFreeStorageMiB",
    MAX_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.completedTtlMs,
    "asyncQueue.completedTtlMs",
    MAX_ASYNC_COMPLETED_TTL_MS,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.pollIntervalMs,
    "asyncQueue.pollIntervalMs",
    MAX_ASYNC_POLL_INTERVAL_MS,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.dispatchConcurrency,
    "asyncQueue.dispatchConcurrency",
    MAX_ASYNC_DISPATCH_CONCURRENCY,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.maxAttempts,
    "asyncQueue.maxAttempts",
    MAX_ASYNC_ATTEMPTS,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.callbackTimeoutMs,
    "asyncQueue.callbackTimeoutMs",
    MAX_CALLBACK_TIMEOUT_MS,
  );
  assertPositiveIntegerAtMost(
    config.asyncQueue.maxCallbackAttempts,
    "asyncQueue.maxCallbackAttempts",
    MAX_ASYNC_ATTEMPTS,
  );
  assertCallbackAllowedHosts(
    config.asyncQueue.callbackAllowedHosts,
    "asyncQueue.callbackAllowedHosts",
  );
  assertPositiveIntegerAtMost(config.cache.maxEntries, "cache.maxEntries", MAX_CACHE_ENTRIES);
  assertPositiveIntegerAtMost(config.cache.maxBytes, "cache.maxBytes", MAX_CACHE_BYTES);
  assertPositiveIntegerAtMost(config.cache.ttlMs, "cache.ttlMs", MAX_CACHE_TTL_MS);
  assertPositiveIntegerAtMost(
    config.gracefulDegradation.maxPromptChars,
    "gracefulDegradation.maxPromptChars",
    MAX_GRACEFUL_DEGRADATION_PROMPT_CHARS,
  );
  assertPositiveInteger(
    config.gracefulDegradation.queueDepthThreshold,
    "gracefulDegradation.queueDepthThreshold",
  );
  assertPositiveInteger(
    config.gracefulDegradation.degradeToMaxTokens,
    "gracefulDegradation.degradeToMaxTokens",
  );
  assertPositiveIntegerAtMost(
    config.gracefulDegradation.memoryRssThresholdMiB,
    "gracefulDegradation.memoryRssThresholdMiB",
    MAX_GRACEFUL_DEGRADATION_MEMORY_RSS_MIB,
  );
  assertPositiveUnitInterval(
    config.gracefulDegradation.memoryCgroupPressureRatioThreshold,
    "gracefulDegradation.memoryCgroupPressureRatioThreshold",
  );
  assertPositiveUnitInterval(
    config.gracefulDegradation.cpuThrottledRatioThreshold,
    "gracefulDegradation.cpuThrottledRatioThreshold",
  );
  assertPositiveNumberAtMost(
    config.gracefulDegradation.memoryPsiSomeAvg10Threshold,
    "gracefulDegradation.memoryPsiSomeAvg10Threshold",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  assertPositiveNumberAtMost(
    config.gracefulDegradation.memoryPsiFullAvg10Threshold,
    "gracefulDegradation.memoryPsiFullAvg10Threshold",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  assertPositiveNumberAtMost(
    config.gracefulDegradation.cpuPsiSomeAvg10Threshold,
    "gracefulDegradation.cpuPsiSomeAvg10Threshold",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  assertPositiveNumberAtMost(
    config.gracefulDegradation.cpuPsiFullAvg10Threshold,
    "gracefulDegradation.cpuPsiFullAvg10Threshold",
    MAX_GRACEFUL_DEGRADATION_PSI_AVG10_THRESHOLD,
  );
  if (config.gracefulDegradation.degradeToMaxTokens > config.model.maxOutputTokens) {
    throw new RayError(
      "gracefulDegradation.degradeToMaxTokens must be less than or equal to model.maxOutputTokens",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          degradeToMaxTokens: config.gracefulDegradation.degradeToMaxTokens,
          maxOutputTokens: config.model.maxOutputTokens,
        },
      },
    );
  }
  if (
    config.gracefulDegradation.enabled &&
    config.gracefulDegradation.queueDepthThreshold >= config.scheduler.maxQueue
  ) {
    throw new RayError(
      "gracefulDegradation.queueDepthThreshold must be less than scheduler.maxQueue",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          queueDepthThreshold: config.gracefulDegradation.queueDepthThreshold,
          maxQueue: config.scheduler.maxQueue,
        },
      },
    );
  }
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.sampleSize,
    "adaptiveTuning.sampleSize",
    MAX_ADAPTIVE_SAMPLE_SIZE,
  );
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.familyHistorySize,
    "adaptiveTuning.familyHistorySize",
    MAX_ADAPTIVE_FAMILY_HISTORY_SIZE,
  );
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.learnedCapMinSamples,
    "adaptiveTuning.learnedCapMinSamples",
    config.adaptiveTuning.familyHistorySize,
  );
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.queueLatencyThresholdMs,
    "adaptiveTuning.queueLatencyThresholdMs",
    MAX_ADAPTIVE_LATENCY_THRESHOLD_MS,
  );
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.minCompletionTokensPerSecond,
    "adaptiveTuning.minCompletionTokensPerSecond",
    MAX_MODEL_TOKENS_PER_SECOND_TARGET,
  );
  assertPositiveInteger(config.adaptiveTuning.minOutputTokens, "adaptiveTuning.minOutputTokens");
  if (config.adaptiveTuning.minOutputTokens > config.model.maxOutputTokens) {
    throw new RayError(
      "adaptiveTuning.minOutputTokens must be less than or equal to model.maxOutputTokens",
      {
        code: "config_validation_error",
        status: 500,
        details: {
          minOutputTokens: config.adaptiveTuning.minOutputTokens,
          maxOutputTokens: config.model.maxOutputTokens,
        },
      },
    );
  }
  assertPositiveIntegerAtMost(
    config.adaptiveTuning.learnedCapHeadroomTokens,
    "adaptiveTuning.learnedCapHeadroomTokens",
    config.model.maxOutputTokens,
  );
  assertPositiveIntegerAtMost(
    config.rateLimit.windowMs,
    "rateLimit.windowMs",
    MAX_RATE_LIMIT_WINDOW_MS,
  );
  assertPositiveIntegerAtMost(
    config.rateLimit.maxRequests,
    "rateLimit.maxRequests",
    MAX_RATE_LIMIT_REQUESTS,
  );
  assertPositiveIntegerAtMost(config.rateLimit.maxKeys, "rateLimit.maxKeys", MAX_RATE_LIMIT_KEYS);
  assertUnitInterval(
    config.adaptiveTuning.maxOutputReductionRatio,
    "adaptiveTuning.maxOutputReductionRatio",
  );
  assertUnitInterval(config.adaptiveTuning.draftPercentile, "adaptiveTuning.draftPercentile");
  assertUnitInterval(config.adaptiveTuning.shortPercentile, "adaptiveTuning.shortPercentile");
  assertBoolean(config.model.warmOnBoot, "model.warmOnBoot");
  assertBoolean(config.scheduler.dedupeInflight, "scheduler.dedupeInflight");
  assertBoolean(config.asyncQueue.enabled, "asyncQueue.enabled");
  assertBoolean(
    config.asyncQueue.callbackAllowPrivateNetwork,
    "asyncQueue.callbackAllowPrivateNetwork",
  );
  assertBoolean(config.cache.enabled, "cache.enabled");
  assertBoolean(config.telemetry.includeDebugMetrics, "telemetry.includeDebugMetrics");
  assertBoolean(config.gracefulDegradation.enabled, "gracefulDegradation.enabled");
  assertBoolean(config.promptCompiler.enabled, "promptCompiler.enabled");
  assertBoolean(config.promptCompiler.collapseWhitespace, "promptCompiler.collapseWhitespace");
  assertBoolean(config.promptCompiler.dedupeRepeatedLines, "promptCompiler.dedupeRepeatedLines");
  assertBoolean(config.adaptiveTuning.enabled, "adaptiveTuning.enabled");
  assertBoolean(
    config.adaptiveTuning.learnedFamilyCapEnabled,
    "adaptiveTuning.learnedFamilyCapEnabled",
  );
  assertBoolean(config.auth.enabled, "auth.enabled");
  assertBoolean(config.rateLimit.enabled, "rateLimit.enabled");
  assertBoolean(config.rateLimit.trustProxyHeaders, "rateLimit.trustProxyHeaders");
  assertEnumValue(config.cache.keyStrategy, cacheKeyStrategies, "cache.keyStrategy");
  assertEnumValue(config.rateLimit.keyStrategy, rateLimitKeyStrategies, "rateLimit.keyStrategy");
  assertStringRecord(config.tags, "tags");

  assertNonEmptyStringLength(config.model.id, "model.id", MAX_CONFIG_IDENTIFIER_CHARS);
  assertNonEmptyStringLength(config.model.family, "model.family", MAX_CONFIG_IDENTIFIER_CHARS);

  assertModelOperationalMetadata(config);
  assertEnumValue(
    config.model.adapter.kind,
    new Set(["mock", "openai-compatible", "llama.cpp"]),
    "model.adapter.kind",
  );

  assertConfigPathInput(config.asyncQueue.storageDir, "asyncQueue.storageDir");

  assertStringArray(
    config.promptCompiler.familyMetadataKeys,
    "promptCompiler.familyMetadataKeys",
    MAX_PROMPT_FAMILY_METADATA_KEYS,
    MAX_PROMPT_FAMILY_METADATA_KEY_CHARS,
  );

  if (config.auth.enabled) {
    assertEnvironmentVariableName(config.auth.apiKeyEnv, "auth.apiKeyEnv");
  } else {
    assertOptionalEnvironmentVariableName(config.auth.apiKeyEnv, "auth.apiKeyEnv");
  }

  if (config.model.adapter.kind === "openai-compatible") {
    assertNonEmptyStringLength(
      config.model.adapter.baseUrl,
      "model.adapter.baseUrl",
      MAX_CONFIG_URL_CHARS,
    );
    assertNonEmptyStringLength(
      config.model.adapter.modelRef,
      "model.adapter.modelRef",
      MAX_CONFIG_IDENTIFIER_CHARS,
    );
    assertOptionalEnvironmentVariableName(
      config.model.adapter.apiKeyEnv,
      "model.adapter.apiKeyEnv",
    );

    const adapterBaseUrl = assertHttpBaseUrl(config.model.adapter.baseUrl, "model.adapter.baseUrl");
    assertAdapterDoesNotTargetGateway(config, adapterBaseUrl, "model.adapter.baseUrl");
    assertPositiveIntegerAtMost(
      config.model.adapter.timeoutMs,
      "model.adapter.timeoutMs",
      MAX_ADAPTER_TIMEOUT_MS,
    );
    if (config.model.adapter.headers !== undefined) {
      assertHttpHeaderRecord(config.model.adapter.headers, "model.adapter.headers");
    }

    assertWarmupRequests(
      config.model.adapter.warmupRequests,
      "model.adapter.warmupRequests",
      config.model.maxOutputTokens,
    );
  }

  if (config.model.adapter.kind === "mock") {
    assertPositiveIntegerAtMost(
      config.model.adapter.latencyMs,
      "model.adapter.latencyMs",
      MAX_MOCK_LATENCY_MS,
    );
    assertOptionalStringLength(
      config.model.adapter.seed,
      "model.adapter.seed",
      MAX_MOCK_SEED_CHARS,
    );
  }

  if (config.model.adapter.kind === "llama.cpp") {
    assertNonEmptyStringLength(
      config.model.adapter.baseUrl,
      "model.adapter.baseUrl",
      MAX_CONFIG_URL_CHARS,
    );
    assertNonEmptyStringLength(
      config.model.adapter.modelRef,
      "model.adapter.modelRef",
      MAX_CONFIG_IDENTIFIER_CHARS,
    );
    assertOptionalEnvironmentVariableName(
      config.model.adapter.apiKeyEnv,
      "model.adapter.apiKeyEnv",
    );

    const adapterBaseUrl = assertHttpBaseUrl(config.model.adapter.baseUrl, "model.adapter.baseUrl");
    assertAdapterDoesNotTargetGateway(config, adapterBaseUrl, "model.adapter.baseUrl");
    assertPositiveIntegerAtMost(
      config.model.adapter.timeoutMs,
      "model.adapter.timeoutMs",
      MAX_ADAPTER_TIMEOUT_MS,
    );
    if (config.model.adapter.headers !== undefined) {
      assertHttpHeaderRecord(config.model.adapter.headers, "model.adapter.headers");
    }

    if (config.model.adapter.cachePrompt !== undefined) {
      assertBoolean(config.model.adapter.cachePrompt, "model.adapter.cachePrompt");
    }

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
      config.model.adapter.slotStateTtlMs !== undefined &&
      config.model.adapter.slotStateTtlMs > MAX_ADAPTER_TIMEOUT_MS
    ) {
      throw new RayError(
        `model.adapter.slotStateTtlMs must be less than or equal to ${MAX_ADAPTER_TIMEOUT_MS}`,
        {
          code: "config_validation_error",
          status: 500,
          details: {
            value: config.model.adapter.slotStateTtlMs,
            maximum: MAX_ADAPTER_TIMEOUT_MS,
          },
        },
      );
    }

    if (
      config.model.adapter.slotSnapshotTimeoutMs !== undefined &&
      (!Number.isInteger(config.model.adapter.slotSnapshotTimeoutMs) ||
        config.model.adapter.slotSnapshotTimeoutMs <= 0)
    ) {
      throw new RayError("model.adapter.slotSnapshotTimeoutMs must be a positive integer", {
        code: "config_validation_error",
        status: 500,
        details: config.model.adapter.slotSnapshotTimeoutMs,
      });
    }
    if (
      config.model.adapter.slotSnapshotTimeoutMs !== undefined &&
      config.model.adapter.slotSnapshotTimeoutMs > config.model.adapter.timeoutMs
    ) {
      throw new RayError(
        "model.adapter.slotSnapshotTimeoutMs must be less than or equal to model.adapter.timeoutMs",
        {
          code: "config_validation_error",
          status: 500,
          details: {
            slotSnapshotTimeoutMs: config.model.adapter.slotSnapshotTimeoutMs,
            timeoutMs: config.model.adapter.timeoutMs,
          },
        },
      );
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
    if (
      config.model.adapter.promptScaffoldCacheEntries !== undefined &&
      config.model.adapter.promptScaffoldCacheEntries > MAX_PROMPT_SCAFFOLD_CACHE_ENTRIES
    ) {
      throw new RayError(
        `model.adapter.promptScaffoldCacheEntries must be less than or equal to ${MAX_PROMPT_SCAFFOLD_CACHE_ENTRIES}`,
        {
          code: "config_validation_error",
          status: 500,
          details: {
            value: config.model.adapter.promptScaffoldCacheEntries,
            maximum: MAX_PROMPT_SCAFFOLD_CACHE_ENTRIES,
          },
        },
      );
    }

    assertWarmupRequests(
      config.model.adapter.warmupRequests,
      "model.adapter.warmupRequests",
      config.model.maxOutputTokens,
    );

    if (config.model.adapter.launchProfile) {
      const profile = config.model.adapter.launchProfile;
      assertConfigPathInput(profile.binaryPath, "model.adapter.launchProfile.binaryPath");
      assertAbsolutePath(profile.binaryPath, "model.adapter.launchProfile.binaryPath");
      assertConfigPathInput(profile.modelPath, "model.adapter.launchProfile.modelPath");
      assertAbsolutePath(profile.modelPath, "model.adapter.launchProfile.modelPath");
      assertNonEmptyStringLength(
        profile.host,
        "model.adapter.launchProfile.host",
        MAX_CONFIG_HOST_CHARS,
      );
      assertOptionalStringLength(
        profile.alias,
        "model.adapter.launchProfile.alias",
        MAX_CONFIG_IDENTIFIER_CHARS,
      );

      if (!isLlamaCppLaunchPreset(profile.preset)) {
        throw new RayError("model.adapter.launchProfile.preset is not recognized", {
          code: "config_validation_error",
          status: 500,
          details: profile.preset,
        });
      }

      assertTcpPort(profile.port, "model.adapter.launchProfile.port");
      assertLaunchProfileHostIsLoopback(profile);
      assertLaunchProfileDoesNotConflictWithGateway(config, profile);
      assertLaunchProfileBaseUrlMatches(profile, adapterBaseUrl);
      assertPositiveIntegerAtMost(
        profile.ctxSize,
        "model.adapter.launchProfile.ctxSize",
        MAX_LLAMA_CTX_SIZE,
      );
      if (profile.ctxSize > config.model.contextWindow) {
        throw new RayError(
          "model.adapter.launchProfile.ctxSize must be less than or equal to model.contextWindow",
          {
            code: "config_validation_error",
            status: 500,
            details: {
              ctxSize: profile.ctxSize,
              contextWindow: config.model.contextWindow,
            },
          },
        );
      }
      assertPositiveIntegerAtMost(
        profile.parallel,
        "model.adapter.launchProfile.parallel",
        MAX_LLAMA_PARALLEL,
      );
      const launchContextCapacity = profile.ctxSize * profile.parallel;
      if (config.scheduler.maxInflightTokens > launchContextCapacity) {
        throw new RayError(
          "scheduler.maxInflightTokens must be less than or equal to llama.cpp launch context capacity",
          {
            code: "config_validation_error",
            status: 500,
            details: {
              maxInflightTokens: config.scheduler.maxInflightTokens,
              ctxSize: profile.ctxSize,
              parallel: profile.parallel,
              launchContextCapacity,
            },
          },
        );
      }
      assertPositiveIntegerAtMost(
        profile.threads,
        "model.adapter.launchProfile.threads",
        MAX_LLAMA_THREADS,
      );
      assertPositiveIntegerAtMost(
        profile.threadsHttp,
        "model.adapter.launchProfile.threadsHttp",
        MAX_LLAMA_HTTP_THREADS,
      );
      assertPositiveIntegerAtMost(
        profile.batchSize,
        "model.adapter.launchProfile.batchSize",
        MAX_LLAMA_BATCH_SIZE,
      );
      assertPositiveIntegerAtMost(
        profile.ubatchSize,
        "model.adapter.launchProfile.ubatchSize",
        MAX_LLAMA_BATCH_SIZE,
      );
      if (profile.ubatchSize > profile.batchSize) {
        throw new RayError(
          "model.adapter.launchProfile.ubatchSize must be less than or equal to batchSize",
          {
            code: "config_validation_error",
            status: 500,
            details: {
              ubatchSize: profile.ubatchSize,
              batchSize: profile.batchSize,
            },
          },
        );
      }
      assertNonNegativeInteger(profile.cacheReuse, "model.adapter.launchProfile.cacheReuse");
      if (profile.cacheReuse > MAX_LLAMA_CACHE_REUSE) {
        throw new RayError(
          `model.adapter.launchProfile.cacheReuse must be less than or equal to ${MAX_LLAMA_CACHE_REUSE}`,
          {
            code: "config_validation_error",
            status: 500,
            details: {
              value: profile.cacheReuse,
              maximum: MAX_LLAMA_CACHE_REUSE,
            },
          },
        );
      }
      assertBoolean(profile.cachePrompt, "model.adapter.launchProfile.cachePrompt");
      assertBoolean(profile.continuousBatching, "model.adapter.launchProfile.continuousBatching");
      assertBoolean(profile.enableMetrics, "model.adapter.launchProfile.enableMetrics");
      assertBoolean(profile.exposeSlots, "model.adapter.launchProfile.exposeSlots");
      assertBoolean(profile.warmup, "model.adapter.launchProfile.warmup");
      assertBoolean(profile.enableUnifiedKv, "model.adapter.launchProfile.enableUnifiedKv");
      assertBoolean(profile.cacheIdleSlots, "model.adapter.launchProfile.cacheIdleSlots");
      assertBoolean(profile.contextShift, "model.adapter.launchProfile.contextShift");
      if (profile.cacheRamMiB !== undefined) {
        assertIntegerAtLeast(profile.cacheRamMiB, -1, "model.adapter.launchProfile.cacheRamMiB");
        if (profile.cacheRamMiB > MAX_LLAMA_CACHE_RAM_MIB) {
          throw new RayError(
            `model.adapter.launchProfile.cacheRamMiB must be less than or equal to ${MAX_LLAMA_CACHE_RAM_MIB}`,
            {
              code: "config_validation_error",
              status: 500,
              details: {
                value: profile.cacheRamMiB,
                maximum: MAX_LLAMA_CACHE_RAM_MIB,
              },
            },
          );
        }
      }

      if (profile.threadsBatch !== undefined) {
        assertPositiveIntegerAtMost(
          profile.threadsBatch,
          "model.adapter.launchProfile.threadsBatch",
          MAX_LLAMA_THREADS,
        );
      }

      assertLlamaCppLaunchProfileExtraArgs(profile.extraArgs);
    }
  }

  return config;
}

export function snapshotRayConfig(config: RayConfig): RayConfig {
  return validateConfig(structuredClone(config));
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

  if (raw.length > MAX_AUTH_API_KEY_ENV_CHARS) {
    throw new RayError(`${envName} must be at most ${MAX_AUTH_API_KEY_ENV_CHARS} characters`, {
      code: "config_validation_error",
      status: 500,
      details: {
        envName,
        actualChars: raw.length,
        maxChars: MAX_AUTH_API_KEY_ENV_CHARS,
      },
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

  if (keys.length > MAX_AUTH_API_KEYS) {
    throw new RayError(`${envName} must contain at most ${MAX_AUTH_API_KEYS} API keys`, {
      code: "config_validation_error",
      status: 500,
      details: {
        envName,
        actualKeys: keys.length,
        maxKeys: MAX_AUTH_API_KEYS,
      },
    });
  }

  for (const key of keys) {
    assertStringLength(key, `${envName} entries`, MAX_AUTH_API_KEY_CHARS);
    if (/[\0-\x20\x7f]|\s/u.test(key)) {
      throw new RayError(
        `${envName} entries must be bearer-token-safe strings without whitespace or control characters`,
        {
          code: "config_validation_error",
          status: 500,
          details: { envName },
        },
      );
    }
  }

  return new Set(keys);
}

export async function loadRayConfig(options: LoadRayConfigOptions = {}): Promise<LoadedRayConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  assertConfigPathInput(cwd, "cwd");
  if (options.configPath !== undefined) {
    assertConfigPathInput(options.configPath, "configPath");
  }
  const absoluteConfigPath = options.configPath ? path.resolve(cwd, options.configPath) : undefined;

  let fileConfig: DeepPartial<RayConfig> | undefined;

  if (absoluteConfigPath) {
    const raw = await readConfigFileBounded(absoluteConfigPath);
    fileConfig = parseConfigJson(raw, absoluteConfigPath);
  }

  const selectedProfile =
    parseProfile(fileConfig?.profile, "config.profile") ??
    parseProfile(env.RAY_PROFILE, "RAY_PROFILE") ??
    "sub1b";
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
  const capabilityHints = {
    profile: safe.profile,
    modelId: safe.model.id,
    family: safe.model.family,
    quantization: safe.model.quantization,
    contextWindow: safe.model.contextWindow,
    maxOutputTokens: safe.model.maxOutputTokens,
    operational: safe.model.operational,
    ...(safe.model.adapter.kind === "llama.cpp"
      ? {
          llamaCpp: {
            modelRef: safe.model.adapter.modelRef,
            launchPreset: safe.model.adapter.launchProfile?.preset,
            ctxSize: safe.model.adapter.launchProfile?.ctxSize,
            parallel: safe.model.adapter.launchProfile?.parallel,
            cacheRamMiB: safe.model.adapter.launchProfile?.cacheRamMiB,
            cachePrompt: safe.model.adapter.cachePrompt,
          },
        }
      : {}),
  };

  if (
    (safe.model.adapter.kind === "openai-compatible" || safe.model.adapter.kind === "llama.cpp") &&
    safe.model.adapter.headers
  ) {
    safe.model.adapter.headers = Object.fromEntries(
      Object.keys(safe.model.adapter.headers).map((key) => [key, "[redacted]"]),
    );
  }

  return {
    ...(safe as unknown as Record<string, unknown>),
    capabilityHints,
  };
}

export { createDefaultConfig, mergeConfig };
