import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  chown,
  copyFile,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadRayConfig } from "../packages/config/src/index.ts";
import { parseEnvironmentFile } from "../packages/deploy/src/cli.ts";
import { estimateLlamaCppMemoryFit } from "../packages/deploy/src/index.ts";

const DEFAULT_CONFIG_PATH = "./examples/config/ray.sub1b.public.json";
const DEFAULT_SERVICE_USER = "ray";
const PLACEHOLDER_BINARY_SOURCE_PATH = "/path/to/llama-server";
const PLACEHOLDER_SOURCE_PATH = "/path/to/model.gguf";
const BINARY_SOURCE_ENV = "RAY_LLAMA_CPP_BINARY_SOURCE_PATH";
const BINARY_SHA256_ENV = "RAY_LLAMA_CPP_BINARY_SHA256";
const MODEL_SOURCE_ENV = "RAY_MODEL_SOURCE_PATH";
const MODEL_SHA256_ENV = "RAY_MODEL_SHA256";
const MAX_CLI_ARGS = 28;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const PRINCIPAL_LOOKUP_TIMEOUT_MS = 3_000;
const PRINCIPAL_LOOKUP_MAX_BUFFER_BYTES = 16 * 1024;
const MODEL_READ_CHECK_TIMEOUT_MS = 3_000;
const MODEL_READ_CHECK_MAX_BUFFER_BYTES = 16 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const MAX_LLAMA_CPP_BINARY_SOURCE_BYTES = 512 * BYTES_PER_MIB;
const MAX_LLAMA_CPP_BINARY_SOURCE_MIB = MAX_LLAMA_CPP_BINARY_SOURCE_BYTES / BYTES_PER_MIB;
const MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB = 256;
const GGUF_MAGIC = "GGUF";
const LLAMA_CPP_BINARY_SMOKE_TIMEOUT_SECONDS = 5;
const LLAMA_CPP_BINARY_SMOKE_TIMEOUT_MS = LLAMA_CPP_BINARY_SMOKE_TIMEOUT_SECONDS * 1000;
const LLAMA_CPP_BINARY_SMOKE_MAX_BUFFER_BYTES = 64 * 1024;
const STAGE_INSPECT_TIMEOUT_SECONDS = 30;
const STAGE_QUICK_TIMEOUT_SECONDS = 60;
const STAGE_BINARY_COPY_TIMEOUT_SECONDS = 120;
const STAGE_BINARY_CHECKSUM_TIMEOUT_SECONDS = 120;
const STAGE_MODEL_COPY_TIMEOUT_SECONDS = 1_800;
const STAGE_MODEL_CHECKSUM_TIMEOUT_SECONDS = 1_800;
const STAGE_SERVICE_PROBE_TIMEOUT_SECONDS = LLAMA_CPP_BINARY_SMOKE_TIMEOUT_SECONDS + 10;
const MAX_PROCESS_OUTPUT_CHARS = 1_000;
const SYSTEMD_PRINCIPAL_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const NUMERIC_PRINCIPAL_PATTERN = /^[0-9]{1,10}$/;
const ATOMIC_STAGE_TEMP_PREFIX = ".ray-stage-";
const STALE_ATOMIC_STAGE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ATOMIC_STAGE_TEMP_DISCOVERY_ENTRIES = 2_048;
const MAX_ATOMIC_STAGE_TEMP_REMOVALS = 256;
const MAX_ATOMIC_STAGE_TEMP_PATH_BYTES = 4_096;

const execFileAsync = promisify(execFile);

export interface ModelStageArgs {
  cwd: string;
  configPath: string;
  envFile?: string;
  serviceUser?: string;
  serviceGroup?: string;
  binarySourcePath?: string;
  binarySha256?: string;
  sourcePath?: string;
  sha256?: string;
  json: boolean;
  commandsOnly: boolean;
  checkSources: boolean;
  apply: boolean;
  help: boolean;
}

export interface ModelStagePlan {
  configPath: string;
  profile?: string;
  modelId: string;
  adapterKind: string;
  modelRef: string;
  alias: string;
  binaryPath: string;
  binaryDirectory: string;
  modelPath: string;
  modelDirectory: string;
  host: string;
  port: number;
  serviceUser: string;
  serviceGroup: string;
  binarySourcePath?: string;
  binarySha256?: string;
  sourcePath?: string;
  sha256?: string;
  memoryBudgetMiB?: number;
  memoryBudgetSource?: "env" | "config";
  safeMemoryBudgetMiB?: number;
  nonModelWorkingSetMiB?: number;
  commands: string[];
}

export interface ModelStageApplyResult {
  applied: true;
  binaryPath: string;
  binaryProbeStatus: "ok";
  modelPath: string;
  modelReadStatus: "ok";
  serviceUser: string;
  serviceGroup: string;
}

export interface ModelStageStorageHeadroom {
  sourceMiB: number;
  reserveMiB: number;
  requiredMiB: number;
  availableMiB: number;
  ok: boolean;
}

export interface ModelStageJsonApplyResult {
  applied: true;
  binaryProbeStatus: "ok";
  modelReadStatus: "ok";
  plan: ModelStagePlan;
}

export interface ModelStageStorageStats {
  bavail?: number | bigint;
  bsize?: number | bigint;
  blocks?: number | bigint;
  ffree?: number | bigint;
}

