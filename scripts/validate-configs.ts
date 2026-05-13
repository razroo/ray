import { opendir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadAndDiagnoseDeployment,
  type DeploymentDiagnostic,
} from "../packages/deploy/src/index.ts";

const DEFAULT_CONFIG_DIR = "examples/config";
const DEFAULT_SMOKE_API_KEY = "ray-config-smoke";
const MAX_CONFIG_FILES = 128;
const MAX_CLI_ARGS = 16;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_PUBLIC_MODEL_CONTEXT_WINDOW = 8_192;
const MAX_PUBLIC_MODEL_OUTPUT_TOKENS = 256;
const MAX_PUBLIC_MODEL_OPERATIONAL_TOKENS_PER_SECOND = 18;
const MAX_PUBLIC_MODEL_OPERATIONAL_MEMORY_CLASS_MIB = 8_192;
const MAX_PUBLIC_MODEL_OPERATIONAL_CTX_SIZE = 4_096;
const MAX_PUBLIC_REQUEST_BODY_LIMIT_BYTES = 64_000;
const MAX_PUBLIC_RATE_LIMIT_WINDOW_MS = 3_600_000;
const MAX_PUBLIC_RATE_LIMIT_REQUESTS = 300;
const MAX_PUBLIC_RATE_LIMIT_KEYS = 8_192;
const MAX_PUBLIC_SERVER_PORT = 65_535;
const PUBLIC_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8081";
const PUBLIC_LLAMA_CPP_BINARY_PATH = "/usr/local/bin/llama-server";
const PUBLIC_LLAMA_CPP_HOST = "127.0.0.1";
const PUBLIC_LLAMA_CPP_PORT = 8_081;
const MAX_PUBLIC_ADAPTER_TIMEOUT_MS = 32_000;
const MAX_PUBLIC_ADAPTER_SLOT_STATE_TTL_MS = 250;
const MAX_PUBLIC_ADAPTER_SLOT_SNAPSHOT_TIMEOUT_MS = 300;
const MAX_PUBLIC_PROMPT_SCAFFOLD_CACHE_ENTRIES = 384;
const MAX_PUBLIC_LLAMA_CTX_SIZE = 4_096;
const MAX_PUBLIC_LLAMA_PARALLEL = 2;
const MAX_PUBLIC_LLAMA_THREADS = 4;
const MAX_PUBLIC_LLAMA_HTTP_THREADS = 2;
const MAX_PUBLIC_LLAMA_BATCH_SIZE = 256;
const MAX_PUBLIC_LLAMA_UBATCH_SIZE = 128;
const MAX_PUBLIC_LLAMA_CACHE_REUSE = 256;
const MAX_PUBLIC_LLAMA_CACHE_RAM_MIB = 768;
const MAX_PUBLIC_TELEMETRY_SLOW_REQUEST_MS = 2_200;
const MAX_PUBLIC_SCHEDULER_CONCURRENCY = 2;
const MAX_PUBLIC_SCHEDULER_QUEUE_DEPTH = 96;
const MAX_PUBLIC_SCHEDULER_QUEUED_TOKENS = 48_000;
const MAX_PUBLIC_SCHEDULER_INFLIGHT_TOKENS = 6_144;
const MAX_PUBLIC_SCHEDULER_REQUEST_TIMEOUT_MS = 32_000;
const MAX_PUBLIC_SCHEDULER_BATCH_WINDOW_MS = 10;
const MAX_PUBLIC_SCHEDULER_AFFINITY_LOOKAHEAD = 24;
const MAX_PUBLIC_SCHEDULER_SHORT_JOB_TOKENS = 96;
const PUBLIC_ASYNC_QUEUE_STORAGE_DIR = "/var/lib/ray/async-queue";
const MAX_PUBLIC_ASYNC_QUEUE_JOBS = 2_000;
const MAX_PUBLIC_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB = 1_024;
const MAX_PUBLIC_ASYNC_QUEUE_COMPLETED_TTL_MS = 604_800_000;
const MAX_PUBLIC_ASYNC_QUEUE_POLL_INTERVAL_MS = 5_000;
const MAX_PUBLIC_ASYNC_QUEUE_DISPATCH_CONCURRENCY = 1;
const MAX_PUBLIC_ASYNC_QUEUE_ATTEMPTS = 5;
const MAX_PUBLIC_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS = 10_000;
const MAX_PUBLIC_ASYNC_QUEUE_CALLBACK_ATTEMPTS = 5;
const MAX_PUBLIC_CACHE_ENTRIES = 512;
const MAX_PUBLIC_CACHE_BYTES = 4_194_304;
const MAX_PUBLIC_CACHE_TTL_MS = 120_000;
const MAX_PUBLIC_DEGRADATION_QUEUE_DEPTH = 20;
const MAX_PUBLIC_DEGRADATION_PROMPT_CHARS = 8_000;
const MAX_PUBLIC_DEGRADATION_TOKENS = 160;
const MAX_PUBLIC_DEGRADATION_MEMORY_RSS_MIB = 768;
const MAX_PUBLIC_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO = 0.9;
const MAX_PUBLIC_DEGRADATION_CPU_THROTTLED_RATIO = 0.2;
const MAX_PUBLIC_DEGRADATION_PSI_AVG10_THRESHOLD = 100;
const MAX_PUBLIC_ADAPTIVE_SAMPLE_SIZE = 32;
const MAX_PUBLIC_ADAPTIVE_QUEUE_LATENCY_MS = 600;
const MAX_PUBLIC_ADAPTIVE_MIN_TOKENS_PER_SECOND = 14;
const MAX_PUBLIC_ADAPTIVE_OUTPUT_REDUCTION_RATIO = 0.5;
const MAX_PUBLIC_ADAPTIVE_MIN_OUTPUT_TOKENS = 64;
const MAX_PUBLIC_ADAPTIVE_FAMILY_HISTORY_SIZE = 64;
const MAX_PUBLIC_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES = 8;
const MAX_PUBLIC_ADAPTIVE_DRAFT_PERCENTILE = 0.95;
const MAX_PUBLIC_ADAPTIVE_SHORT_PERCENTILE = 0.9;
const MAX_PUBLIC_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS = 24;
const PUBLIC_PROMPT_COMPILER_FAMILY_KEYS = [
  "promptFamily",
  "taskTemplate",
  "template",
  "useCase",
] as const;

