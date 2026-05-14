import { open, realpath, stat, statfs } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MIN_FREE_STORAGE_MIB = 1_024;
const MAX_MIN_FREE_STORAGE_MIB = 1_048_576;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const MAX_ENV_ENTRIES = 512;
const MAX_ENV_KEY_CHARS = 128;
const MAX_ENV_VALUE_BYTES = MAX_ENV_FILE_BYTES;
const MAX_CLI_ARGS = 40;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_STORAGE_PATHS = 16;
const MAX_STORAGE_PATH_BYTES = 4_096;
const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_STORAGE_PATHS = [
  "/",
  "/var/cache/apt",
  "/var/lib/apt",
  "/etc/ray",
  "/etc/systemd/system",
  "/etc/caddy",
  "/srv/ray",
  "/srv/ray/.ray/bun-install-cache",
  "/var/lib/ray",
  "/tmp",
  "/var/tmp",
] as const;
const ENV_FILE_STORAGE_PATH_KEYS = [
  "RAY_MODEL_PATH",
  "RAY_LLAMA_CPP_MODEL_PATH",
  "RAY_LLAMA_CPP_BINARY_PATH",
  "RAY_ASYNC_QUEUE_STORAGE_DIR",
  "RAY_LLAMA_CPP_BINARY_SOURCE_PATH",
  "RAY_MODEL_SOURCE_PATH",
] as const;

export interface DeployStoragePreflightArgs {
  paths: string[];
  pathsExplicit: boolean;
  minFreeStorageMiB: number;
  minFreeStorageMiBSource: "default" | "env" | "env-file" | "flag";
  envFile?: string;
  json: boolean;
  help: boolean;
}

export interface DeployStorageCheck {
  path: string;
  checkPath: string;
  checkRealPath?: string;
  minFreeStorageMiB: number;
  availableMiB: number;
  ok: boolean;
}

export interface DeployStoragePreflightSummary {
  ok: boolean;
  minFreeStorageMiB: number;
  checks: DeployStorageCheck[];
}

interface DeployStorageEnvironmentFileValues {
  minFreeStorageMiB?: number;
  storagePaths: string[];
}