export interface ModelStageMemoryFit {
  sourceMiB: number;
  nonModelWorkingSetMiB: number;
  projectedWorkingSetMiB: number;
  safeMemoryBudgetMiB: number;
  memoryBudgetMiB: number;
  memoryBudgetSource: "env" | "config";
  ok: boolean;
}

const HELP = `Stage local artifacts for a generated Ray llama.cpp service.

Usage:
  bun ./scripts/model-stage.ts [options]

Options:
  --cwd <path>             Repository root. Default: current directory.
  --config <path>          Ray config to inspect. Default: ${DEFAULT_CONFIG_PATH}
  --env-file <path>        Load Ray/deploy overrides from a dotenv-style file.
  --ray-env-file <path>    Alias for --env-file.
  --user <name|uid>        Generated systemd service user. Default: RAY_DEPLOY_SERVICE_USER or ${DEFAULT_SERVICE_USER}.
  --group <name|gid>       Group that should own the GGUF. Default: same as --user.
  --binary-source <path>   Local llama-server path to install into the configured binary path.
  --binary-sha256 <hex>    Expected SHA-256 for the installed llama-server binary.
  --source <path>          Local GGUF path to install into the configured model path.
  --sha256 <hex>           Expected SHA-256 for the installed GGUF.
  --check-sources          Verify source artifacts and provided checksums before printing the plan.
  --apply                  Install verified source artifacts into the resolved binary/model paths.
  --commands-only          Print only shell commands, one per line.
  --json                   Print machine-readable staging plan JSON.
  -h, --help               Show this help.

Artifact source paths and checksums may also come from ${BINARY_SOURCE_ENV},
${BINARY_SHA256_ENV}, ${MODEL_SOURCE_ENV}, and ${MODEL_SHA256_ENV}. CLI flags win.
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

function normalizeServicePrincipal(value: string, label: string): string {
  if (!SYSTEMD_PRINCIPAL_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a system account name, group name, numeric UID, or numeric GID using only letters, digits, underscores, or hyphens`,
    );
  }

  return value;
}

