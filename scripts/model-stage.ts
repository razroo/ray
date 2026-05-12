import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const SYSTEMD_PRINCIPAL_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

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
  const commands = [
    `sudo install -d -m 0755 ${shellQuote(plan.binaryDirectory)}`,
    `sudo install -D -m 0755 -- ${shellQuote(binarySourcePath)} ${shellQuote(plan.binaryPath)}`,
    `sudo -u ${shellQuote(plan.serviceUser)} test -x ${shellQuote(plan.binaryPath)}`,
    `sudo install -d -m 0755 ${shellQuote(plan.modelDirectory)}`,
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

    io.stdout.write(
      args.json ? `${JSON.stringify(plan, null, 2)}\n` : `${formatTextPlan(cwd, plan)}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelStageCli();
}