const HELP = `Check remote VPS storage headroom before Ray deploy work consumes disk.

Usage:
  bun ./scripts/deploy-storage-preflight.ts [options]

Options:
  --path <path>          Absolute path to check. Repeatable. Defaults to /, /var/cache/apt, /var/lib/apt, /etc/ray, /etc/systemd/system, /etc/caddy, /srv/ray, /srv/ray/.ray/bun-install-cache, /var/lib/ray, /tmp, /var/tmp, plus model, llama.cpp binary, async-queue, and artifact staging source paths from --env-file when set.
  --min-free-mib <n>    Required free storage in MiB. Default: RAY_DEPLOY_MIN_FREE_STORAGE_MIB or ${DEFAULT_MIN_FREE_STORAGE_MIB}. Use 0 to skip the threshold.
  --env-file <path>      Load RAY_DEPLOY_MIN_FREE_STORAGE_MIB from a bounded dotenv file unless --min-free-mib is set.
  --ray-env-file <path>  Alias for --env-file.
  --json                Print machine-readable summary JSON.
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

function parseNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  if (parsed > MAX_MIN_FREE_STORAGE_MIB) {
    throw new Error(`${label} must be less than or equal to ${MAX_MIN_FREE_STORAGE_MIB}`);
  }

  return parsed;
}

function normalizeMinFreeStorageMiB(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  if (value > MAX_MIN_FREE_STORAGE_MIB) {
    throw new Error(`${label} must be less than or equal to ${MAX_MIN_FREE_STORAGE_MIB}`);
  }

  return value;
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

function normalizeStoragePath(value: string, label = "storage path"): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty absolute path without surrounding whitespace`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_STORAGE_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_STORAGE_PATH_BYTES} bytes`);
  }

  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }

  return path.posix.normalize(value);
}

function appendUniqueStoragePaths(paths: string[], extraPaths: string[]): string[] {
  const seen = new Set(paths);
  const merged = [...paths];

  for (const extraPath of extraPaths) {
    if (seen.has(extraPath)) {
      continue;
    }

    merged.push(extraPath);
    seen.add(extraPath);

    if (merged.length > MAX_STORAGE_PATHS) {
      throw new Error(`at most ${MAX_STORAGE_PATHS} storage paths can be checked`);
    }
  }

  return merged;
}

function isNonEmptyEnvValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DeployStoragePreflightArgs {
  assertArgv(argv);

  const paths: string[] = [];
  const envMinFreeStorageMiB = parseNonNegativeInteger(
    env.RAY_DEPLOY_MIN_FREE_STORAGE_MIB,
    "RAY_DEPLOY_MIN_FREE_STORAGE_MIB",
  );
  let minFreeStorageMiB = envMinFreeStorageMiB ?? DEFAULT_MIN_FREE_STORAGE_MIB;
  let minFreeStorageMiBSource: DeployStoragePreflightArgs["minFreeStorageMiBSource"] =
    envMinFreeStorageMiB === undefined ? "default" : "env";
  let envFile: string | undefined;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--path") {
      paths.push(normalizeStoragePath(requireFlagValue(current, argv[index + 1])));
      if (paths.length > MAX_STORAGE_PATHS) {
        throw new Error(`at most ${MAX_STORAGE_PATHS} storage paths can be checked`);
      }
      index += 1;
      continue;
    }

    if (current === "--min-free-mib") {
      minFreeStorageMiB =
        parseNonNegativeInteger(requireFlagValue(current, argv[index + 1]), current) ??
        DEFAULT_MIN_FREE_STORAGE_MIB;
      minFreeStorageMiBSource = "flag";
      index += 1;
      continue;
    }

    if (current === "--env-file" || current === "--ray-env-file") {
      envFile = normalizeOptionalPath(requireFlagValue(current, argv[index + 1]), current);
      index += 1;
      continue;
    }

    if (current === "--json") {
      json = true;
      continue;
    }

    if (current === "-h" || current === "--help") {
      help = true;
      continue;
    }

    if (current?.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current ?? ""}`);
  }

  return {
    paths: paths.length > 0 ? paths : [...DEFAULT_STORAGE_PATHS],
    pathsExplicit: paths.length > 0,
    minFreeStorageMiB,
    minFreeStorageMiBSource,
    ...(envFile ? { envFile } : {}),
    json,
    help,
  };
}