function readNonEmptyEnvValue(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOptionalPositiveIntegerEnv(
  value: string | undefined,
  label: string,
): number | undefined {
  const normalized = readNonEmptyEnvValue(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function resolvePresetMemoryBudgetMiB(preset: string): number {
  switch (preset) {
    case "single-vps-sub1b":
    case "single-vps-sub1b-cx23":
    case "single-vps-sub1b-cax11":
    case "single-vps-1b-cx23":
      return 4096;
    default:
      return 8192;
  }
}

function normalizeOptionalPath(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty path without surrounding whitespace`);
  }

  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must not contain control characters`);
  }

  return value;
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 64-character hexadecimal SHA-256 digest`);
  }

  return normalized;
}

export function parseArgs(argv: string[]): ModelStageArgs {
  assertArgv(argv);

  const args: ModelStageArgs = {
    cwd: process.cwd(),
    configPath: DEFAULT_CONFIG_PATH,
    json: false,
    commandsOnly: false,
    checkSources: false,
    apply: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--cwd") {
      args.cwd = normalizeOptionalPath(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--config") {
      args.configPath = normalizeOptionalPath(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--env-file" || current === "--ray-env-file") {
      args.envFile = normalizeOptionalPath(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--user") {
      args.serviceUser = normalizeServicePrincipal(
        requireFlagValue(current, argv[index + 1]),
        current,
      );
      index += 1;
      continue;
    }

    if (current === "--group") {
      args.serviceGroup = normalizeServicePrincipal(
        requireFlagValue(current, argv[index + 1]),
        current,
      );
      index += 1;
      continue;
    }

    if (current === "--source") {
      args.sourcePath = normalizeOptionalPath(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--binary-source") {
      args.binarySourcePath = normalizeOptionalPath(
        requireFlagValue(current, argv[index + 1]),
        current,
      );
      index += 1;
      continue;
    }

    if (current === "--binary-sha256") {
      args.binarySha256 = normalizeSha256(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--sha256") {
      args.sha256 = normalizeSha256(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--json") {
      args.json = true;
      continue;
    }

    if (current === "--commands-only") {
      args.commandsOnly = true;
      continue;
    }

    if (current === "--check-sources") {
      args.checkSources = true;
      continue;
    }

    if (current === "--apply") {
      args.apply = true;
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

  if (args.json && args.commandsOnly) {
    throw new Error("--json and --commands-only cannot be used together");
  }

  if (args.apply && args.commandsOnly) {
    throw new Error("--apply and --commands-only cannot be used together");
  }

  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readEnvironmentFileBounded(envFile: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(envFile, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`Env file path must be a file: ${envFile}`);
    }

    if (stats.size > MAX_ENV_FILE_BYTES) {
      throw new Error(`Env file must be at most ${MAX_ENV_FILE_BYTES} bytes: ${envFile}`);
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function loadStageEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  envFile: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  if (!envFile) {
    return baseEnv;
  }

  const contents = await readEnvironmentFileBounded(envFile);
  return {
    ...baseEnv,
    ...parseEnvironmentFile(contents),
  };
}

function buildStageCommands(plan: Omit<ModelStagePlan, "commands">): string[] {
  const binarySourcePath = plan.binarySourcePath ?? PLACEHOLDER_BINARY_SOURCE_PATH;
  const sourcePath = plan.sourcePath ?? PLACEHOLDER_SOURCE_PATH;
  const owner = `${plan.serviceUser}:${plan.serviceGroup}`;
  const binarySourcePreflight = `binary_source_bytes="$(timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s stat -c %s -- ${shellQuote(
    binarySourcePath,
  )})" || exit "$?"; test "\${binary_source_bytes:-0}" -le ${MAX_LLAMA_CPP_BINARY_SOURCE_BYTES} || { printf '%s\\n' ${shellQuote(
    `llama-server source must be at most ${MAX_LLAMA_CPP_BINARY_SOURCE_MIB} MiB before copying to ${plan.binaryPath}.`,
  )} >&2; exit 1; }`;
  const binaryChecksumPreflight = plan.binarySha256
    ? `printf '%s  %s\\n' ${shellQuote(plan.binarySha256)} ${shellQuote(binarySourcePath)} | timeout ${STAGE_BINARY_CHECKSUM_TIMEOUT_SECONDS}s sha256sum -c -`
    : undefined;
  const modelStoragePreflight = `du_output="$(timeout ${STAGE_QUICK_TIMEOUT_SECONDS}s du -m ${shellQuote(
    sourcePath,
  )})" || exit "$?"; df_output="$(timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s df -Pm ${shellQuote(
    plan.modelDirectory,
  )})" || exit "$?"; required_mib="$(printf '%s\\n' "$du_output" | awk 'NR==1 {print $1 + ${MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB}}')"; available_mib="$(printf '%s\\n' "$df_output" | awk 'NR==2 {print $4}')"; test "\${available_mib:-0}" -ge "\${required_mib:-0}" || { printf '%s\\n' ${shellQuote(
    `Not enough free space in ${plan.modelDirectory}: keep at least ${MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB} MiB free after copying the GGUF.`,
  )} >&2; exit 1; }`;
  const modelFormatPreflight = `magic="$(timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s head -c ${GGUF_MAGIC.length} -- ${shellQuote(
    sourcePath,
  )})" || exit "$?"; test "$magic" = ${shellQuote(GGUF_MAGIC)} || { printf '%s\\n' ${shellQuote(
    `GGUF source does not start with the ${GGUF_MAGIC} header: ${sourcePath}`,
  )} >&2; exit 1; }`;
  const modelMemoryPreflight =
    plan.memoryBudgetMiB !== undefined &&
    plan.memoryBudgetSource !== undefined &&
    plan.safeMemoryBudgetMiB !== undefined &&
    plan.nonModelWorkingSetMiB !== undefined
      ? `source_bytes="$(timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s stat -c %s -- ${shellQuote(
          sourcePath,
        )})" || exit "$?"; source_mib="$(((\${source_bytes:-0} + ${BYTES_PER_MIB - 1}) / ${BYTES_PER_MIB}))"; test "$source_mib" -ge 1 || source_mib=1; projected_mib="$((source_mib + ${plan.nonModelWorkingSetMiB}))"; test "$projected_mib" -le ${plan.safeMemoryBudgetMiB} || { printf '%s\\n' "Projected llama.cpp working set would be \${projected_mib} MiB, above the safe budget of ${plan.safeMemoryBudgetMiB} MiB on the ${plan.memoryBudgetMiB} MiB ${plan.memoryBudgetSource} memory target. Use a smaller GGUF or reduce cache/context before staging." >&2; exit 1; }`
      : undefined;
  const modelChecksumPreflight = plan.sha256
    ? `printf '%s  %s\\n' ${shellQuote(plan.sha256)} ${shellQuote(sourcePath)} | timeout ${STAGE_MODEL_CHECKSUM_TIMEOUT_SECONDS}s sha256sum -c -`
    : undefined;
  const commands = [
    `timeout ${STAGE_QUICK_TIMEOUT_SECONDS}s sudo install -d -m 0755 ${shellQuote(plan.binaryDirectory)}`,
    binarySourcePreflight,
    ...(binaryChecksumPreflight ? [binaryChecksumPreflight] : []),
    `timeout ${STAGE_BINARY_COPY_TIMEOUT_SECONDS}s sudo install -D -m 0755 -- ${shellQuote(binarySourcePath)} ${shellQuote(plan.binaryPath)}`,
    `timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s sudo -u ${shellQuote(plan.serviceUser)} test -x ${shellQuote(plan.binaryPath)}`,
    `timeout ${STAGE_SERVICE_PROBE_TIMEOUT_SECONDS}s sudo -u ${shellQuote(plan.serviceUser)} timeout ${LLAMA_CPP_BINARY_SMOKE_TIMEOUT_SECONDS}s ${shellQuote(plan.binaryPath)} --help >/dev/null`,
    `timeout ${STAGE_QUICK_TIMEOUT_SECONDS}s sudo install -d -m 0755 ${shellQuote(plan.modelDirectory)}`,
    ...(modelMemoryPreflight ? [modelMemoryPreflight] : []),
    modelStoragePreflight,
    modelFormatPreflight,
    ...(modelChecksumPreflight ? [modelChecksumPreflight] : []),
    `timeout ${STAGE_MODEL_COPY_TIMEOUT_SECONDS}s sudo install -D -m 0640 -- ${shellQuote(sourcePath)} ${shellQuote(plan.modelPath)}`,
    `timeout ${STAGE_QUICK_TIMEOUT_SECONDS}s sudo chown ${shellQuote(owner)} ${shellQuote(plan.modelPath)}`,
    `timeout ${STAGE_INSPECT_TIMEOUT_SECONDS}s sudo -u ${shellQuote(plan.serviceUser)} test -r ${shellQuote(plan.modelPath)}`,
  ];

  return commands;
}