type ConfigRecord = Record<string, unknown>;

export interface ValidateConfigsArgs {
  cwd: string;
  configDir: string;
  failOnWarn: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

export interface ConfigValidationResult {
  configPath: string;
  profile?: string;
  diagnostics: DeploymentDiagnostic[];
  errorCount: number;
  warningCount: number;
}

export interface ConfigValidationSummary {
  ok: boolean;
  failOnWarn: boolean;
  configCount: number;
  errorCount: number;
  warningCount: number;
  results: ConfigValidationResult[];
}

const HELP = `Validate every checked-in Ray example config.

Usage:
  bun ./scripts/validate-configs.ts [options]

Options:
  --cwd <path>          Repository root. Default: current directory.
  --config-dir <path>   Directory containing JSON config files. Default: ${DEFAULT_CONFIG_DIR}
  --fail-on-warn        Exit non-zero when any warning diagnostics are emitted.
  --json                Print machine-readable summary JSON.
  --verbose             Print warning diagnostic details in text output.
  -h, --help            Show this help.
`;

function assertArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_CLI_ARG_BYTES} bytes`);
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

export function parseArgs(argv: string[]): ValidateConfigsArgs {
  assertArgv(argv);

  const args: ValidateConfigsArgs = {
    cwd: process.cwd(),
    configDir: DEFAULT_CONFIG_DIR,
    failOnWarn: false,
    json: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--cwd") {
      args.cwd = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--config-dir") {
      args.configDir = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--fail-on-warn") {
      args.failOnWarn = true;
      continue;
    }

    if (current === "--json") {
      args.json = true;
      continue;
    }

    if (current === "--verbose") {
      args.verbose = true;
      continue;
    }

    if (current === "-h" || current === "--help") {
      args.help = true;
      continue;
    }

    if (current?.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current ?? ""}`);
  }

  return args;
}