function decodeDoubleQuotedEnvValue(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") {
      return "\n";
    }

    if (escaped === "r") {
      return "\r";
    }

    if (escaped === "t") {
      return "\t";
    }

    return escaped;
  });
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

    const contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
      throw new Error(`Env file must be at most ${MAX_ENV_FILE_BYTES} bytes: ${envFile}`);
    }

    return contents;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      throw new Error(`Env file not found: ${envFile}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Env file is not readable: ${envFile}. Run this helper with privileges that can read the root-owned Ray env file, for example with sudo on a VPS.`,
      );
    }
    throw error;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function parseDeployStorageEnvironmentFile(contents: string): DeployStorageEnvironmentFileValues {
  if (typeof contents !== "string") {
    throw new Error("Env file contents must be a string");
  }

  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error(`Env file contents must be at most ${MAX_ENV_FILE_BYTES} bytes`);
  }

  const lines = contents.split(/\r?\n/);
  let entries = 0;
  let minFreeStorageMiB: number | undefined;
  const values = new Map<string, string>();

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env file line ${index + 1}: expected KEY=value`);
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env file line ${index + 1}: invalid variable name`);
    }

    if (key.length > MAX_ENV_KEY_CHARS) {
      throw new Error(
        `Invalid env file line ${index + 1}: variable name must be at most ${MAX_ENV_KEY_CHARS} characters`,
      );
    }

    entries += 1;
    if (entries > MAX_ENV_ENTRIES) {
      throw new Error(`Env file must contain at most ${MAX_ENV_ENTRIES} variables`);
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    let value = rawValue;
    const startsDoubleQuote = rawValue.startsWith('"');
    const endsDoubleQuote = rawValue.endsWith('"');
    const startsSingleQuote = rawValue.startsWith("'");
    const endsSingleQuote = rawValue.endsWith("'");

    if (startsDoubleQuote !== endsDoubleQuote || startsSingleQuote !== endsSingleQuote) {
      throw new Error(`Invalid env file line ${index + 1}: unterminated quoted value`);
    }

    if (startsDoubleQuote || startsSingleQuote) {
      value = rawValue.slice(1, -1);
      if (startsDoubleQuote) {
        value = decodeDoubleQuotedEnvValue(value);
      }
    }

    if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) {
      throw new Error(
        `Invalid env file line ${index + 1}: value must be at most ${MAX_ENV_VALUE_BYTES} bytes`,
      );
    }

    if (key === "RAY_DEPLOY_MIN_FREE_STORAGE_MIB") {
      minFreeStorageMiB = parseNonNegativeInteger(value, key);
    }

    if ((ENV_FILE_STORAGE_PATH_KEYS as readonly string[]).includes(key)) {
      values.set(key, value);
    }
  }

  const storagePaths: string[] = [];
  const configuredModelPath = values.get("RAY_MODEL_PATH");
  const fallbackModelPath = values.get("RAY_LLAMA_CPP_MODEL_PATH");
  const modelPath = isNonEmptyEnvValue(configuredModelPath)
    ? configuredModelPath
    : fallbackModelPath;
  const modelPathLabel = isNonEmptyEnvValue(configuredModelPath)
    ? "RAY_MODEL_PATH"
    : "RAY_LLAMA_CPP_MODEL_PATH";
  if (isNonEmptyEnvValue(modelPath)) {
    storagePaths.push(normalizeStoragePath(modelPath, modelPathLabel));
  }

  const llamaCppBinaryPath = values.get("RAY_LLAMA_CPP_BINARY_PATH");
  if (isNonEmptyEnvValue(llamaCppBinaryPath)) {
    storagePaths.push(normalizeStoragePath(llamaCppBinaryPath, "RAY_LLAMA_CPP_BINARY_PATH"));
  }

  const asyncQueueStorageDir = values.get("RAY_ASYNC_QUEUE_STORAGE_DIR");
  if (isNonEmptyEnvValue(asyncQueueStorageDir)) {
    storagePaths.push(normalizeStoragePath(asyncQueueStorageDir, "RAY_ASYNC_QUEUE_STORAGE_DIR"));
  }

  const llamaCppBinarySourcePath = values.get("RAY_LLAMA_CPP_BINARY_SOURCE_PATH");
  if (isNonEmptyEnvValue(llamaCppBinarySourcePath)) {
    storagePaths.push(
      normalizeStoragePath(llamaCppBinarySourcePath, "RAY_LLAMA_CPP_BINARY_SOURCE_PATH"),
    );
  }

  const modelSourcePath = values.get("RAY_MODEL_SOURCE_PATH");
  if (isNonEmptyEnvValue(modelSourcePath)) {
    storagePaths.push(normalizeStoragePath(modelSourcePath, "RAY_MODEL_SOURCE_PATH"));
  }

  return {
    ...(minFreeStorageMiB !== undefined ? { minFreeStorageMiB } : {}),
    storagePaths,
  };
}

export async function loadDeployStoragePreflightArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeployStoragePreflightArgs> {
  const args = parseArgs(argv, env);

  if (!args.envFile || args.help) {
    return args;
  }

  const envFileValues = parseDeployStorageEnvironmentFile(
    await readEnvironmentFileBounded(args.envFile),
  );
  const useEnvFileThreshold =
    args.minFreeStorageMiBSource !== "flag" && envFileValues.minFreeStorageMiB !== undefined;

  if (!useEnvFileThreshold && envFileValues.storagePaths.length === 0) {
    return args;
  }

  return {
    ...args,
    paths: args.pathsExplicit
      ? args.paths
      : appendUniqueStoragePaths(args.paths, envFileValues.storagePaths),
    ...(useEnvFileThreshold && envFileValues.minFreeStorageMiB !== undefined
      ? { minFreeStorageMiB: envFileValues.minFreeStorageMiB, minFreeStorageMiBSource: "env-file" }
      : {}),
  };
}

async function findExistingParent(targetPath: string, statFn: typeof stat): Promise<string> {
  let checkPath = normalizeStoragePath(targetPath);

  while (true) {
    try {
      await statFn(checkPath);
      return checkPath;
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;

      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }

    const parent = path.posix.dirname(checkPath);
    if (parent === checkPath) {
      return checkPath;
    }
    checkPath = parent;
  }
}