export async function createModelStagePlan(options: {
  cwd: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  serviceUser?: string;
  serviceGroup?: string;
  binarySourcePath?: string;
  binarySha256?: string;
  sourcePath?: string;
  sha256?: string;
}): Promise<ModelStagePlan> {
  const cwd = path.resolve(options.cwd);
  const env = await loadStageEnvironment(options.env ?? process.env, options.envFile);
  const loaded = await loadRayConfig({
    cwd,
    configPath: options.configPath,
    env,
  });
  const adapter = loaded.config.model.adapter;

  if (adapter.kind !== "llama.cpp" || !adapter.launchProfile) {
    throw new Error("Model staging requires a llama.cpp adapter with model.adapter.launchProfile");
  }

  const envServiceUser = readNonEmptyEnvValue(env.RAY_DEPLOY_SERVICE_USER);
  const serviceUser = normalizeServicePrincipal(
    options.serviceUser ?? envServiceUser ?? DEFAULT_SERVICE_USER,
    "service user",
  );
  const serviceGroup = normalizeServicePrincipal(
    options.serviceGroup ?? serviceUser,
    "service group",
  );
  const modelPath = normalizeOptionalPath(adapter.launchProfile.modelPath, "model path");
  const binaryPath = normalizeOptionalPath(adapter.launchProfile.binaryPath, "binary path");
  const binarySourcePathValue =
    options.binarySourcePath ?? readNonEmptyEnvValue(env[BINARY_SOURCE_ENV]);
  const binarySha256Value = options.binarySha256 ?? readNonEmptyEnvValue(env[BINARY_SHA256_ENV]);
  const sourcePathValue = options.sourcePath ?? readNonEmptyEnvValue(env[MODEL_SOURCE_ENV]);
  const sha256Value = options.sha256 ?? readNonEmptyEnvValue(env[MODEL_SHA256_ENV]);
  const binarySourcePath = binarySourcePathValue
    ? normalizeOptionalPath(binarySourcePathValue, "binary source path")
    : undefined;
  const binarySha256 = binarySha256Value
    ? normalizeSha256(
        binarySha256Value,
        options.binarySha256 ? "--binary-sha256" : BINARY_SHA256_ENV,
      )
    : undefined;
  const sourcePath = sourcePathValue
    ? normalizeOptionalPath(sourcePathValue, "source path")
    : undefined;
  const sha256 = sha256Value
    ? normalizeSha256(sha256Value, options.sha256 ? "--sha256" : MODEL_SHA256_ENV)
    : undefined;
  const memoryBudgetOverrideMiB = parseOptionalPositiveIntegerEnv(
    env.RAY_DEPLOY_MEMORY_MIB,
    "RAY_DEPLOY_MEMORY_MIB",
  );
  const memoryBudgetMiB =
    memoryBudgetOverrideMiB ??
    loaded.config.model.operational?.memoryClassMiB ??
    resolvePresetMemoryBudgetMiB(adapter.launchProfile.preset);
  const memoryBudgetSource =
    memoryBudgetOverrideMiB !== undefined ? ("env" as const) : ("config" as const);
  const memoryEstimate = estimateLlamaCppMemoryFit(loaded.config, adapter.launchProfile, {
    memoryBudgetMiB,
    memoryBudgetSource: memoryBudgetSource === "env" ? "override" : "preset",
    modelFileBytes: 0,
  });

  const planWithoutCommands: Omit<ModelStagePlan, "commands"> = {
    configPath: loaded.configPath ?? path.resolve(cwd, options.configPath),
    profile: loaded.config.profile,
    modelId: loaded.config.model.id,
    adapterKind: adapter.kind,
    modelRef: adapter.modelRef,
    alias: adapter.launchProfile.alias,
    binaryPath,
    binaryDirectory: path.dirname(binaryPath),
    modelPath,
    modelDirectory: path.dirname(modelPath),
    host: adapter.launchProfile.host,
    port: adapter.launchProfile.port,
    serviceUser,
    serviceGroup,
    ...(binarySourcePath ? { binarySourcePath } : {}),
    ...(binarySha256 ? { binarySha256 } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sha256 ? { sha256 } : {}),
    memoryBudgetMiB,
    memoryBudgetSource,
    ...(memoryEstimate
      ? {
          safeMemoryBudgetMiB: memoryEstimate.safeBudgetMiB,
          nonModelWorkingSetMiB: memoryEstimate.projectedWorkingSetMiB,
        }
      : {}),
  };

  return {
    ...planWithoutCommands,
    commands: buildStageCommands(planWithoutCommands),
  };
}