export async function collectConfigPaths(cwd: string, configDir: string): Promise<string[]> {
  const absoluteConfigDir = path.resolve(cwd, configDir);
  const configPaths: string[] = [];
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;

  try {
    directory = await opendir(absoluteConfigDir);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      configPaths.push(path.join(absoluteConfigDir, entry.name));
      if (configPaths.length > MAX_CONFIG_FILES) {
        throw new Error(`Config directory must contain at most ${MAX_CONFIG_FILES} JSON files`);
      }
    }
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The async iterator closes the directory after normal completion.
      }
    }
  }

  configPaths.sort();

  if (configPaths.length === 0) {
    throw new Error(`No JSON config files found in ${absoluteConfigDir}`);
  }

  return configPaths;
}

function withSmokeAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const apiKeys =
    typeof env.RAY_API_KEYS === "string" && env.RAY_API_KEYS.trim().length > 0
      ? env.RAY_API_KEYS
      : DEFAULT_SMOKE_API_KEY;

  return {
    RAY_API_KEYS: apiKeys,
  };
}

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getConfigValue(config: ConfigRecord, keys: string[]): unknown {
  let current: unknown = config;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function formatExpectedValue(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function pushPublicConfigPolicyError(
  diagnostics: DeploymentDiagnostic[],
  code: string,
  message: string,
): void {
  diagnostics.push({
    level: "error",
    code,
    message,
  });
}

function expectPublicConfigValue(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  expected: string | number | boolean,
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (actual === expected) {
    return;
  }

  const label = keys.join(".");
  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare ${label}=${formatExpectedValue(expected)}.`,
  );
}

function expectPublicConfigString(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (typeof actual === "string" && actual.trim().length > 0) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare a non-empty ${keys.join(".")}.`,
  );
}

function expectPublicConfigEmptyArray(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (Array.isArray(actual) && actual.length === 0) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare ${keys.join(".")}=[].`,
  );
}

function expectPublicConfigStringArrayValue(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  expected: readonly string[],
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  ) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare ${keys.join(".")}=${JSON.stringify(expected)}.`,
  );
}

function expectPublicConfigAbsent(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (actual === undefined) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must not declare ${keys.join(".")}.`,
  );
}

function expectPublicConfigPositiveIntegerAtMost(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  max: number,
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (typeof actual === "number" && Number.isSafeInteger(actual) && actual > 0 && actual <= max) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare ${keys.join(".")} as a positive integer no greater than ${max}.`,
  );
}

function expectPublicConfigPositiveNumberAtMost(
  diagnostics: DeploymentDiagnostic[],
  config: ConfigRecord,
  keys: string[],
  max: number,
  code: string,
): void {
  const actual = getConfigValue(config, keys);

  if (typeof actual === "number" && Number.isFinite(actual) && actual > 0 && actual <= max) {
    return;
  }

  pushPublicConfigPolicyError(
    diagnostics,
    code,
    `Public example configs must explicitly declare ${keys.join(".")} as a positive number no greater than ${max}.`,
  );
}

