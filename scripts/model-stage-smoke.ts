import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectPublicConfigPaths } from "./deploy-smoke.ts";
import { createModelStagePlan, type ModelStagePlan } from "./model-stage.ts";

const DEFAULT_CONFIG_DIR = "examples/config";
const DEFAULT_SERVICE_USER = "ray";
const MAX_CLI_ARGS = 14;
const MAX_CLI_ARG_BYTES = 4_096;
const SYSTEMD_PRINCIPAL_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,30}|[0-9]{1,10})$/;

export interface ModelStageSmokeArgs {
  cwd: string;
  configDir: string;
  serviceUser: string;
  serviceGroup?: string;
  json: boolean;
  help: boolean;
}

export interface ModelStageSmokeResult {
  configPath: string;
  profile?: string;
  modelId?: string;
  modelPath?: string;
  binaryPath?: string;
  commandCount: number;
  errorCount: number;
  errorMessage?: string;
}

export interface ModelStageSmokeSummary {
  ok: boolean;
  configCount: number;
  stagedCount: number;
  errorCount: number;
  results: ModelStageSmokeResult[];
}

const HELP = `Dry-run model staging plans for public Ray llama.cpp deploy profiles.

Usage:
  bun ./scripts/model-stage-smoke.ts [options]

Options:
  --cwd <path>          Repository root. Default: current directory.
  --config-dir <path>   Directory containing public JSON config files. Default: ${DEFAULT_CONFIG_DIR}
  --user <name|uid>     Generated systemd service user to verify in staged commands. Default: ${DEFAULT_SERVICE_USER}
  --group <name|gid>    Group that should own staged GGUF files. Default: same as --user.
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

function normalizeServicePrincipal(value: string, label: string): string {
  if (!SYSTEMD_PRINCIPAL_PATTERN.test(value)) {
    throw new Error(
      `${label} must be a system account name, group name, numeric UID, or numeric GID using only letters, digits, underscores, or hyphens`,
    );
  }

  return value;
}

export function parseArgs(argv: string[]): ModelStageSmokeArgs {
  assertArgv(argv);

  const args: ModelStageSmokeArgs = {
    cwd: process.cwd(),
    configDir: DEFAULT_CONFIG_DIR,
    serviceUser: DEFAULT_SERVICE_USER,
    json: false,
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

function toSuccessResult(configPath: string, plan: ModelStagePlan): ModelStageSmokeResult {
  return {
    configPath,
    profile: plan.profile,
    modelId: plan.modelId,
    modelPath: plan.modelPath,
    binaryPath: plan.binaryPath,
    commandCount: plan.commands.length,
    errorCount: 0,
  };
}

export async function smokeModelStages(options: {
  cwd: string;
  configPaths: string[];
  serviceUser: string;
  serviceGroup?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelStageSmokeSummary> {
  const results: ModelStageSmokeResult[] = [];
  const env = options.env ?? (Object.create(null) as NodeJS.ProcessEnv);

  for (const configPath of options.configPaths) {
    try {
      const plan = await createModelStagePlan({
        cwd: options.cwd,
        configPath,
        env,
        serviceUser: options.serviceUser,
        ...(options.serviceGroup ? { serviceGroup: options.serviceGroup } : {}),
      });
      results.push(toSuccessResult(configPath, plan));
    } catch (error) {
      results.push({
        configPath,
        commandCount: 0,
        errorCount: 1,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
  const stagedCount = results.filter((result) => result.errorCount === 0).length;

  return {
    ok: errorCount === 0,
    configCount: results.length,
    stagedCount,
    errorCount,
    results,
  };
}

function displayPath(cwd: string, configPath: string): string {
  const relativePath = path.relative(cwd, configPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : configPath;
}

export function formatTextSummary(cwd: string, summary: ModelStageSmokeSummary): string {
  const lines = [
    `Rendered ${summary.configCount} public Ray model staging plan${summary.configCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    const profile = result.profile ? ` profile=${result.profile}` : "";
    const model = result.modelId ? ` model=${result.modelId}` : "";
    const modelPath = result.modelPath ? ` modelPath=${result.modelPath}` : "";
    const binary = result.binaryPath ? ` binary=${result.binaryPath}` : "";
    lines.push(
      `- ${status} ${displayPath(cwd, result.configPath)}${profile}${model}${modelPath}${binary} commands=${result.commandCount} errors=${result.errorCount}`,
    );

    if (result.errorMessage) {
      lines.push(`  error: ${result.errorMessage}`);
    }
  }

  lines.push(
    `Summary: staged=${summary.stagedCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
  );

  return lines.join("\n");
}

export async function runModelStageSmokeCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const cwd = path.resolve(args.cwd);
    const configPaths = await collectPublicConfigPaths(cwd, args.configDir);
    const summary = await smokeModelStages({
      cwd,
      configPaths,
      serviceUser: args.serviceUser,
      ...(args.serviceGroup ? { serviceGroup: args.serviceGroup } : {}),
    });

    io.stdout.write(
      args.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatTextSummary(cwd, summary)}\n`,
    );
    return summary.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelStageSmokeCli();
}
