import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderDeploymentBundle, type DeploymentDiagnostic } from "../packages/deploy/src/index.ts";

const DEFAULT_CONFIG_DIR = "examples/config";
const DEFAULT_DOMAIN = "ray.example.com";
const DEFAULT_RUNTIME_BINARY = "/usr/local/bin/bun";
const DEFAULT_SERVICE_USER = "ray";
const DEFAULT_SYSTEMD_ENV_FILE = "/etc/ray/ray.env";
const MAX_CONFIG_FILES = 128;
const MAX_CLI_ARGS = 24;
const MAX_CLI_ARG_BYTES = 4_096;

export interface DeploySmokeArgs {
  cwd: string;
  configDir: string;
  domain: string;
  runtimeBinary: string;
  serviceUser: string;
  systemdEnvFile: string;
  json: boolean;
  help: boolean;
}

export interface DeploySmokeResult {
  configPath: string;
  profile?: string;
  hasLlamaCppService: boolean;
  gatewayMemoryMaxMiB?: number;
  llamaCppMemoryMaxMiB?: number;
  diagnostics: DeploymentDiagnostic[];
  errorCount: number;
  warningCount: number;
}

export interface DeploySmokeSummary {
  ok: boolean;
  configCount: number;
  errorCount: number;
  warningCount: number;
  results: DeploySmokeResult[];
}

const HELP = `Dry-run public Ray VPS deployment bundles.

Usage:
  bun ./scripts/deploy-smoke.ts [options]

Options:
  --cwd <path>                 Repository root. Default: current directory.
  --config-dir <path>          Directory containing public JSON config files. Default: ${DEFAULT_CONFIG_DIR}
  --domain <host>              Caddy site address to render. Default: ${DEFAULT_DOMAIN}
  --gateway-runtime <path>     Runtime path rendered into ray-gateway.service. Default: ${DEFAULT_RUNTIME_BINARY}
  --user <name>                systemd service user to render. Default: ${DEFAULT_SERVICE_USER}
  --systemd-env-file <path>    EnvironmentFile path rendered into systemd units. Default: ${DEFAULT_SYSTEMD_ENV_FILE}
  --json                       Print machine-readable summary JSON.
  -h, --help                   Show this help.
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

export function parseArgs(argv: string[]): DeploySmokeArgs {
  assertArgv(argv);

  const args: DeploySmokeArgs = {
    cwd: process.cwd(),
    configDir: DEFAULT_CONFIG_DIR,
    domain: DEFAULT_DOMAIN,
    runtimeBinary: DEFAULT_RUNTIME_BINARY,
    serviceUser: DEFAULT_SERVICE_USER,
    systemdEnvFile: DEFAULT_SYSTEMD_ENV_FILE,
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

    if (current === "--domain") {
      args.domain = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--gateway-runtime") {
      args.runtimeBinary = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--user") {
      args.serviceUser = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--systemd-env-file") {
      args.systemdEnvFile = requireFlagValue(current, argv[index + 1]);
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

export async function collectPublicConfigPaths(cwd: string, configDir: string): Promise<string[]> {
  const absoluteConfigDir = path.resolve(cwd, configDir);
  const entries = await readdir(absoluteConfigDir, { withFileTypes: true });
  const configPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".public.json"))
    .map((entry) => path.join(absoluteConfigDir, entry.name))
    .sort();

  if (configPaths.length === 0) {
    throw new Error(`No public JSON config files found in ${absoluteConfigDir}`);
  }

  if (configPaths.length > MAX_CONFIG_FILES) {
    throw new Error(`Config directory must contain at most ${MAX_CONFIG_FILES} public JSON files`);
  }

  return configPaths;
}

export async function smokeDeployConfigs(options: {
  cwd: string;
  configPaths: string[];
  domain: string;
  runtimeBinary: string;
  serviceUser: string;
  systemdEnvFile: string;
}): Promise<DeploySmokeSummary> {
  const results: DeploySmokeResult[] = [];

  for (const configPath of options.configPaths) {
    try {
      const bundle = await renderDeploymentBundle({
        cwd: options.cwd,
        configPath,
        user: options.serviceUser,
        domain: options.domain,
        systemdEnvFile: options.systemdEnvFile,
        runtimeBinary: options.runtimeBinary,
      });
      const errorCount = bundle.summary.diagnostics.filter(
        (diagnostic) => diagnostic.level === "error",
      ).length;
      const warningCount = bundle.summary.diagnostics.filter(
        (diagnostic) => diagnostic.level === "warn",
      ).length;

      results.push({
        configPath,
        profile: bundle.summary.profile,
        hasLlamaCppService: bundle.llamaCppService !== undefined,
        gatewayMemoryMaxMiB: bundle.summary.systemd.gateway.memoryMaxMiB,
        ...(bundle.summary.systemd.llamaCpp
          ? { llamaCppMemoryMaxMiB: bundle.summary.systemd.llamaCpp.memoryMaxMiB }
          : {}),
        diagnostics: bundle.summary.diagnostics,
        errorCount,
        warningCount,
      });
    } catch (error) {
      results.push({
        configPath,
        hasLlamaCppService: false,
        diagnostics: [
          {
            level: "error",
            code: "deploy_render_failed",
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

  return {
    ok: errorCount === 0,
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

export function formatTextSummary(cwd: string, summary: DeploySmokeSummary): string {
  const lines = [
    `Rendered ${summary.configCount} public Ray deploy profile${summary.configCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    const profile = result.profile ? ` profile=${result.profile}` : "";
    const llama = result.hasLlamaCppService
      ? ` llamaMemoryMax=${result.llamaCppMemoryMaxMiB ?? "unknown"}MiB`
      : " llamaService=none";
    lines.push(
      `- ${status} ${displayPath(cwd, result.configPath)}${profile} gatewayMemoryMax=${result.gatewayMemoryMaxMiB ?? "unknown"}MiB${llama} warnings=${result.warningCount} errors=${result.errorCount}`,
    );

    for (const diagnostic of result.diagnostics) {
      if (diagnostic.level !== "error") {
        continue;
      }
      lines.push(`  error ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  if (summary.warningCount > 0) {
    lines.push("Warnings are expected on hosts without the target /var/lib/ray storage layout.");
  }

  lines.push(
    `Summary: warnings=${summary.warningCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
  );

  return lines.join("\n");
}

export async function runDeploySmokeCli(
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
    const summary = await smokeDeployConfigs({
      cwd,
      configPaths,
      domain: args.domain,
      runtimeBinary: args.runtimeBinary,
      serviceUser: args.serviceUser,
      systemdEnvFile: args.systemdEnvFile,
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
  process.exitCode = await runDeploySmokeCli();
}