function displayPath(cwd: string, filePath: string): string {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

export function formatTextPlan(cwd: string, plan: ModelStagePlan): string {
  const lines = [
    "Ray llama.cpp artifact staging plan:",
    `- config: ${displayPath(cwd, plan.configPath)}${plan.profile ? ` profile=${plan.profile}` : ""}`,
    `- model: id=${plan.modelId} ref=${plan.modelRef} alias=${plan.alias}`,
    `- backend: ${plan.adapterKind} ${plan.host}:${plan.port} binary=${plan.binaryPath}`,
    `- target GGUF: ${plan.modelPath}`,
    `- service owner: ${plan.serviceUser}:${plan.serviceGroup}`,
  ];

  if (plan.binarySourcePath) {
    lines.push(`- binary source: ${plan.binarySourcePath}`);
  } else {
    lines.push(
      `- binary source: pass --binary-source ${PLACEHOLDER_BINARY_SOURCE_PATH} to print a concrete install command`,
    );
  }

  if (plan.sourcePath) {
    lines.push(`- source GGUF: ${plan.sourcePath}`);
  } else {
    lines.push(
      `- source GGUF: pass --source ${PLACEHOLDER_SOURCE_PATH} to print a concrete copy command`,
    );
  }

  if (plan.sha256) {
    lines.push(`- expected sha256: ${plan.sha256}`);
  }

  if (plan.binarySha256) {
    lines.push(`- expected binary sha256: ${plan.binarySha256}`);
  }

  if (
    plan.memoryBudgetMiB !== undefined &&
    plan.safeMemoryBudgetMiB !== undefined &&
    plan.nonModelWorkingSetMiB !== undefined
  ) {
    lines.push(
      `- memory target: ${plan.memoryBudgetMiB} MiB ${plan.memoryBudgetSource} target, ${plan.safeMemoryBudgetMiB} MiB safe budget, ${plan.nonModelWorkingSetMiB} MiB non-model working set`,
    );
  }

  lines.push("", "Run on the VPS:");
  for (const command of plan.commands) {
    lines.push(command);
  }

  lines.push("", "Then run doctor on the VPS before restarting ray-llama-cpp.service.");

  return lines.join("\n");
}

export function formatCommandPlan(plan: ModelStagePlan): string {
  return plan.commands.join("\n");
}

function resolveSourceCheckPath(cwd: string, sourcePath: string): string {
  return path.isAbsolute(sourcePath) ? sourcePath : path.resolve(cwd, sourcePath);
}

function resolveStageTargetPath(cwd: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
}

function assertFileSizeAtMost(
  actualBytes: number,
  maxBytes: number,
  label: string,
  filePath: string,
): void {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    throw new Error(`${label} size could not be inspected at ${filePath}`);
  }

  if (actualBytes > maxBytes) {
    throw new Error(
      `${label} must be at most ${MAX_LLAMA_CPP_BINARY_SOURCE_MIB} MiB at ${filePath}`,
    );
  }
}