async function getAvailableStorageMiB(checkPath: string, statfsFn: typeof statfs): Promise<number> {
  const stats = await statfsFn(checkPath);
  const rawBlockSize = Number(stats.bsize);
  const blockSize =
    Number.isFinite(rawBlockSize) && rawBlockSize > 0 ? rawBlockSize : Number(stats.blocks);
  const availableBlocks =
    Number.isFinite(rawBlockSize) && rawBlockSize > 0
      ? Number(stats.bavail)
      : Number(stats.ffree ?? stats.bfree);

  if (
    !Number.isFinite(blockSize) ||
    !Number.isFinite(availableBlocks) ||
    blockSize <= 0 ||
    availableBlocks < 0
  ) {
    throw new Error(`Could not inspect free storage at ${checkPath}`);
  }

  return Math.floor((blockSize * availableBlocks) / BYTES_PER_MIB);
}

async function resolveCheckRealPathIfDifferent(
  checkPath: string,
  realpathFn: typeof realpath,
): Promise<string | undefined> {
  try {
    const resolved = await realpathFn(checkPath);
    return resolved !== checkPath ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function checkDeployStorageHeadroom(
  options: {
    paths?: string[];
    minFreeStorageMiB?: number;
    stat?: typeof stat;
    statfs?: typeof statfs;
    realpath?: typeof realpath;
  } = {},
): Promise<DeployStoragePreflightSummary> {
  const paths = options.paths ?? [...DEFAULT_STORAGE_PATHS];
  if (paths.length > MAX_STORAGE_PATHS) {
    throw new Error(`at most ${MAX_STORAGE_PATHS} storage paths can be checked`);
  }

  const minFreeStorageMiB = normalizeMinFreeStorageMiB(
    options.minFreeStorageMiB ?? DEFAULT_MIN_FREE_STORAGE_MIB,
    "minFreeStorageMiB",
  );
  const statFn = options.stat ?? stat;
  const statfsFn = options.statfs ?? statfs;
  const realpathFn = options.realpath ?? realpath;

  const checks: DeployStorageCheck[] = [];
  for (const storagePath of paths) {
    const normalizedPath = normalizeStoragePath(storagePath);
    const checkPath = await findExistingParent(normalizedPath, statFn);
    const checkRealPath = await resolveCheckRealPathIfDifferent(checkPath, realpathFn);
    const availableMiB = await getAvailableStorageMiB(checkPath, statfsFn);
    checks.push({
      path: normalizedPath,
      checkPath,
      ...(checkRealPath ? { checkRealPath } : {}),
      minFreeStorageMiB,
      availableMiB,
      ok: minFreeStorageMiB === 0 || availableMiB >= minFreeStorageMiB,
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    minFreeStorageMiB,
    checks,
  };
}

function formatCheckedStoragePath(check: DeployStorageCheck): string {
  if (check.checkPath === check.path) {
    return check.checkRealPath ? ` (resolves to ${check.checkRealPath})` : "";
  }

  return check.checkRealPath
    ? ` (checked ${check.checkPath} -> ${check.checkRealPath})`
    : ` (checked ${check.checkPath})`;
}

export function formatTextSummary(summary: DeployStoragePreflightSummary): string {
  const lines = [
    "Ray deploy storage preflight:",
    `- required free storage: ${summary.minFreeStorageMiB} MiB`,
  ];

  for (const check of summary.checks) {
    const status = check.ok ? "OK" : "LOW";
    const via = formatCheckedStoragePath(check);
    lines.push(`- ${status} ${check.path}${via}: ${check.availableMiB} MiB free`);
  }

  if (!summary.ok) {
    lines.push(
      "",
      "Free storage is below the deploy preflight threshold. Clear space or lower RAY_DEPLOY_MIN_FREE_STORAGE_MIB only when the VPS has another storage plan.",
    );
  }

  return lines.join("\n");
}

export async function runDeployStoragePreflightCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const args = await loadDeployStoragePreflightArgs(argv, env);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const summary = await checkDeployStorageHeadroom({
      paths: args.paths,
      minFreeStorageMiB: args.minFreeStorageMiB,
    });
    const output = args.json ? JSON.stringify(summary, null, 2) : formatTextSummary(summary);
    io.stdout.write(`${output}\n`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runDeployStoragePreflightCli());
}
