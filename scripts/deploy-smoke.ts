import { access, open, opendir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderDeploymentBundle, type DeploymentDiagnostic } from "../packages/deploy/src/index.ts";

const DEFAULT_CONFIG_DIR = "examples/config";
const DEFAULT_DOMAIN = "ray.example.com";
const DEFAULT_RUNTIME_BINARY = "/usr/local/bin/bun";
const DEFAULT_SERVICE_USER = "ray";
const DEFAULT_SYSTEMD_ENV_FILE = "/etc/ray/ray.env";
const STATIC_EXAMPLE_CONFIG = "examples/config/ray.sub1b.public.json";
const STATIC_EXAMPLE_GATEWAY_SERVICE = "examples/deploy/vps/ray-gateway.service";
const STATIC_EXAMPLE_LLAMA_CPP_SERVICE = "examples/deploy/vps/ray-llama-cpp.service";
const STATIC_EXAMPLE_CADDYFILE = "examples/deploy/vps/Caddyfile";
const EXTRA_DEPLOY_CONFIG_FILES = ["ray.vps.json", "ray.balanced.json"] as const;
const STATIC_EXAMPLE_WORKING_DIRECTORY = "/srv/ray";
const STATIC_EXAMPLE_CONFIG_PATH = "/etc/ray/ray.json";
const MAX_CONFIG_FILES = 128;
const MAX_DEPLOY_SMOKE_CONFIGS = MAX_CONFIG_FILES + EXTRA_DEPLOY_CONFIG_FILES.length;
const MAX_CLI_ARGS = 24;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_DEPLOY_SMOKE_PATH_BYTES = 4_096;
const MAX_STATIC_EXAMPLE_BYTES = 256 * 1024;

export interface DeploySmokeArgs {
  cwd: string;
  configDir: string;
  domain: string;
  runtimeBinary: string;
  serviceUser: string;
  systemdEnvFile: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

export interface DeploySmokeResult {
  configPath: string;
  profile?: string;
  hasLlamaCppService: boolean;
  gatewayMemoryMaxMiB?: number;
  gatewayMemorySwapMaxMiB?: number;
  llamaCppMemoryMaxMiB?: number;
  llamaCppMemorySwapMaxMiB?: number;
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
  staticExample?: DeployStaticExampleResult;
}

export interface DeployStaticExampleResult {
  servicePath: string;
  llamaCppServicePath: string;
  caddyfilePath: string;
  diagnostics: DeploymentDiagnostic[];
  errorCount: number;
}

const HELP = `Dry-run Ray VPS deployment bundles.

Usage:
  bun ./scripts/deploy-smoke.ts [options]

Options:
  --cwd <path>                 Repository root. Default: current directory.
  --config-dir <path>          Directory containing deploy JSON config files. Default: ${DEFAULT_CONFIG_DIR}
  --domain <host>              Caddy site address to render. Default: ${DEFAULT_DOMAIN}
  --gateway-runtime <path>     Runtime path rendered into ray-gateway.service. Default: ${DEFAULT_RUNTIME_BINARY}
  --user <name>                systemd service user to render. Default: ${DEFAULT_SERVICE_USER}
  --systemd-env-file <path>    EnvironmentFile path rendered into systemd units. Default: ${DEFAULT_SYSTEMD_ENV_FILE}
  --json                       Print machine-readable summary JSON.
  --verbose                    Print warning diagnostic details in text output.
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

function assertDeploySmokePathValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must be a path without surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_SMOKE_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_DEPLOY_SMOKE_PATH_BYTES} bytes`);
  }
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