async function assertRegularReadableFile(filePath: string, label: string) {
  const stats = await stat(filePath).catch((error: unknown) => {
    throw new Error(
      `${label} was not found at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }

  await access(filePath, constants.R_OK).catch((error: unknown) => {
    throw new Error(
      `${label} is not readable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return stats;
}

async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function assertGgufMagicHeader(filePath: string, label: string): Promise<void> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const magic = Buffer.from(GGUF_MAGIC, "ascii");
    const buffer = Buffer.alloc(magic.length);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);

    if (bytesRead < magic.length) {
      throw new Error(`file is smaller than the ${GGUF_MAGIC} header`);
    }

    if (!buffer.equals(magic)) {
      throw new Error(`expected ${GGUF_MAGIC} magic header`);
    }
  } catch (error) {
    throw new Error(
      `${label} is not a valid GGUF artifact at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function assertSha256(
  filePath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const actualSha256 = await calculateSha256(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} SHA-256 mismatch at ${filePath}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
}

export async function checkModelStageSources(cwd: string, plan: ModelStagePlan): Promise<void> {
  if (!plan.binarySourcePath) {
    throw new Error(`source checks require --binary-source or ${BINARY_SOURCE_ENV}`);
  }

  if (!plan.sourcePath) {
    throw new Error(`source checks require --source or ${MODEL_SOURCE_ENV}`);
  }

  const binarySourcePath = resolveSourceCheckPath(cwd, plan.binarySourcePath);
  const modelSourcePath = resolveSourceCheckPath(cwd, plan.sourcePath);

  const binaryStats = await assertRegularReadableFile(binarySourcePath, "llama-server source");
  assertFileSizeAtMost(
    binaryStats.size,
    MAX_LLAMA_CPP_BINARY_SOURCE_BYTES,
    "llama-server source",
    binarySourcePath,
  );
  if (plan.binarySha256) {
    await assertSha256(binarySourcePath, plan.binarySha256, "llama-server source");
  }
  const modelStats = await assertRegularReadableFile(modelSourcePath, "GGUF source");
  assertModelStageMemoryFit(modelStats.size, plan);
  await access(binarySourcePath, constants.X_OK).catch((error: unknown) => {
    throw new Error(
      `llama-server source is not executable at ${binarySourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await assertLlamaCppBinaryStarts(binarySourcePath, "llama-server source");
  await assertGgufMagicHeader(modelSourcePath, "GGUF source");

  if (plan.sha256) {
    await assertSha256(modelSourcePath, plan.sha256, "GGUF source");
  }
}

function parsePrincipalId(value: string, label: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!NUMERIC_PRINCIPAL_PATTERN.test(normalized) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} resolved to a non-numeric id: ${value}`);
  }

  return parsed;
}

async function lookupPrincipalId(command: string, args: string[], label: string): Promise<number> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: PRINCIPAL_LOOKUP_TIMEOUT_MS,
    maxBuffer: PRINCIPAL_LOOKUP_MAX_BUFFER_BYTES,
    encoding: "utf8",
  });

  return parsePrincipalId(String(stdout).trim(), label);
}

async function lookupGroupId(group: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("getent", ["group", group], {
      timeout: PRINCIPAL_LOOKUP_TIMEOUT_MS,
      maxBuffer: PRINCIPAL_LOOKUP_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const gid = String(stdout).trim().split(":")[2] ?? "";
    return parsePrincipalId(gid, `group ${group}`);
  } catch {
    return lookupPrincipalId("id", ["-g", group], `group ${group}`);
  }
}

async function resolveServiceOwnerIds(plan: ModelStagePlan): Promise<{ uid: number; gid: number }> {
  const uid = NUMERIC_PRINCIPAL_PATTERN.test(plan.serviceUser)
    ? parsePrincipalId(plan.serviceUser, "service user")
    : await lookupPrincipalId("id", ["-u", plan.serviceUser], `service user ${plan.serviceUser}`);
  const gid = NUMERIC_PRINCIPAL_PATTERN.test(plan.serviceGroup)
    ? parsePrincipalId(plan.serviceGroup, "service group")
    : await lookupGroupId(plan.serviceGroup);

  return { uid, gid };
}

function createAtomicStageTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `${ATOMIC_STAGE_TEMP_PREFIX}${path.basename(targetPath)}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function assertAtomicStageTempPathWithinLimit(targetDirectory: string, entryPath: string): void {
  const displayPath = path.relative(targetDirectory, entryPath) || entryPath;
  if (Buffer.byteLength(displayPath, "utf8") > MAX_ATOMIC_STAGE_TEMP_PATH_BYTES) {
    throw new Error(
      `Atomic stage temp cleanup path must be at most ${MAX_ATOMIC_STAGE_TEMP_PATH_BYTES} bytes: ${displayPath}`,
    );
  }
}

async function removeStaleAtomicStageTempFiles(targetPath: string): Promise<void> {
  const targetDirectory = path.dirname(targetPath);
  const tempPrefix = `${ATOMIC_STAGE_TEMP_PREFIX}${path.basename(targetPath)}-`;
  const staleBeforeMs = Date.now() - STALE_ATOMIC_STAGE_TEMP_MAX_AGE_MS;
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  let entryCount = 0;
  let removalCount = 0;

  try {
    directory = await opendir(targetDirectory);
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_ATOMIC_STAGE_TEMP_DISCOVERY_ENTRIES) {
        throw new Error(
          `Atomic stage temp cleanup visited more than ${MAX_ATOMIC_STAGE_TEMP_DISCOVERY_ENTRIES} entries in ${targetDirectory}`,
        );
      }

      if (!entry.isFile() || !entry.name.startsWith(tempPrefix)) {
        continue;
      }

      const entryPath = path.join(targetDirectory, entry.name);
      assertAtomicStageTempPathWithinLimit(targetDirectory, entryPath);
      let entryStats;
      try {
        entryStats = await stat(entryPath);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      if (entryStats.mtimeMs <= staleBeforeMs) {
        removalCount += 1;
        if (removalCount > MAX_ATOMIC_STAGE_TEMP_REMOVALS) {
          throw new Error(
            `Atomic stage temp cleanup would remove more than ${MAX_ATOMIC_STAGE_TEMP_REMOVALS} files in ${targetDirectory}`,
          );
        }
        await rm(entryPath, { force: true });
      }
    }
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The async iterator closes the directory after normal completion.
      }
    }
  }
}

async function copyFileAtomicUnlessSame(
  sourcePath: string,
  targetPath: string,
  prepareTemp?: (tempPath: string) => Promise<void>,
): Promise<boolean> {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return false;
  }

  await removeStaleAtomicStageTempFiles(targetPath);
  const tempPath = createAtomicStageTempPath(targetPath);

  try {
    await copyFile(sourcePath, tempPath);
    await prepareTemp?.(tempPath);
    await rename(tempPath, targetPath);
    return true;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function statValueToNumber(value: number | bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    return undefined;
  }

  return BigInt(asNumber) === value ? asNumber : undefined;
}

export function resolveModelStageAvailableStorageMiB(
  stats: ModelStageStorageStats,
): number | undefined {
  let availableBlocks = statValueToNumber(stats.bavail);
  let blockSize = statValueToNumber(stats.bsize);

  if (blockSize === 0) {
    const fallbackBlockSize = statValueToNumber(stats.blocks);
    const fallbackAvailableBlocks = statValueToNumber(stats.ffree);

    if (
      fallbackBlockSize !== undefined &&
      fallbackBlockSize > 0 &&
      fallbackBlockSize <= BYTES_PER_MIB &&
      fallbackAvailableBlocks !== undefined
    ) {
      blockSize = fallbackBlockSize;
      availableBlocks = fallbackAvailableBlocks;
    }
  }

  if (availableBlocks === undefined || blockSize === undefined || blockSize <= 0) {
    return undefined;
  }

  return Math.floor((availableBlocks * blockSize) / BYTES_PER_MIB);
}

