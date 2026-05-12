import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, chmod, chown, copyFile, mkdir, open, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadRayConfig } from "../packages/config/src/index.ts";
import { parseEnvironmentFile } from "../packages/deploy/src/cli.ts";

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
const BYTES_PER_MIB = 1024 * 1024;
const FALLBACK_STATFS_BLOCK_SIZE = 4096;
const MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB = 256;
const SYSTEMD_PRINCIPAL_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;
const NUMERIC_PRINCIPAL_PATTERN = /^[0-9]{1,10}$/;

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
  commands: string[];
}

export interface ModelStageApplyResult {
  applied: true;
  binaryPath: string;
  modelPath: string;
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
  plan: ModelStagePlan;
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
  const modelStoragePreflight = `required_mib="$(du -m ${shellQuote(
    sourcePath,
  )} | awk 'NR==1 {print $1 + ${MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB}}')"; available_mib="$(df -Pm ${shellQuote(
    plan.modelDirectory,
  )} | awk 'NR==2 {print $4}')"; test "\${available_mib:-0}" -ge "\${required_mib:-0}" || { printf '%s\\n' ${shellQuote(
    `Not enough free space in ${plan.modelDirectory}: keep at least ${MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB} MiB free after copying the GGUF.`,
  )} >&2; exit 1; }`;
  const commands = [
    `sudo install -d -m 0755 ${shellQuote(plan.binaryDirectory)}`,
    `sudo install -D -m 0755 -- ${shellQuote(binarySourcePath)} ${shellQuote(plan.binaryPath)}`,
    `sudo -u ${shellQuote(plan.serviceUser)} test -x ${shellQuote(plan.binaryPath)}`,
    `sudo install -d -m 0755 ${shellQuote(plan.modelDirectory)}`,
    modelStoragePreflight,
    `sudo install -D -m 0640 -- ${shellQuote(sourcePath)} ${shellQuote(plan.modelPath)}`,
    `sudo chown ${shellQuote(owner)} ${shellQuote(plan.modelPath)}`,
    `sudo -u ${shellQuote(plan.serviceUser)} test -r ${shellQuote(plan.modelPath)}`,
  ];

  if (plan.binarySha256) {
    commands.splice(
      2,
      0,
      `printf '%s  %s\\n' ${shellQuote(plan.binarySha256)} ${shellQuote(plan.binaryPath)} | sha256sum -c -`,
    );
  }

  if (plan.sha256) {
    commands.splice(
      commands.length - 1,
      0,
      `printf '%s  %s\\n' ${shellQuote(plan.sha256)} ${shellQuote(plan.modelPath)} | sha256sum -c -`,
    );
  }

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

async function assertRegularReadableFile(filePath: string, label: string): Promise<void> {
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
}

async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest("hex");
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

  await assertRegularReadableFile(binarySourcePath, "llama-server source");
  await access(binarySourcePath, constants.X_OK).catch((error: unknown) => {
    throw new Error(
      `llama-server source is not executable at ${binarySourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await assertRegularReadableFile(modelSourcePath, "GGUF source");

  if (plan.binarySha256) {
    await assertSha256(binarySourcePath, plan.binarySha256, "llama-server source");
  }

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

async function copyFileUnlessSame(sourcePath: string, targetPath: string): Promise<void> {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }

  await copyFile(sourcePath, targetPath);
}

function statValueToNumber(value: number | bigint): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    return undefined;
  }

  return BigInt(asNumber) === value ? asNumber : undefined;
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

async function assertModelStageStorageHeadroom(
  sourcePath: string,
  targetDirectory: string,
): Promise<void> {
  const [sourceStats, targetStats] = await Promise.all([stat(sourcePath), statfs(targetDirectory)]);
  const availableBlocks = statValueToNumber(targetStats.bavail);
  const reportedBlockSize = statValueToNumber(targetStats.bsize);
  const blockSize =
    reportedBlockSize !== undefined && reportedBlockSize > 0
      ? reportedBlockSize
      : FALLBACK_STATFS_BLOCK_SIZE;

  if (availableBlocks === undefined) {
    throw new Error(`Could not inspect free space for model target directory: ${targetDirectory}`);
  }

  const availableMiB = Math.floor((availableBlocks * blockSize) / BYTES_PER_MIB);
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
  await copyFileUnlessSame(binarySourcePath, binaryTargetPath);
  await chmod(binaryTargetPath, 0o755);
  if (plan.binarySha256) {
    await assertSha256(binaryTargetPath, plan.binarySha256, "installed llama-server binary");
  }
  await access(binaryTargetPath, constants.X_OK);

  await mkdir(path.dirname(modelTargetPath), { recursive: true, mode: 0o755 });
  await assertModelStageStorageHeadroom(modelSourcePath, path.dirname(modelTargetPath));
  await copyFileUnlessSame(modelSourcePath, modelTargetPath);
  await chmod(modelTargetPath, 0o640);
  await chownIfNeeded(modelTargetPath, uid, gid);
  if (plan.sha256) {
    await assertSha256(modelTargetPath, plan.sha256, "installed GGUF model");
  }
  await access(modelTargetPath, constants.R_OK);

  return {
    applied: true,
    binaryPath: plan.binaryPath,
    modelPath: plan.modelPath,
    serviceUser: plan.serviceUser,
    serviceGroup: plan.serviceGroup,
  };
}

export function formatApplyResult(result: ModelStageApplyResult): string {
  return [
    "Staged Ray llama.cpp artifacts:",
    `- binary: ${result.binaryPath}`,
    `- GGUF: ${result.modelPath}`,
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
        ? JSON.stringify({ applied: true, plan } satisfies ModelStageJsonApplyResult, null, 2)
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
