import { open, stat, statfs } from "node:fs/promises";
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
  "/srv/ray",
  "/srv/ray/.ray/bun-install-cache",
  "/var/lib/ray",
  "/tmp",
] as const;

export interface DeployStoragePreflightArgs {
  paths: string[];
  minFreeStorageMiB: number;
  minFreeStorageMiBSource: "default" | "env" | "env-file" | "flag";
  envFile?: string;
  json: boolean;
  help: boolean;
}

export interface DeployStorageCheck {
  path: string;
  checkPath: string;
  minFreeStorageMiB: number;
  availableMiB: number;
  ok: boolean;
}

export interface DeployStoragePreflightSummary {
  ok: boolean;
  minFreeStorageMiB: number;
  checks: DeployStorageCheck[];
}

const HELP = `Check remote VPS storage headroom before Ray deploy work consumes disk.

Usage:
  bun ./scripts/deploy-storage-preflight.ts [options]

Options:
  --path <path>          Absolute path to check. Repeatable. Defaults to /srv/ray, /srv/ray/.ray/bun-install-cache, /var/lib/ray, and /tmp.
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

function normalizeOptionalPath(value: string, label: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty path without surrounding whitespace`);
  }

  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must not contain control characters`);
  }

  return value;
}

function normalizeStoragePath(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(
      "storage path must be a non-empty absolute path without surrounding whitespace",
    );
  }

  if (/[\0\r\n\s]/.test(value)) {
    throw new Error("storage path must not contain whitespace or control characters");
  }

  if (Buffer.byteLength(value, "utf8") > MAX_STORAGE_PATH_BYTES) {
    throw new Error(`storage path must be at most ${MAX_STORAGE_PATH_BYTES} bytes`);
  }

  if (!path.posix.isAbsolute(value)) {
    throw new Error("storage path must be absolute");
  }

  return path.posix.normalize(value);
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
    throw error;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function parseDeployMinFreeStorageFromEnvironmentFile(contents: string): number | undefined {
  if (typeof contents !== "string") {
    throw new Error("Env file contents must be a string");
  }

  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error(`Env file contents must be at most ${MAX_ENV_FILE_BYTES} bytes`);
  }

  const lines = contents.split(/\r?\n/);
  let entries = 0;
  let minFreeStorageMiB: number | undefined;

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
  }

  return minFreeStorageMiB;
}

export async function loadDeployStoragePreflightArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeployStoragePreflightArgs> {
  const args = parseArgs(argv, env);

  if (!args.envFile || args.help || args.minFreeStorageMiBSource === "flag") {
    return args;
  }

  const envFileMinFreeStorageMiB = parseDeployMinFreeStorageFromEnvironmentFile(
    await readEnvironmentFileBounded(args.envFile),
  );

  if (envFileMinFreeStorageMiB === undefined) {
    return args;
  }

  return {
    ...args,
    minFreeStorageMiB: envFileMinFreeStorageMiB,
    minFreeStorageMiBSource: "env-file",
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

export async function checkDeployStorageHeadroom(
  options: {
    paths?: string[];
    minFreeStorageMiB?: number;
    stat?: typeof stat;
    statfs?: typeof statfs;
  } = {},
): Promise<DeployStoragePreflightSummary> {
  const paths = options.paths ?? [...DEFAULT_STORAGE_PATHS];
  const minFreeStorageMiB = options.minFreeStorageMiB ?? DEFAULT_MIN_FREE_STORAGE_MIB;
  const statFn = options.stat ?? stat;
  const statfsFn = options.statfs ?? statfs;

  const checks: DeployStorageCheck[] = [];
  for (const storagePath of paths) {
    const normalizedPath = normalizeStoragePath(storagePath);
    const checkPath = await findExistingParent(normalizedPath, statFn);
    const availableMiB = await getAvailableStorageMiB(checkPath, statfsFn);
    checks.push({
      path: normalizedPath,
      checkPath,
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

export function formatTextSummary(summary: DeployStoragePreflightSummary): string {
  const lines = [
    "Ray deploy storage preflight:",
    `- required free storage: ${summary.minFreeStorageMiB} MiB`,
  ];

  for (const check of summary.checks) {
    const status = check.ok ? "OK" : "LOW";
    const via = check.checkPath === check.path ? "" : ` (checked ${check.checkPath})`;
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