export function evaluateModelStageStorageHeadroom(
  sourceBytes: number,
  availableMiB: number,
): ModelStageStorageHeadroom {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new Error("sourceBytes must be a non-negative safe integer");
  }

  if (!Number.isSafeInteger(availableMiB) || availableMiB < 0) {
    throw new Error("availableMiB must be a non-negative safe integer");
  }

  const sourceMiB = Math.max(1, Math.ceil(sourceBytes / BYTES_PER_MIB));
  const requiredMiB = sourceMiB + MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB;

  return {
    sourceMiB,
    reserveMiB: MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB,
    requiredMiB,
    availableMiB,
    ok: availableMiB >= requiredMiB,
  };
}

export function evaluateModelStageMemoryFit(
  sourceBytes: number,
  plan: Pick<
    ModelStagePlan,
    "memoryBudgetMiB" | "memoryBudgetSource" | "safeMemoryBudgetMiB" | "nonModelWorkingSetMiB"
  >,
): ModelStageMemoryFit | undefined {
  if (
    plan.memoryBudgetMiB === undefined ||
    plan.memoryBudgetSource === undefined ||
    plan.safeMemoryBudgetMiB === undefined ||
    plan.nonModelWorkingSetMiB === undefined
  ) {
    return undefined;
  }

  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new Error("sourceBytes must be a non-negative safe integer");
  }

  const sourceMiB = Math.max(1, Math.ceil(sourceBytes / BYTES_PER_MIB));
  const projectedWorkingSetMiB = sourceMiB + plan.nonModelWorkingSetMiB;

  return {
    sourceMiB,
    nonModelWorkingSetMiB: plan.nonModelWorkingSetMiB,
    projectedWorkingSetMiB,
    safeMemoryBudgetMiB: plan.safeMemoryBudgetMiB,
    memoryBudgetMiB: plan.memoryBudgetMiB,
    memoryBudgetSource: plan.memoryBudgetSource,
    ok: projectedWorkingSetMiB <= plan.safeMemoryBudgetMiB,
  };
}

function assertModelStageMemoryFit(sourceBytes: number, plan: ModelStagePlan): void {
  const fit = evaluateModelStageMemoryFit(sourceBytes, plan);

  if (!fit || fit.ok) {
    return;
  }

  throw new Error(
    `GGUF source is ${fit.sourceMiB} MiB, producing a projected llama.cpp working set of ${fit.projectedWorkingSetMiB} MiB, above the safe budget of ${fit.safeMemoryBudgetMiB} MiB on the ${fit.memoryBudgetMiB} MiB ${fit.memoryBudgetSource} memory target. Use a smaller GGUF or reduce cache/context before staging.`,
  );
}

async function assertModelStageStorageHeadroom(
  sourcePath: string,
  targetDirectory: string,
): Promise<void> {
  const [sourceStats, targetStats] = await Promise.all([stat(sourcePath), statfs(targetDirectory)]);
  const availableMiB = resolveModelStageAvailableStorageMiB(targetStats);

  if (availableMiB === undefined) {
    throw new Error(`Could not inspect free space for model target directory: ${targetDirectory}`);
  }

  const headroom = evaluateModelStageStorageHeadroom(sourceStats.size, availableMiB);

  if (!headroom.ok) {
    throw new Error(
      `Not enough free space in ${targetDirectory}: GGUF source is ${headroom.sourceMiB} MiB and staging keeps a ${headroom.reserveMiB} MiB reserve, requiring ${headroom.requiredMiB} MiB free but only ${headroom.availableMiB} MiB is available.`,
    );
  }
}

async function chownIfNeeded(filePath: string, uid: number, gid: number): Promise<void> {
  const stats = await stat(filePath);
  if (stats.uid === uid && stats.gid === gid) {
    return;
  }

  await chown(filePath, uid, gid);
}

function truncateProcessOutput(output: string): string {
  return output.length > MAX_PROCESS_OUTPUT_CHARS
    ? `${output.slice(0, MAX_PROCESS_OUTPUT_CHARS)}...`
    : output;
}

function getFailedProcessOutput(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  const stdout = "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
  const stderr = "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
  const output = `${stdout}\n${stderr}`.trim();

  return output ? truncateProcessOutput(output) : undefined;
}

async function assertLlamaCppBinaryStarts(
  binaryPath: string,
  label: string,
  serviceIdentity?: { uid: number; gid: number },
): Promise<void> {
  try {
    await execFileAsync(binaryPath, ["--help"], {
      timeout: LLAMA_CPP_BINARY_SMOKE_TIMEOUT_MS,
      maxBuffer: LLAMA_CPP_BINARY_SMOKE_MAX_BUFFER_BYTES,
      encoding: "utf8",
      ...(serviceIdentity ? { uid: serviceIdentity.uid, gid: serviceIdentity.gid } : {}),
    });
  } catch (error) {
    const output = getFailedProcessOutput(error);
    throw new Error(
      `${label} failed startup probe at ${binaryPath}: ${
        error instanceof Error ? error.message : String(error)
      }${output ? `; output: ${output}` : ""}`,
    );
  }
}

async function assertModelReadableByServiceUser(
  modelPath: string,
  serviceIdentity: { uid: number; gid: number },
): Promise<void> {
  try {
    await execFileAsync("test", ["-r", modelPath], {
      timeout: MODEL_READ_CHECK_TIMEOUT_MS,
      maxBuffer: MODEL_READ_CHECK_MAX_BUFFER_BYTES,
      encoding: "utf8",
      uid: serviceIdentity.uid,
      gid: serviceIdentity.gid,
    });
  } catch (error) {
    const output = getFailedProcessOutput(error);
    throw new Error(
      `installed GGUF model is not readable by the generated service identity at ${modelPath}: ${
        error instanceof Error ? error.message : String(error)
      }${output ? `; output: ${output}` : ""}`,
    );
  }
}