async function diagnosePublicConfigPolicy(configPath: string): Promise<DeploymentDiagnostic[]> {
  const diagnostics: DeploymentDiagnostic[] = [];
  const publicFile = path.basename(configPath).endsWith(".public.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (publicFile) {
      pushPublicConfigPolicyError(
        diagnostics,
        "public_config_policy_unreadable",
        `Could not inspect public config policy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return diagnostics;
  }

  if (!isRecord(parsed)) {
    if (publicFile) {
      pushPublicConfigPolicyError(
        diagnostics,
        "public_config_policy_invalid",
        "Public example configs must be JSON objects.",
      );
    }
    return diagnostics;
  }

  const tags = getConfigValue(parsed, ["tags"]);
  const publicExposure = isRecord(tags) && tags.exposure === "public";
  if (!publicFile && !publicExposure) {
    return diagnostics;
  }

  expectPublicConfigString(diagnostics, parsed, ["profile"], "public_config_profile_explicit");
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["tags", "target"],
    "public_config_tag_target_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["tags", "hosting"],
    "public_config_tag_hosting_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["tags", "hardware"],
    "public_config_tag_hardware_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["tags", "engine"],
    "llama.cpp",
    "public_config_tag_engine_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["tags", "modelSize"],
    "public_config_tag_model_size_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["tags", "exposure"],
    "public",
    "public_config_tag_exposure_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["server", "host"],
    "127.0.0.1",
    "public_config_server_host_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["server", "port"],
    MAX_PUBLIC_SERVER_PORT,
    "public_config_server_port_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["server", "requestBodyLimitBytes"],
    MAX_PUBLIC_REQUEST_BODY_LIMIT_BYTES,
    "public_config_request_body_limit_explicit",
  );
  expectPublicConfigString(diagnostics, parsed, ["model", "id"], "public_config_model_id_explicit");
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["model", "family"],
    "public_config_model_family_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "quantization"],
    "q4_k_m",
    "public_config_model_quantization_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "contextWindow"],
    MAX_PUBLIC_MODEL_CONTEXT_WINDOW,
    "public_config_model_context_window_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "warmOnBoot"],
    true,
    "public_config_model_warm_on_boot_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "maxOutputTokens"],
    MAX_PUBLIC_MODEL_OUTPUT_TOKENS,
    "public_config_model_output_tokens_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "operational", "recommendedPromptFormat"],
    "native-template",
    "public_config_model_operational_prompt_format_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "operational", "supportsJsonMode"],
    true,
    "public_config_model_operational_json_mode_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "operational", "tokensPerSecondTarget"],
    MAX_PUBLIC_MODEL_OPERATIONAL_TOKENS_PER_SECOND,
    "public_config_model_operational_tps_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "operational", "memoryClassMiB"],
    MAX_PUBLIC_MODEL_OPERATIONAL_MEMORY_CLASS_MIB,
    "public_config_model_operational_memory_class_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "operational", "preferredCtxSize"],
    MAX_PUBLIC_MODEL_OPERATIONAL_CTX_SIZE,
    "public_config_model_operational_ctx_size_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "operational", "chatTemplateKnown"],
    true,
    "public_config_model_operational_chat_template_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "kind"],
    "llama.cpp",
    "public_config_model_adapter_kind_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "baseUrl"],
    PUBLIC_LLAMA_CPP_BASE_URL,
    "public_config_model_adapter_base_url_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["model", "adapter", "modelRef"],
    "public_config_model_adapter_ref_explicit",
  );
  expectPublicConfigAbsent(
    diagnostics,
    parsed,
    ["model", "adapter", "apiKeyEnv"],
    "public_config_model_adapter_api_key_env_absent",
  );
  expectPublicConfigAbsent(
    diagnostics,
    parsed,
    ["model", "adapter", "headers"],
    "public_config_model_adapter_headers_absent",
  );
  expectPublicConfigAbsent(
    diagnostics,
    parsed,
    ["model", "adapter", "slotId"],
    "public_config_model_adapter_slot_id_absent",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "timeoutMs"],
    MAX_PUBLIC_ADAPTER_TIMEOUT_MS,
    "public_config_model_adapter_timeout_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "cachePrompt"],
    true,
    "public_config_model_adapter_cache_prompt_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "slotStateTtlMs"],
    MAX_PUBLIC_ADAPTER_SLOT_STATE_TTL_MS,
    "public_config_model_adapter_slot_state_ttl_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "slotSnapshotTimeoutMs"],
    MAX_PUBLIC_ADAPTER_SLOT_SNAPSHOT_TIMEOUT_MS,
    "public_config_model_adapter_slot_snapshot_timeout_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "promptScaffoldCacheEntries"],
    MAX_PUBLIC_PROMPT_SCAFFOLD_CACHE_ENTRIES,
    "public_config_model_adapter_scaffold_cache_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "preset"],
    "public_config_model_launch_preset_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "binaryPath"],
    PUBLIC_LLAMA_CPP_BINARY_PATH,
    "public_config_model_launch_binary_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "modelPath"],
    "public_config_model_launch_model_path_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "host"],
    PUBLIC_LLAMA_CPP_HOST,
    "public_config_model_launch_host_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "port"],
    PUBLIC_LLAMA_CPP_PORT,
    "public_config_model_launch_port_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "alias"],
    "public_config_model_launch_alias_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "ctxSize"],
    MAX_PUBLIC_LLAMA_CTX_SIZE,
    "public_config_model_launch_ctx_size_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "parallel"],
    MAX_PUBLIC_LLAMA_PARALLEL,
    "public_config_model_launch_parallel_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "threads"],
    MAX_PUBLIC_LLAMA_THREADS,
    "public_config_model_launch_threads_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "threadsHttp"],
    MAX_PUBLIC_LLAMA_HTTP_THREADS,
    "public_config_model_launch_http_threads_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "batchSize"],
    MAX_PUBLIC_LLAMA_BATCH_SIZE,
    "public_config_model_launch_batch_size_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "ubatchSize"],
    MAX_PUBLIC_LLAMA_UBATCH_SIZE,
    "public_config_model_launch_ubatch_size_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "cachePrompt"],
    true,
    "public_config_model_launch_cache_prompt_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "cacheReuse"],
    MAX_PUBLIC_LLAMA_CACHE_REUSE,
    "public_config_model_launch_cache_reuse_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "cacheRamMiB"],
    MAX_PUBLIC_LLAMA_CACHE_RAM_MIB,
    "public_config_model_launch_cache_ram_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "continuousBatching"],
    true,
    "public_config_model_launch_continuous_batching_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "enableMetrics"],
    true,
    "public_config_model_launch_metrics_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "exposeSlots"],
    true,
    "public_config_model_launch_slots_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "warmup"],
    true,
    "public_config_model_launch_warmup_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "enableUnifiedKv"],
    true,
    "public_config_model_launch_unified_kv_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "cacheIdleSlots"],
    true,
    "public_config_model_launch_idle_slot_cache_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "contextShift"],
    true,
    "public_config_model_launch_context_shift_explicit",
  );
  expectPublicConfigAbsent(
    diagnostics,
    parsed,
    ["model", "adapter", "launchProfile", "extraArgs"],
    "public_config_model_launch_extra_args_absent",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["auth", "enabled"],
    true,
    "public_config_auth_enabled_explicit",
  );
  expectPublicConfigString(
    diagnostics,
    parsed,
    ["auth", "apiKeyEnv"],
    "public_config_auth_key_env_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["rateLimit", "enabled"],
    true,
    "public_config_rate_limit_enabled_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["rateLimit", "windowMs"],
    MAX_PUBLIC_RATE_LIMIT_WINDOW_MS,
    "public_config_rate_limit_window_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["rateLimit", "maxRequests"],
    MAX_PUBLIC_RATE_LIMIT_REQUESTS,
    "public_config_rate_limit_requests_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["rateLimit", "maxKeys"],
    MAX_PUBLIC_RATE_LIMIT_KEYS,
    "public_config_rate_limit_keys_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["rateLimit", "keyStrategy"],
    "ip+api-key",
    "public_config_rate_limit_key_strategy_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["rateLimit", "trustProxyHeaders"],
    true,
    "public_config_rate_limit_proxy_headers_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["telemetry", "serviceName"],
    "ray-gateway",
    "public_config_telemetry_service_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["telemetry", "logLevel"],
    "info",
    "public_config_telemetry_log_level_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["telemetry", "includeDebugMetrics"],
    true,
    "public_config_telemetry_debug_metrics_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["telemetry", "slowRequestThresholdMs"],
    MAX_PUBLIC_TELEMETRY_SLOW_REQUEST_MS,
    "public_config_telemetry_slow_request_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "concurrency"],
    MAX_PUBLIC_SCHEDULER_CONCURRENCY,
    "public_config_scheduler_concurrency_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "maxQueue"],
    MAX_PUBLIC_SCHEDULER_QUEUE_DEPTH,
    "public_config_scheduler_max_queue_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "maxQueuedTokens"],
    MAX_PUBLIC_SCHEDULER_QUEUED_TOKENS,
    "public_config_scheduler_queued_tokens_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "maxInflightTokens"],
    MAX_PUBLIC_SCHEDULER_INFLIGHT_TOKENS,
    "public_config_scheduler_inflight_tokens_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "requestTimeoutMs"],
    MAX_PUBLIC_SCHEDULER_REQUEST_TIMEOUT_MS,
    "public_config_scheduler_request_timeout_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["scheduler", "dedupeInflight"],
    true,
    "public_config_scheduler_dedupe_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "batchWindowMs"],
    MAX_PUBLIC_SCHEDULER_BATCH_WINDOW_MS,
    "public_config_scheduler_batch_window_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "affinityLookahead"],
    MAX_PUBLIC_SCHEDULER_AFFINITY_LOOKAHEAD,
    "public_config_scheduler_affinity_lookahead_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["scheduler", "shortJobMaxTokens"],
    MAX_PUBLIC_SCHEDULER_SHORT_JOB_TOKENS,
    "public_config_scheduler_short_job_tokens_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["asyncQueue", "enabled"],
    true,
    "public_config_async_queue_enabled_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["asyncQueue", "storageDir"],
    PUBLIC_ASYNC_QUEUE_STORAGE_DIR,
    "public_config_async_queue_storage_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "maxJobs"],
    MAX_PUBLIC_ASYNC_QUEUE_JOBS,
    "public_config_async_queue_max_jobs_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "minFreeStorageMiB"],
    MAX_PUBLIC_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB,
    "public_config_async_queue_storage_reserve_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "completedTtlMs"],
    MAX_PUBLIC_ASYNC_QUEUE_COMPLETED_TTL_MS,
    "public_config_async_queue_completed_ttl_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "pollIntervalMs"],
    MAX_PUBLIC_ASYNC_QUEUE_POLL_INTERVAL_MS,
    "public_config_async_queue_poll_interval_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "dispatchConcurrency"],
    MAX_PUBLIC_ASYNC_QUEUE_DISPATCH_CONCURRENCY,
    "public_config_async_queue_dispatch_concurrency_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "maxAttempts"],
    MAX_PUBLIC_ASYNC_QUEUE_ATTEMPTS,
    "public_config_async_queue_max_attempts_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "callbackTimeoutMs"],
    MAX_PUBLIC_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS,
    "public_config_async_queue_callback_timeout_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["asyncQueue", "maxCallbackAttempts"],
    MAX_PUBLIC_ASYNC_QUEUE_CALLBACK_ATTEMPTS,
    "public_config_async_queue_callback_attempts_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["asyncQueue", "callbackAllowPrivateNetwork"],
    false,
    "public_config_async_queue_private_callbacks_explicit",
  );
  expectPublicConfigEmptyArray(
    diagnostics,
    parsed,
    ["asyncQueue", "callbackAllowedHosts"],
    "public_config_async_queue_callback_hosts_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["cache", "enabled"],
    true,
    "public_config_cache_enabled_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["cache", "maxEntries"],
    MAX_PUBLIC_CACHE_ENTRIES,
    "public_config_cache_entries_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["cache", "maxBytes"],
    MAX_PUBLIC_CACHE_BYTES,
    "public_config_cache_bytes_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["cache", "ttlMs"],
    MAX_PUBLIC_CACHE_TTL_MS,
    "public_config_cache_ttl_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["cache", "keyStrategy"],
    "input+params",
    "public_config_cache_key_strategy_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["gracefulDegradation", "enabled"],
    true,
    "public_config_degradation_enabled_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "queueDepthThreshold"],
    MAX_PUBLIC_DEGRADATION_QUEUE_DEPTH,
    "public_config_degradation_queue_depth_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "maxPromptChars"],
    MAX_PUBLIC_DEGRADATION_PROMPT_CHARS,
    "public_config_degradation_prompt_chars_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "degradeToMaxTokens"],
    MAX_PUBLIC_DEGRADATION_TOKENS,
    "public_config_degradation_tokens_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "memoryRssThresholdMiB"],
    MAX_PUBLIC_DEGRADATION_MEMORY_RSS_MIB,
    "public_config_degradation_memory_rss_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "memoryCgroupPressureRatioThreshold"],
    MAX_PUBLIC_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO,
    "public_config_degradation_memory_cgroup_pressure_ratio_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "cpuThrottledRatioThreshold"],
    MAX_PUBLIC_DEGRADATION_CPU_THROTTLED_RATIO,
    "public_config_degradation_cpu_throttled_ratio_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "memoryPsiSomeAvg10Threshold"],
    MAX_PUBLIC_DEGRADATION_PSI_AVG10_THRESHOLD,
    "public_config_degradation_memory_psi_some_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "memoryPsiFullAvg10Threshold"],
    MAX_PUBLIC_DEGRADATION_PSI_AVG10_THRESHOLD,
    "public_config_degradation_memory_psi_full_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "cpuPsiSomeAvg10Threshold"],
    MAX_PUBLIC_DEGRADATION_PSI_AVG10_THRESHOLD,
    "public_config_degradation_cpu_psi_some_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["gracefulDegradation", "cpuPsiFullAvg10Threshold"],
    MAX_PUBLIC_DEGRADATION_PSI_AVG10_THRESHOLD,
    "public_config_degradation_cpu_psi_full_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["promptCompiler", "enabled"],
    true,
    "public_config_prompt_compiler_enabled_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["promptCompiler", "collapseWhitespace"],
    true,
    "public_config_prompt_compiler_collapse_whitespace_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["promptCompiler", "dedupeRepeatedLines"],
    true,
    "public_config_prompt_compiler_dedupe_lines_explicit",
  );
  expectPublicConfigStringArrayValue(
    diagnostics,
    parsed,
    ["promptCompiler", "familyMetadataKeys"],
    PUBLIC_PROMPT_COMPILER_FAMILY_KEYS,
    "public_config_prompt_compiler_family_keys_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["adaptiveTuning", "enabled"],
    true,
    "public_config_adaptive_enabled_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "sampleSize"],
    MAX_PUBLIC_ADAPTIVE_SAMPLE_SIZE,
    "public_config_adaptive_sample_size_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "queueLatencyThresholdMs"],
    MAX_PUBLIC_ADAPTIVE_QUEUE_LATENCY_MS,
    "public_config_adaptive_queue_latency_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "minCompletionTokensPerSecond"],
    MAX_PUBLIC_ADAPTIVE_MIN_TOKENS_PER_SECOND,
    "public_config_adaptive_min_tps_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "maxOutputReductionRatio"],
    MAX_PUBLIC_ADAPTIVE_OUTPUT_REDUCTION_RATIO,
    "public_config_adaptive_reduction_ratio_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "minOutputTokens"],
    MAX_PUBLIC_ADAPTIVE_MIN_OUTPUT_TOKENS,
    "public_config_adaptive_min_output_tokens_explicit",
  );
  expectPublicConfigValue(
    diagnostics,
    parsed,
    ["adaptiveTuning", "learnedFamilyCapEnabled"],
    true,
    "public_config_adaptive_learned_cap_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "familyHistorySize"],
    MAX_PUBLIC_ADAPTIVE_FAMILY_HISTORY_SIZE,
    "public_config_adaptive_family_history_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "learnedCapMinSamples"],
    MAX_PUBLIC_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES,
    "public_config_adaptive_learned_cap_samples_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "draftPercentile"],
    MAX_PUBLIC_ADAPTIVE_DRAFT_PERCENTILE,
    "public_config_adaptive_draft_percentile_explicit",
  );
  expectPublicConfigPositiveNumberAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "shortPercentile"],
    MAX_PUBLIC_ADAPTIVE_SHORT_PERCENTILE,
    "public_config_adaptive_short_percentile_explicit",
  );
  expectPublicConfigPositiveIntegerAtMost(
    diagnostics,
    parsed,
    ["adaptiveTuning", "learnedCapHeadroomTokens"],
    MAX_PUBLIC_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS,
    "public_config_adaptive_headroom_tokens_explicit",
  );

  return diagnostics;
}

export async function validateConfigFiles(options: {
  cwd: string;
  configPaths: string[];
  env?: NodeJS.ProcessEnv;
  failOnWarn?: boolean;
}): Promise<ConfigValidationSummary> {
  const env = withSmokeAuthEnv(options.env ?? process.env);
  const results: ConfigValidationResult[] = [];

  for (const configPath of options.configPaths) {
    try {
      const inspected = await loadAndDiagnoseDeployment({
        cwd: options.cwd,
        configPath,
        env,
        inspectHostStorage: false,
      });
      const diagnostics = [
        ...inspected.diagnostics,
        ...(await diagnosePublicConfigPolicy(configPath)),
      ];
      const errorCount = diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
      const warningCount = diagnostics.filter((diagnostic) => diagnostic.level === "warn").length;

      results.push({
        configPath,
        profile: inspected.config.profile,
        diagnostics,
        errorCount,
        warningCount,
      });
    } catch (error) {
      results.push({
        configPath,
        diagnostics: [
          {
            level: "error",
            code: "config_validation_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        errorCount: 1,
        warningCount: 0,
      });
    }
  }

  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
  const warningCount = results.reduce((total, result) => total + result.warningCount, 0);
  const failOnWarn = options.failOnWarn ?? false;

  return {
    ok: errorCount === 0 && (!failOnWarn || warningCount === 0),
    failOnWarn,
    configCount: results.length,
    errorCount,
    warningCount,
    results,
  };
}

function displayPath(cwd: string, configPath: string): string {
  const relativePath = path.relative(cwd, configPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : configPath;
}

export function formatTextSummary(
  cwd: string,
  summary: ConfigValidationSummary,
  options: { verbose?: boolean } = {},
): string {
  const lines = [
    `Validated ${summary.configCount} Ray config file${summary.configCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status =
      result.errorCount > 0
        ? "FAIL"
        : summary.failOnWarn && result.warningCount > 0
          ? "WARN"
          : "OK";
    const profile = result.profile ? ` profile=${result.profile}` : "";
    lines.push(
      `- ${status} ${displayPath(cwd, result.configPath)}${profile} warnings=${result.warningCount} errors=${result.errorCount}`,
    );

    for (const diagnostic of result.diagnostics) {
      if (diagnostic.level === "info") {
        continue;
      }
      if (diagnostic.level === "warn" && !options.verbose && !summary.failOnWarn) {
        continue;
      }
      lines.push(`  ${diagnostic.level} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  if (summary.warningCount > 0 && !options.verbose && !summary.failOnWarn) {
    lines.push("Run with --verbose to print warning diagnostics.");
  }

  lines.push(
    `Summary: warnings=${summary.warningCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
  );

  return lines.join("\n");
}

export async function runValidateConfigsCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const cwd = path.resolve(args.cwd);
    const configPaths = await collectConfigPaths(cwd, args.configDir);
    const summary = await validateConfigFiles({
      cwd,
      configPaths,
      env,
      failOnWarn: args.failOnWarn,
    });

    io.stdout.write(
      args.json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `${formatTextSummary(cwd, summary, { verbose: args.verbose })}\n`,
    );
    return summary.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runValidateConfigsCli();
}
