import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAndDiagnoseDeployment, renderDeploymentBundle } from "./index.js";

export type Command = "render" | "validate" | "doctor";

export interface CliOptions {
  command: Command;
  cwd: string;
  configPath: string;
  help?: boolean;
  user?: string;
  domain?: string;
  envFile?: string;
  systemdEnvFile?: string;
  outputDir?: string;
  memoryBudgetMiB?: number;
  runtimeBinary?: string;
  nodeBinary?: string;
  caddyBinary?: string;
  strictFilesystem?: boolean;
  json?: boolean;
}

export interface RepoConfigPath {
  configPath: string;
  configRel: string;
}

interface RenderedDeploymentFiles {
  service: string;
  caddyfile: string;
  envFileExample: string;
  summary: string;
  llamaCppService?: string;
}

const MAX_DEPLOY_ENV_FILE_BYTES = 64 * 1024;
const MAX_DEPLOY_ENV_ENTRIES = 512;
const MAX_DEPLOY_ENV_KEY_CHARS = 128;
const MAX_DEPLOY_ENV_VALUE_CHARS = MAX_DEPLOY_ENV_FILE_BYTES;
const unsafeDeployEnvKeys = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPLOY_CLI_ARGS = 64;
const MAX_DEPLOY_CLI_ARG_BYTES = 4_096;
const MAX_DEPLOY_PATH_BYTES = 4_096;
const SYSTEMD_USER_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/;
const DEFAULT_CONFIG_PATH = "./examples/config/ray.sub1b.public.json";
const RESERVED_DEPLOY_STAGING_PREFIX = ".ray-deploy-";
const VPS_WORKFLOW_EXCLUDED_CONFIG_SEGMENTS = new Set([".git", ".github", ".ray", "node_modules"]);
const SYSTEMD_PROTECTED_HOME_PATHS = ["/home", "/root", "/run/user"] as const;
const SYSTEMD_PRIVATE_TMP_PATHS = ["/tmp", "/var/tmp"] as const;

const DEPLOY_CLI_HELP = `Ray deploy CLI

Usage:
  bun packages/deploy/dist/cli.js render [options]
  bun packages/deploy/dist/cli.js validate [options]
  bun packages/deploy/dist/cli.js doctor [options]

Commands:
  render    Print or write systemd, Caddy, env example, and summary output.
  validate  Print config diagnostics and non-strict host preflight details.
  doctor    Run strict VPS diagnostics and exit non-zero on error diagnostics.

Options:
  --cwd <path>                    Repo or deploy working directory. Default: current directory.
  --config <path>                 Ray config path. Default: ${DEFAULT_CONFIG_PATH}
  --env-file <path>               Load deploy env values from a real env file.
  --ray-env-file <path>           Alias for --env-file.
  --systemd-env-file <path>       Render a systemd EnvironmentFile path without loading it. Render only.
  --output-dir <path>             Write rendered files instead of printing them. Render only.
  --domain <host>                 Caddy site address. Default: ray.local or RAY_DEPLOY_DOMAIN.
  --user <name|uid>               systemd service user. Default: ray or RAY_DEPLOY_SERVICE_USER.
  --gateway-runtime-binary <path> Gateway runtime path. Default: /usr/local/bin/bun.
  --node-binary <path>            Compatibility alias for the gateway runtime path.
  --caddy-binary <path>           Caddy binary for strict doctor/render checks. Default: caddy on PATH.
  --memory-mib <number>           VPS memory budget for llama.cpp sizing.
  --strict-filesystem             Check service-user, binary, config, model, and storage paths.
  --json                          Print machine-readable JSON. Render emits the bundle unless --output-dir is set.
  -h, --help                      Show this help.

Deploy env values loaded by --env-file include RAY_API_KEYS, RAY_DEPLOY_SERVICE_USER,
RAY_DEPLOY_DOMAIN, RAY_DEPLOY_MEMORY_MIB, RAY_GATEWAY_RUNTIME_BINARY,
RAY_DEPLOY_MIN_FREE_STORAGE_MIB, RAY_DEPLOY_CADDY_BINARY, and portable RAY_MODEL_* /
RAY_LLAMA_CPP_* model overrides.
`;

function assertCliArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_DEPLOY_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_DEPLOY_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_DEPLOY_CLI_ARG_BYTES} bytes`);
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parsePathFlagValue(flag: string, value: string | undefined): string {
  const pathValue = requireFlagValue(flag, value);

  if (/[\0\r\n]/.test(pathValue)) {
    throw new Error(`${flag} must not contain control characters`);
  }

  if (pathValue.length === 0 || pathValue.trim() !== pathValue) {
    throw new Error(`${flag} must be a non-empty path without surrounding whitespace`);
  }

  assertDeployPathBytes(pathValue, flag);
  return pathValue;
}

function parsePositiveIntegerFlag(value: string, label: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function readNonEmptyEnvValue(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseServiceUserValue(value: string, label: string): string {
  if (!SYSTEMD_USER_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a system account name or numeric UID using only letters, digits, underscores, or hyphens`,
    );
  }

  return value;
}

function assertDeployPathBytes(value: string, label: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_DEPLOY_PATH_BYTES} bytes`);
  }
}

export function normalizeRepoConfigPath(value: string, label = "config path"): RepoConfigPath {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (value.length === 0 || value.trim() !== value) {
    throw new Error(
      `${label} must be a non-empty repo-relative path without leading or trailing whitespace`,
    );
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  assertDeployPathBytes(value, label);

  if (value.includes("\\")) {
    throw new Error(`${label} must use forward slashes`);
  }

  if (path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be repo-relative, not absolute`);
  }

  const normalized = path.posix.normalize(value);
  const configRel = normalized.startsWith("./") ? normalized.slice(2) : normalized;

  if (
    configRel.length === 0 ||
    configRel === "." ||
    configRel === ".." ||
    configRel.startsWith("../")
  ) {
    throw new Error(`${label} must stay inside the repository checkout`);
  }

  const segments = configRel.split("/");
  const firstSegment = segments[0] ?? "";
  if (firstSegment.startsWith(RESERVED_DEPLOY_STAGING_PREFIX)) {
    throw new Error(`${label} cannot use reserved .ray-deploy-* staging paths`);
  }

  if (segments.some((segment) => VPS_WORKFLOW_EXCLUDED_CONFIG_SEGMENTS.has(segment))) {
    throw new Error(`${label} must not point inside paths excluded from VPS repository sync`);
  }

  return {
    configPath: `./${configRel}`,
    configRel,
  };
}

function isPosixPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.posix.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

export function normalizeGatewayRuntimeBinaryPath(
  value: string,
  label = "RAY_GATEWAY_RUNTIME_BINARY",
): string {
  const normalized = normalizeAbsoluteBinaryPath(value, label);
  assertOutsideSystemdProtectedHome(normalized, label);
  if (
    SYSTEMD_PRIVATE_TMP_PATHS.some((temporaryPath) => isPosixPathInside(temporaryPath, normalized))
  ) {
    throw new Error(
      `${label} must be outside /tmp and /var/tmp because systemd uses PrivateTmp=true`,
    );
  }

  return normalized;
}

function normalizeAbsoluteBinaryPath(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (value.length === 0 || value.trim() !== value) {
    throw new Error(
      `${label} must be a non-empty absolute path without leading or trailing whitespace`,
    );
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  assertDeployPathBytes(value, label);

  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }

  return path.posix.normalize(value);
}

function assertOutsideSystemdProtectedHome(normalized: string, label: string): void {
  if (
    SYSTEMD_PROTECTED_HOME_PATHS.some((protectedPath) =>
      isPosixPathInside(protectedPath, normalized),
    )
  ) {
    throw new Error(
      `${label} must be outside /home, /root, and /run/user because systemd uses ProtectHome=true`,
    );
  }
}

export function normalizeCaddyBinaryPath(value: string, label = "RAY_DEPLOY_CADDY_BINARY"): string {
  const normalized = normalizeAbsoluteBinaryPath(value, label);
  assertOutsideSystemdProtectedHome(normalized, label);
  return normalized;
}

export function parseDeploySshPort(value: string, label = "RAY_DEPLOY_SSH_PORT"): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    normalized.length === 0 ||
    !/^\d+$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > 65_535
  ) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }

  return parsed;
}

export function parseDeployReadyTimeoutSeconds(
  value: string,
  label = "RAY_DEPLOY_READY_TIMEOUT_SECONDS",
): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    normalized.length === 0 ||
    !/^\d+$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > 999
  ) {
    throw new Error(`${label} must be an integer from 1 to 999 seconds`);
  }

  return parsed;
}