export async function collectPublicConfigPaths(cwd: string, configDir: string): Promise<string[]> {
  assertDeploySmokePathValue(cwd, "cwd");
  assertDeploySmokePathValue(configDir, "configDir");
  const absoluteConfigDir = path.resolve(cwd, configDir);
  const configPaths: string[] = [];
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;

  try {
    directory = await opendir(absoluteConfigDir);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith(".public.json")) {
        continue;
      }

      configPaths.push(path.join(absoluteConfigDir, entry.name));
      if (configPaths.length > MAX_CONFIG_FILES) {
        throw new Error(
          `Config directory must contain at most ${MAX_CONFIG_FILES} public JSON files`,
        );
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
    throw new Error(`No public JSON config files found in ${absoluteConfigDir}`);
  }

  return configPaths;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function collectDeploySmokeConfigPaths(
  cwd: string,
  configDir: string,
): Promise<string[]> {
  const configPaths = new Set(await collectPublicConfigPaths(cwd, configDir));
  const absoluteConfigDir = path.resolve(cwd, configDir);

  for (const configFile of EXTRA_DEPLOY_CONFIG_FILES) {
    const configPath = path.join(absoluteConfigDir, configFile);
    if (await pathExists(configPath)) {
      configPaths.add(configPath);
    }
  }

  return [...configPaths].sort();
}

export async function smokeDeployConfigs(options: {
  cwd: string;
  configPaths: string[];
  domain: string;
  runtimeBinary: string;
  serviceUser: string;
  systemdEnvFile: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DeploySmokeSummary> {
  if (options.configPaths.length > MAX_DEPLOY_SMOKE_CONFIGS) {
    throw new Error(`Deploy smoke can inspect at most ${MAX_DEPLOY_SMOKE_CONFIGS} config files`);
  }

  assertDeploySmokePathValue(options.cwd, "cwd");
  assertDeploySmokePathValue(options.runtimeBinary, "runtimeBinary");
  assertDeploySmokePathValue(options.systemdEnvFile, "systemdEnvFile");
  for (const [index, configPath] of options.configPaths.entries()) {
    assertDeploySmokePathValue(configPath, `configPaths[${index}]`);
  }

  const env = buildSmokeDeployEnv(options.env ?? process.env);
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
        env,
        inspectHostStorage: false,
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
        gatewayMemorySwapMaxMiB: bundle.summary.systemd.gateway.memorySwapMaxMiB,
        ...(bundle.summary.systemd.llamaCpp
          ? {
              llamaCppMemoryMaxMiB: bundle.summary.systemd.llamaCpp.memoryMaxMiB,
              llamaCppMemorySwapMaxMiB: bundle.summary.systemd.llamaCpp.memorySwapMaxMiB,
            }
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

async function readStaticExampleFile(filePath: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`Static deploy example path must be a file: ${filePath}`);
    }

    if (stats.size > MAX_STATIC_EXAMPLE_BYTES) {
      throw new Error(
        `Static deploy example must be at most ${MAX_STATIC_EXAMPLE_BYTES} bytes: ${filePath}`,
      );
    }

    const contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_STATIC_EXAMPLE_BYTES) {
      throw new Error(
        `Static deploy example must be at most ${MAX_STATIC_EXAMPLE_BYTES} bytes: ${filePath}`,
      );
    }

    return contents.replace(/\r\n/g, "\n");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function normalizeRenderedStaticExample(
  contents: string,
  options: { cwd: string; configPath: string },
): string {
  const cwd = path.resolve(options.cwd);
  const configPath = path.resolve(options.cwd, options.configPath);

  return contents
    .replace(/\r\n/g, "\n")
    .replaceAll(configPath, STATIC_EXAMPLE_CONFIG_PATH)
    .replaceAll(cwd, STATIC_EXAMPLE_WORKING_DIRECTORY);
}

function compareStaticExample(
  diagnostics: DeploymentDiagnostic[],
  options: {
    label: string;
    code: string;
    filePath: string;
    expected: string;
    actual: string;
  },
): void {
  if (options.actual !== options.expected) {
    diagnostics.push({
      level: "error",
      code: options.code,
      message: `${options.label} at ${options.filePath} has drifted from the deploy renderer. Regenerate or update the checked-in VPS example before relying on manual deployment docs.`,
    });
  }
}

export async function validateStaticVpsExamples(options: {
  cwd: string;
  servicePath?: string;
  llamaCppServicePath?: string;
  caddyfilePath?: string;
}): Promise<DeployStaticExampleResult> {
  assertDeploySmokePathValue(options.cwd, "cwd");
  if (options.servicePath !== undefined) {
    assertDeploySmokePathValue(options.servicePath, "servicePath");
  }
  if (options.llamaCppServicePath !== undefined) {
    assertDeploySmokePathValue(options.llamaCppServicePath, "llamaCppServicePath");
  }
  if (options.caddyfilePath !== undefined) {
    assertDeploySmokePathValue(options.caddyfilePath, "caddyfilePath");
  }

  const cwd = path.resolve(options.cwd);
  const configPath = path.join(cwd, STATIC_EXAMPLE_CONFIG);
  const servicePath = path.resolve(cwd, options.servicePath ?? STATIC_EXAMPLE_GATEWAY_SERVICE);
  const llamaCppServicePath = path.resolve(
    cwd,
    options.llamaCppServicePath ?? STATIC_EXAMPLE_LLAMA_CPP_SERVICE,
  );
  const caddyfilePath = path.resolve(cwd, options.caddyfilePath ?? STATIC_EXAMPLE_CADDYFILE);
  const diagnostics: DeploymentDiagnostic[] = [];

  try {
    const bundle = await renderDeploymentBundle({
      cwd,
      configPath,
      user: DEFAULT_SERVICE_USER,
      domain: DEFAULT_DOMAIN,
      systemdEnvFile: DEFAULT_SYSTEMD_ENV_FILE,
      runtimeBinary: DEFAULT_RUNTIME_BINARY,
      inspectHostStorage: false,
    });
    const expectedService = normalizeRenderedStaticExample(bundle.service, { cwd, configPath });
    const expectedLlamaCppService = bundle.llamaCppService;
    const expectedCaddyfile = bundle.caddyfile.replace(/\r\n/g, "\n");
    const [actualService, actualLlamaCppService, actualCaddyfile] = await Promise.all([
      readStaticExampleFile(servicePath),
      readStaticExampleFile(llamaCppServicePath),
      readStaticExampleFile(caddyfilePath),
    ]);

    compareStaticExample(diagnostics, {
      label: "Static Ray gateway systemd example",
      code: "static_vps_gateway_service_drift",
      filePath: servicePath,
      expected: expectedService,
      actual: actualService,
    });

    if (expectedLlamaCppService === undefined) {
      diagnostics.push({
        level: "error",
        code: "static_vps_llama_cpp_service_unexpected",
        message: `Static llama.cpp systemd example exists at ${llamaCppServicePath}, but the canonical public VPS profile no longer renders a llama.cpp service.`,
      });
    } else {
      compareStaticExample(diagnostics, {
        label: "Static llama.cpp systemd example",
        code: "static_vps_llama_cpp_service_drift",
        filePath: llamaCppServicePath,
        expected: expectedLlamaCppService,
        actual: actualLlamaCppService,
      });
    }

    compareStaticExample(diagnostics, {
      label: "Static Caddyfile example",
      code: "static_vps_caddyfile_drift",
      filePath: caddyfilePath,
      expected: expectedCaddyfile,
      actual: actualCaddyfile,
    });
  } catch (error) {
    diagnostics.push({
      level: "error",
      code: "static_vps_examples_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    servicePath,
    llamaCppServicePath,
    caddyfilePath,
    diagnostics,
    errorCount: diagnostics.length,
  };
}

function attachStaticExample(
  summary: DeploySmokeSummary,
  staticExample: DeployStaticExampleResult,
): DeploySmokeSummary {
  const errorCount = summary.errorCount + staticExample.errorCount;

  return {
    ...summary,
    staticExample,
    errorCount,
    ok: errorCount === 0,
  };
}

function buildSmokeDeployEnv(_env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(_env)) {
    if (name.startsWith("RAY_") || value === undefined) {
      continue;
    }

    env[name] = value;
  }

  return env;
}

function displayPath(cwd: string, configPath: string): string {
  const relativePath = path.relative(cwd, configPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : configPath;
}

export function formatTextSummary(
  cwd: string,
  summary: DeploySmokeSummary,
  options: { verbose?: boolean } = {},
): string {
  const lines = [
    `Rendered ${summary.configCount} Ray deploy profile${summary.configCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    const profile = result.profile ? ` profile=${result.profile}` : "";
    const llama = result.hasLlamaCppService
      ? ` llamaMemoryMax=${result.llamaCppMemoryMaxMiB ?? "unknown"}MiB llamaSwapMax=${result.llamaCppMemorySwapMaxMiB ?? "unknown"}MiB`
      : " llamaService=none";
    lines.push(
      `- ${status} ${displayPath(cwd, result.configPath)}${profile} gatewayMemoryMax=${result.gatewayMemoryMaxMiB ?? "unknown"}MiB gatewaySwapMax=${result.gatewayMemorySwapMaxMiB ?? "unknown"}MiB${llama} warnings=${result.warningCount} errors=${result.errorCount}`,
    );

    for (const diagnostic of result.diagnostics) {
      if (diagnostic.level !== "error" && !(options.verbose && diagnostic.level === "warn")) {
        continue;
      }
      lines.push(`  ${diagnostic.level} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  if (summary.staticExample) {
    const status = summary.staticExample.errorCount > 0 ? "FAIL" : "OK";
    lines.push(
      `- ${status} static VPS examples gateway=${displayPath(cwd, summary.staticExample.servicePath)} llama=${displayPath(cwd, summary.staticExample.llamaCppServicePath)} caddy=${displayPath(cwd, summary.staticExample.caddyfilePath)} errors=${summary.staticExample.errorCount}`,
    );

    for (const diagnostic of summary.staticExample.diagnostics) {
      lines.push(`  ${diagnostic.level} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  if (summary.warningCount > 0 && !options.verbose) {
    lines.push("Run with --verbose to print warning diagnostics.");
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
    const configPaths = await collectDeploySmokeConfigPaths(cwd, args.configDir);
    const deploySummary = await smokeDeployConfigs({
      cwd,
      configPaths,
      domain: args.domain,
      runtimeBinary: args.runtimeBinary,
      serviceUser: args.serviceUser,
      systemdEnvFile: args.systemdEnvFile,
    });
    const summary = attachStaticExample(deploySummary, await validateStaticVpsExamples({ cwd }));

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
  process.exitCode = await runDeploySmokeCli();
}
