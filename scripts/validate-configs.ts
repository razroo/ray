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
const MAX_PUBLIC_REQUEST_BODY_LIMIT_BYTES = 64_000;
const MAX_PUBLIC_RATE_LIMIT_WINDOW_MS = 3_600_000;
const MAX_PUBLIC_RATE_LIMIT_REQUESTS = 300;
const MAX_PUBLIC_RATE_LIMIT_KEYS = 8_192;
const MAX_PUBLIC_SERVER_PORT = 65_535;

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