export function parseDeploySshUser(value: string, label = "RAY_DEPLOY_SSH_USER"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty SSH login user without surrounding whitespace`);
  }

  return parseServiceUserValue(value, label);
}

export function parseDeployServiceUser(value: string, label = "RAY_DEPLOY_SERVICE_USER"): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return parseServiceUserValue(value, label);
}

export function formatDeployKnownHostLookup(
  host: string,
  port: number | string,
  label = "RAY_DEPLOY_HOST",
): string {
  if (typeof host !== "string") {
    throw new Error(`${label} must be a string`);
  }

  if (host.length === 0 || host.trim() !== host || /[\0\r\n\s]/.test(host)) {
    throw new Error(`${label} must be a non-empty SSH host without whitespace`);
  }

  const sshPort =
    typeof port === "number" ? parseDeploySshPort(String(port)) : parseDeploySshPort(port);

  return sshPort === 22 ? host : `[${host}]:${sshPort}`;
}

function parseOptionalPositiveIntegerEnv(
  value: string | undefined,
  label: string,
): number | undefined {
  const normalized = readNonEmptyEnvValue(value);
  return normalized === undefined ? undefined : parsePositiveIntegerFlag(normalized, label);
}

function parseOptionalServiceUserEnv(value: string | undefined): string | undefined {
  const normalized = readNonEmptyEnvValue(value);
  return normalized === undefined ? undefined : parseDeployServiceUser(normalized);
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

export function parseEnvironmentFile(contents: string): NodeJS.ProcessEnv {
  if (typeof contents !== "string") {
    throw new Error("Env file contents must be a string");
  }

  if (Buffer.byteLength(contents, "utf8") > MAX_DEPLOY_ENV_FILE_BYTES) {
    throw new Error(`Env file contents must be at most ${MAX_DEPLOY_ENV_FILE_BYTES} bytes`);
  }

  const env = Object.create(null) as NodeJS.ProcessEnv;
  const lines = contents.split(/\r?\n/);
  let entries = 0;

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

    if (unsafeDeployEnvKeys.has(key)) {
      throw new Error(`Invalid env file line ${index + 1}: unsafe variable name`);
    }

    if (key.length > MAX_DEPLOY_ENV_KEY_CHARS) {
      throw new Error(
        `Invalid env file line ${index + 1}: variable name must be at most ${MAX_DEPLOY_ENV_KEY_CHARS} characters`,
      );
    }

    entries += 1;
    if (entries > MAX_DEPLOY_ENV_ENTRIES) {
      throw new Error(`Env file must contain at most ${MAX_DEPLOY_ENV_ENTRIES} variables`);
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

    if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_ENV_VALUE_CHARS) {
      throw new Error(
        `Invalid env file line ${index + 1}: value must be at most ${MAX_DEPLOY_ENV_VALUE_CHARS} bytes`,
      );
    }

    env[key] = value;
  }

  return env;
}

async function readEnvironmentFileBounded(envFile: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(envFile, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`Env file path must be a file: ${envFile}`);
    }

    if (stats.size > MAX_DEPLOY_ENV_FILE_BYTES) {
      throw new Error(`Env file must be at most ${MAX_DEPLOY_ENV_FILE_BYTES} bytes: ${envFile}`);
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function getNodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function formatEnvironmentFileReadError(envFile: string, error: unknown): Error {
  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return new Error(`Env file not found: ${envFile}`);
  }

  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Env file is not readable: ${envFile}. Run this helper with privileges that can read the root-owned Ray env file, for example with sudo on a VPS.`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function loadEnvironment(options: CliOptions): Promise<NodeJS.ProcessEnv> {
  if (!options.envFile) {
    return process.env;
  }

  let contents: string;
  try {
    contents = await readEnvironmentFileBounded(options.envFile);
  } catch (error) {
    throw formatEnvironmentFileReadError(options.envFile, error);
  }

  return {
    ...process.env,
    ...parseEnvironmentFile(contents),
  };
}

async function writeDeploymentBundleFiles(
  outputDir: string,
  bundle: Awaited<ReturnType<typeof renderDeploymentBundle>>,
): Promise<RenderedDeploymentFiles> {
  await mkdir(outputDir, { recursive: true });

  const files: RenderedDeploymentFiles = {
    service: path.join(outputDir, "ray-gateway.service"),
    caddyfile: path.join(outputDir, "Caddyfile"),
    envFileExample: path.join(outputDir, "ray.env.example"),
    summary: path.join(outputDir, "summary.json"),
  };

  await writeFile(files.service, bundle.service, "utf8");
  await writeFile(files.caddyfile, bundle.caddyfile, "utf8");
  await writeFile(files.envFileExample, bundle.envFileExample, "utf8");
  await writeFile(files.summary, `${JSON.stringify(bundle.summary, null, 2)}\n`, "utf8");

  if (bundle.llamaCppService) {
    files.llamaCppService = path.join(outputDir, "ray-llama-cpp.service");
    await writeFile(files.llamaCppService, bundle.llamaCppService, "utf8");
  } else {
    await rm(path.join(outputDir, "ray-llama-cpp.service"), { force: true });
  }

  return files;
}

function assertRenderableDeploymentBundle(
  bundle: Awaited<ReturnType<typeof renderDeploymentBundle>>,
): void {
  const errorCodes = bundle.summary.diagnostics
    .filter((diagnostic) => diagnostic.level === "error")
    .map((diagnostic) => diagnostic.code);

  if (errorCodes.length === 0) {
    return;
  }

  const shownCodes = errorCodes.slice(0, 8).join(", ");
  const overflow = errorCodes.length > 8 ? ", ..." : "";

  throw new Error(
    `Refusing to render deployment with ${errorCodes.length} error diagnostic(s): ${shownCodes}${overflow}. Run validate or doctor for details.`,
  );
}

export function parseCliArgs(argv: string[]): CliOptions {
  assertCliArgv(argv);

  let command: Command = "render";
  let index = 0;

  if (argv[0] === "help") {
    return {
      command,
      cwd: process.cwd(),
      configPath: DEFAULT_CONFIG_PATH,
      help: true,
    };
  }

  if (argv[0] === "render" || argv[0] === "validate" || argv[0] === "doctor") {
    command = argv[0];
    index = 1;
  } else if (argv[0] && !argv[0].startsWith("--")) {
    throw new Error(`Unknown command: ${argv[0]}`);
  }

  const options: CliOptions = {
    command,
    cwd: process.cwd(),
    configPath: DEFAULT_CONFIG_PATH,
  };

  for (; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--") {
      continue;
    }

    if (current === "--help" || current === "-h") {
      options.help = true;
      continue;
    }

    if (current === "--cwd") {
      options.cwd = parsePathFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--config") {
      options.configPath = parsePathFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--user") {
      options.user = parseDeployServiceUser(requireFlagValue(current, next), current);
      index += 1;
      continue;
    }

    if (current === "--domain") {
      options.domain = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--env-file" || current === "--ray-env-file") {
      options.envFile = parsePathFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--systemd-env-file") {
      options.systemdEnvFile = parsePathFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--gateway-runtime-binary") {
      options.runtimeBinary = normalizeGatewayRuntimeBinaryPath(
        requireFlagValue(current, next),
        current,
      );
      index += 1;
      continue;
    }

    if (current === "--node-binary") {
      options.nodeBinary = normalizeGatewayRuntimeBinaryPath(
        requireFlagValue(current, next),
        current,
      );
      index += 1;
      continue;
    }

    if (current === "--caddy-binary") {
      options.caddyBinary = normalizeCaddyBinaryPath(requireFlagValue(current, next), current);
      index += 1;
      continue;
    }

    if (current === "--output-dir") {
      options.outputDir = parsePathFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--memory-mib") {
      options.memoryBudgetMiB = parsePositiveIntegerFlag(
        requireFlagValue(current, next),
        "--memory-mib",
      );
      index += 1;
      continue;
    }

    if (current === "--strict-filesystem") {
      options.strictFilesystem = true;
      continue;
    }

    if (current === "--json") {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown option: ${current}`);
  }

  return options;
}

export async function runCli(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(DEPLOY_CLI_HELP.trimEnd());
    return 0;
  }

  const cwd = path.resolve(options.cwd);
  const resolvedOptions: CliOptions = {
    ...options,
    cwd,
    ...(options.envFile ? { envFile: path.resolve(cwd, options.envFile) } : {}),
    ...(options.systemdEnvFile
      ? { systemdEnvFile: path.resolve(cwd, options.systemdEnvFile) }
      : {}),
    ...(options.outputDir ? { outputDir: path.resolve(cwd, options.outputDir) } : {}),
  };

  if (resolvedOptions.systemdEnvFile && resolvedOptions.command !== "render") {
    throw new Error("--systemd-env-file is only supported by render");
  }

  const env = await loadEnvironment(resolvedOptions);
  const envRuntimeBinary = readNonEmptyEnvValue(env.RAY_GATEWAY_RUNTIME_BINARY);
  const envCaddyBinary = readNonEmptyEnvValue(env.RAY_DEPLOY_CADDY_BINARY);
  const envServiceUser =
    resolvedOptions.user === undefined
      ? parseOptionalServiceUserEnv(env.RAY_DEPLOY_SERVICE_USER)
      : undefined;
  const envDomain = readNonEmptyEnvValue(env.RAY_DEPLOY_DOMAIN);
  const envMemoryBudgetMiB =
    resolvedOptions.memoryBudgetMiB === undefined
      ? parseOptionalPositiveIntegerEnv(env.RAY_DEPLOY_MEMORY_MIB, "RAY_DEPLOY_MEMORY_MIB")
      : undefined;
  const deploymentOptions: CliOptions & { domain: string; user: string } = {
    ...resolvedOptions,
    user: resolvedOptions.user ?? envServiceUser ?? "ray",
    domain: resolvedOptions.domain ?? envDomain ?? "ray.local",
    ...(resolvedOptions.memoryBudgetMiB === undefined && envMemoryBudgetMiB !== undefined
      ? { memoryBudgetMiB: envMemoryBudgetMiB }
      : {}),
    ...(resolvedOptions.runtimeBinary === undefined &&
    resolvedOptions.nodeBinary === undefined &&
    envRuntimeBinary !== undefined
      ? {
          runtimeBinary: normalizeGatewayRuntimeBinaryPath(
            envRuntimeBinary,
            "RAY_GATEWAY_RUNTIME_BINARY",
          ),
        }
      : {}),
    ...(resolvedOptions.caddyBinary === undefined && envCaddyBinary !== undefined
      ? {
          caddyBinary: normalizeCaddyBinaryPath(envCaddyBinary, "RAY_DEPLOY_CADDY_BINARY"),
        }
      : {}),
  };

  if (deploymentOptions.command === "render") {
    const bundle = await renderDeploymentBundle({
      ...deploymentOptions,
      env,
      ...(deploymentOptions.strictFilesystem !== undefined
        ? { strictFilesystem: deploymentOptions.strictFilesystem }
        : {}),
    });
    assertRenderableDeploymentBundle(bundle);

    if (deploymentOptions.outputDir) {
      const files = await writeDeploymentBundleFiles(deploymentOptions.outputDir, bundle);
      console.log(JSON.stringify({ files }, null, 2));
      return 0;
    }

    if (deploymentOptions.json) {
      console.log(JSON.stringify(bundle, null, 2));
      return 0;
    }

    console.log("# Ray systemd service\n");
    console.log(bundle.service);
    if (bundle.llamaCppService) {
      console.log("\n# llama.cpp systemd service\n");
      console.log(bundle.llamaCppService);
    }
    console.log("\n# Caddyfile\n");
    console.log(bundle.caddyfile);
    console.log("\n# Environment File Example\n");
    console.log(bundle.envFileExample);
    console.log("\n# Summary\n");
    console.log(JSON.stringify(bundle.summary, null, 2));
    return 0;
  } else {
    const inspected = await loadAndDiagnoseDeployment({
      ...deploymentOptions,
      env,
      strictFilesystem:
        deploymentOptions.command === "doctor" || deploymentOptions.strictFilesystem === true,
    });
    const hasErrors = inspected.diagnostics.some((diagnostic) => diagnostic.level === "error");

    console.log(
      JSON.stringify(
        {
          configPath: inspected.configPath,
          profile: inspected.config.profile,
          diagnostics: inspected.diagnostics,
          preflight: inspected.preflight,
        },
        null,
        2,
      ),
    );

    if (
      (resolvedOptions.command === "validate" || resolvedOptions.command === "doctor") &&
      hasErrors
    ) {
      return 1;
    }

    return 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