export async function applyModelStagePlan(
  cwd: string,
  plan: ModelStagePlan,
): Promise<ModelStageApplyResult> {
  await checkModelStageSources(cwd, plan);

  const binarySourcePath = resolveSourceCheckPath(cwd, plan.binarySourcePath ?? "");
  const modelSourcePath = resolveSourceCheckPath(cwd, plan.sourcePath ?? "");
  const binaryTargetPath = resolveStageTargetPath(cwd, plan.binaryPath);
  const modelTargetPath = resolveStageTargetPath(cwd, plan.modelPath);
  const { uid, gid } = await resolveServiceOwnerIds(plan);

  await mkdir(path.dirname(binaryTargetPath), { recursive: true, mode: 0o755 });
  const copiedBinary = await copyFileAtomicUnlessSame(
    binarySourcePath,
    binaryTargetPath,
    async (tempPath) => {
      await chmod(tempPath, 0o755);
      if (plan.binarySha256) {
        await assertSha256(tempPath, plan.binarySha256, "staged llama-server binary");
      }
      await access(tempPath, constants.X_OK);
      await assertLlamaCppBinaryStarts(tempPath, "staged llama-server binary", { uid, gid });
    },
  );
  if (!copiedBinary) {
    await chmod(binaryTargetPath, 0o755);
    if (plan.binarySha256) {
      await assertSha256(binaryTargetPath, plan.binarySha256, "installed llama-server binary");
    }
    await access(binaryTargetPath, constants.X_OK);
    await assertLlamaCppBinaryStarts(binaryTargetPath, "installed llama-server binary", {
      uid,
      gid,
    });
  }

  await mkdir(path.dirname(modelTargetPath), { recursive: true, mode: 0o755 });
  if (path.resolve(modelSourcePath) !== path.resolve(modelTargetPath)) {
    await assertModelStageStorageHeadroom(modelSourcePath, path.dirname(modelTargetPath));
    await copyFileAtomicUnlessSame(modelSourcePath, modelTargetPath, async (tempPath) => {
      await assertGgufMagicHeader(tempPath, "staged GGUF model");
      await chmod(tempPath, 0o640);
      await chownIfNeeded(tempPath, uid, gid);
      if (plan.sha256) {
        await assertSha256(tempPath, plan.sha256, "staged GGUF model");
      }
      await assertModelReadableByServiceUser(tempPath, { uid, gid });
    });
    await assertModelReadableByServiceUser(modelTargetPath, { uid, gid });
  } else {
    await assertGgufMagicHeader(modelTargetPath, "installed GGUF model");
    await chmod(modelTargetPath, 0o640);
    await chownIfNeeded(modelTargetPath, uid, gid);
    if (plan.sha256) {
      await assertSha256(modelTargetPath, plan.sha256, "installed GGUF model");
    }
    await assertModelReadableByServiceUser(modelTargetPath, { uid, gid });
  }

  return {
    applied: true,
    binaryPath: plan.binaryPath,
    binaryProbeStatus: "ok",
    modelPath: plan.modelPath,
    modelReadStatus: "ok",
    serviceUser: plan.serviceUser,
    serviceGroup: plan.serviceGroup,
  };
}

export function formatApplyResult(result: ModelStageApplyResult): string {
  return [
    "Staged Ray llama.cpp artifacts:",
    `- binary: ${result.binaryPath}`,
    `- binary startup probe: ${result.binaryProbeStatus}`,
    `- GGUF: ${result.modelPath}`,
    `- GGUF service-user read: ${result.modelReadStatus}`,
    `- service owner: ${result.serviceUser}:${result.serviceGroup}`,
    "Checksums were verified when configured. Run doctor before restarting ray-llama-cpp.service.",
  ].join("\n");
}

export async function runModelStageCli(
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
    const envFile = args.envFile ? path.resolve(cwd, args.envFile) : undefined;
    const plan = await createModelStagePlan({
      cwd,
      configPath: args.configPath,
      env,
      ...(envFile ? { envFile } : {}),
      ...(args.serviceUser ? { serviceUser: args.serviceUser } : {}),
      ...(args.serviceGroup ? { serviceGroup: args.serviceGroup } : {}),
      ...(args.binarySourcePath ? { binarySourcePath: args.binarySourcePath } : {}),
      ...(args.binarySha256 ? { binarySha256: args.binarySha256 } : {}),
      ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
      ...(args.sha256 ? { sha256: args.sha256 } : {}),
    });

    let output: string;
    if (args.apply) {
      const result = await applyModelStagePlan(cwd, plan);
      output = args.json
        ? JSON.stringify(
            {
              applied: true,
              binaryProbeStatus: result.binaryProbeStatus,
              modelReadStatus: result.modelReadStatus,
              plan,
            } satisfies ModelStageJsonApplyResult,
            null,
            2,
          )
        : formatApplyResult(result);
    } else {
      if (args.checkSources) {
        await checkModelStageSources(cwd, plan);
      }

      output = args.json
        ? JSON.stringify(plan, null, 2)
        : args.commandsOnly
          ? formatCommandPlan(plan)
          : formatTextPlan(cwd, plan);
    }

    io.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelStageCli();
}
