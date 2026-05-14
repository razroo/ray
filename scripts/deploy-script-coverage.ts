import { access, open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectPublicConfigPaths } from "./deploy-smoke.ts";

const DEFAULT_CONFIG_DIR = "examples/config";
const DEFAULT_PACKAGE_JSON = "package.json";
const MAX_PUBLIC_CONFIG_FILES = 128;
const MAX_CLI_ARGS = 12;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_PACKAGE_JSON_BYTES = 512 * 1024;
const MAX_DEPLOY_SCRIPT_PATH_BYTES = 4_096;

type ScriptKind = "render" | "validate" | "doctor" | "modelStage";

interface ProfileScriptSpec {
  configFile: string;
  render: string;
  validate: string;
  doctor: string;
  modelStage?: string;
  memoryMiB?: number;
  modelStageUsesDefaultConfig?: boolean;
}

export interface DeployScriptCoverageArgs {
  cwd: string;
  configDir: string;
  packageJson: string;
  json: boolean;
  help: boolean;
}

interface DeployScriptCoverageOptions {
  cwd: string;
  configPaths: string[];
  scripts: Record<string, string>;
}

export interface DeployScriptCoverageDiagnostic {
  level: "error";
  code: string;
  message: string;
}

export interface DeployScriptCoverageResult {
  configPath: string;
  renderScript?: string;
  validateScript?: string;
  doctorScript?: string;
  modelStageScript?: string;
  diagnostics: DeployScriptCoverageDiagnostic[];
  errorCount: number;
}

export interface DeployScriptCoverageSummary {
  ok: boolean;
  configCount: number;
  errorCount: number;
  results: DeployScriptCoverageResult[];
}

const DEPLOY_PROFILE_SCRIPT_MATRIX: ProfileScriptSpec[] = [
  {
    configFile: "ray.sub1b.public.json",
    render: "render:service",
    validate: "validate:config:public",
    doctor: "doctor",
    modelStage: "model:stage",
    modelStageUsesDefaultConfig: true,
  },
  {
    configFile: "ray.sub1b.cax11.public.json",
    render: "render:service:cax11",
    validate: "validate:config:cax11:public",
    doctor: "doctor:cax11",
    modelStage: "model:stage:cax11",
  },
  {
    configFile: "ray.hetzner-cx23-qwen0.6b.public.json",
    render: "render:service:hetzner-email-ai",
    validate: "validate:config:hetzner:public",
    doctor: "doctor:hetzner-email-ai",
    modelStage: "model:stage:hetzner-email-ai",
    memoryMiB: 4_096,
  },
  {
    configFile: "ray.1b.public.json",
    render: "render:service:1b",
    validate: "validate:config:1b:public",
    doctor: "doctor:1b",
    modelStage: "model:stage:1b",
    memoryMiB: 4_096,
  },
  {
    configFile: "ray.1b.generic.public.json",
    render: "render:service:1b:generic",
    validate: "validate:config:1b:generic:public",
    doctor: "doctor:1b:generic",
    modelStage: "model:stage:1b:generic",
    memoryMiB: 4_096,
  },
  {
    configFile: "ray.1b.8gb.public.json",
    render: "render:service:1b:8gb",
    validate: "validate:config:1b:8gb:public",
    doctor: "doctor:1b:8gb",
    modelStage: "model:stage:1b:8gb",
    memoryMiB: 8_192,
  },
  {
    configFile: "ray.1b.8gb.generic.public.json",
    render: "render:service:1b:8gb:generic",
    validate: "validate:config:1b:8gb:generic:public",
    doctor: "doctor:1b:8gb:generic",
    modelStage: "model:stage:1b:8gb:generic",
    memoryMiB: 8_192,
  },
  {
    configFile: "ray.vps.json",
    render: "render:service:vps",
    validate: "validate:config:vps",
    doctor: "doctor:vps",
  },
  {
    configFile: "ray.balanced.json",
    render: "render:service:balanced",
    validate: "validate:config:balanced",
    doctor: "doctor:balanced",
  },
];

const MAX_DEPLOY_SCRIPT_CONFIGS =
  MAX_PUBLIC_CONFIG_FILES +
  DEPLOY_PROFILE_SCRIPT_MATRIX.filter((spec) => !spec.configFile.endsWith(".public.json")).length;

const HELP = `Validate package scripts for Ray deploy profiles.

Usage:
  bun ./scripts/deploy-script-coverage.ts [options]

Options:
  --cwd <path>           Repository root. Default: current directory.
  --config-dir <path>    Directory containing deploy JSON config files. Default: ${DEFAULT_CONFIG_DIR}
  --package-json <path>  package.json path. Default: ${DEFAULT_PACKAGE_JSON}
  --json                 Print machine-readable summary JSON.
  -h, --help             Show this help.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function assertDeployScriptPathValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must be a path without surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_SCRIPT_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_DEPLOY_SCRIPT_PATH_BYTES} bytes`);
  }
}

function assertDeployScriptsRecord(value: unknown): asserts value is Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("scripts must be an object");
  }

  let index = 0;
  for (const command of Object.values(value)) {
    if (typeof command !== "string") {
      throw new Error(`scripts[${index}] must be a string`);
    }
    index += 1;
  }
}

function assertDeployScriptCoverageOptions(
  options: unknown,
): asserts options is DeployScriptCoverageOptions {
  if (!isRecord(options)) {
    throw new Error("deploy script coverage options must be an object");
  }

  if (!Array.isArray(options.configPaths)) {
    throw new Error("configPaths must be an array");
  }

  assertDeployScriptsRecord(options.scripts);
}

function assertDeployScriptCoverageCliIo(
  io: unknown,
): asserts io is Pick<NodeJS.Process, "stdout" | "stderr"> {
  if (!isRecord(io)) {
    throw new Error("deploy script coverage io must be an object");
  }

  if (!isRecord(io.stdout) || typeof io.stdout.write !== "function") {
    throw new Error("deploy script coverage io.stdout.write must be a function");
  }

  if (!isRecord(io.stderr) || typeof io.stderr.write !== "function") {
    throw new Error("deploy script coverage io.stderr.write must be a function");
  }
}

export function parseArgs(argv: string[]): DeployScriptCoverageArgs {
  assertArgv(argv);

  const args: DeployScriptCoverageArgs = {
    cwd: process.cwd(),
    configDir: DEFAULT_CONFIG_DIR,
    packageJson: DEFAULT_PACKAGE_JSON,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--cwd") {
      const cwd = requireFlagValue(current, argv[index + 1]);
      assertDeployScriptPathValue(cwd, current);
      args.cwd = cwd;
      index += 1;
      continue;
    }

    if (current === "--config-dir") {
      const configDir = requireFlagValue(current, argv[index + 1]);
      assertDeployScriptPathValue(configDir, current);
      args.configDir = configDir;
      index += 1;
      continue;
    }

    if (current === "--package-json") {
      const packageJson = requireFlagValue(current, argv[index + 1]);
      assertDeployScriptPathValue(packageJson, current);
      args.packageJson = packageJson;
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

async function readPackageScripts(packageJsonPath: string): Promise<Record<string, string>> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let contents = "";

  try {
    fileHandle = await open(packageJsonPath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`package.json path must be a file: ${packageJsonPath}`);
    }

    if (stats.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(`package.json must be at most ${MAX_PACKAGE_JSON_BYTES} bytes`);
    }

    contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(`package.json must be at most ${MAX_PACKAGE_JSON_BYTES} bytes`);
    }
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }

  const parsed = JSON.parse(contents) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain an object");
  }

  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json must contain a scripts object");
  }

  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      throw new Error(`package.json script ${name} must be a string`);
    }
    result[name] = command;
  }

  return result;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function collectDeployScriptConfigPaths(
  cwd: string,
  configDir: string,
): Promise<string[]> {
  const configPaths = new Set(await collectPublicConfigPaths(cwd, configDir));
  const absoluteConfigDir = path.resolve(cwd, configDir);

  for (const spec of DEPLOY_PROFILE_SCRIPT_MATRIX) {
    const configPath = path.join(absoluteConfigDir, spec.configFile);
    if (await pathExists(configPath)) {
      configPaths.add(configPath);
    }
  }

  return [...configPaths].sort();
}

function displayPath(cwd: string, configPath: string): string {
  const relativePath = path.relative(cwd, configPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : configPath;
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function scriptCommandPrefix(kind: ScriptKind): string {
  switch (kind) {
    case "render":
      return "bun ./packages/deploy/dist/cli.js render";
    case "validate":
      return "bun ./packages/deploy/dist/cli.js validate";
    case "doctor":
      return "bun ./packages/deploy/dist/cli.js doctor";
    case "modelStage":
      return "bun ./scripts/model-stage.ts";
  }
}

function expectedScriptName(spec: ProfileScriptSpec, kind: ScriptKind): string | undefined {
  switch (kind) {
    case "render":
      return spec.render;
    case "validate":
      return spec.validate;
    case "doctor":
      return spec.doctor;
    case "modelStage":
      return spec.modelStage;
  }
}

function commandMatchesConfig(command: string, spec: ProfileScriptSpec, kind: ScriptKind): boolean {
  if (kind === "modelStage" && spec.modelStageUsesDefaultConfig && !command.includes("--config")) {
    return true;
  }

  return command.includes(`--config ./examples/config/${spec.configFile}`);
}

function validateProfileScript(
  scripts: Record<string, string>,
  spec: ProfileScriptSpec,
  kind: ScriptKind,
): DeployScriptCoverageDiagnostic[] {
  const scriptName = expectedScriptName(spec, kind);
  if (scriptName === undefined) {
    return [];
  }

  const command = scripts[scriptName];
  const diagnostics: DeployScriptCoverageDiagnostic[] = [];

  if (command === undefined) {
    return [
      {
        level: "error",
        code: "script_missing",
        message: `Missing package script ${scriptName} for ${spec.configFile}.`,
      },
    ];
  }

  const prefix = scriptCommandPrefix(kind);
  if (!command.startsWith(prefix)) {
    diagnostics.push({
      level: "error",
      code: "script_wrong_command",
      message: `${scriptName} should start with "${prefix}".`,
    });
  }

  if (!commandMatchesConfig(command, spec, kind)) {
    diagnostics.push({
      level: "error",
      code: "script_wrong_config",
      message: `${scriptName} should target ./examples/config/${spec.configFile}.`,
    });
  }

  if (kind === "render" && !command.includes("--systemd-env-file /etc/ray/ray.env")) {
    diagnostics.push({
      level: "error",
      code: "script_missing_systemd_env_file",
      message: `${scriptName} should render EnvironmentFile=/etc/ray/ray.env without loading local secrets.`,
    });
  }

  if (kind === "doctor" && !command.includes("--ray-env-file /etc/ray/ray.env")) {
    diagnostics.push({
      level: "error",
      code: "script_missing_ray_env_file",
      message: `${scriptName} should read /etc/ray/ray.env when running doctor on the VPS.`,
    });
  }

  if (
    spec.memoryMiB !== undefined &&
    (kind === "render" || kind === "doctor") &&
    !command.includes(`--memory-mib ${spec.memoryMiB}`)
  ) {
    diagnostics.push({
      level: "error",
      code: "script_missing_memory_budget",
      message: `${scriptName} should include --memory-mib ${spec.memoryMiB}.`,
    });
  }

  return diagnostics;
}

export function validateDeployScriptCoverage(options: {
  cwd: string;
  configPaths: string[];
  scripts: Record<string, string>;
}): DeployScriptCoverageSummary {
  assertDeployScriptCoverageOptions(options);
  if (options.configPaths.length > MAX_DEPLOY_SCRIPT_CONFIGS) {
    throw new Error(
      `Deploy script coverage can inspect at most ${MAX_DEPLOY_SCRIPT_CONFIGS} config files`,
    );
  }

  assertDeployScriptPathValue(options.cwd, "cwd");
  const cwd = path.resolve(options.cwd);
  for (const [index, configPath] of options.configPaths.entries()) {
    assertDeployScriptPathValue(configPath, `configPaths[${index}]`);
  }
  const configPaths = options.configPaths
    .map((configPath, index) => {
      const resolvedPath = path.resolve(cwd, configPath);
      if (!isPathInside(cwd, resolvedPath)) {
        throw new Error(`configPaths[${index}] must stay inside cwd`);
      }
      return resolvedPath;
    })
    .sort();

  const configByName = new Map(
    configPaths.map((configPath) => [path.basename(configPath), configPath]),
  );
  const specByConfig = new Map(
    DEPLOY_PROFILE_SCRIPT_MATRIX.map((spec) => [spec.configFile, spec] as const),
  );
  const results: DeployScriptCoverageResult[] = [];

  for (const spec of DEPLOY_PROFILE_SCRIPT_MATRIX) {
    const configPath = configByName.get(spec.configFile);
    const diagnostics: DeployScriptCoverageDiagnostic[] = [];

    if (!configPath) {
      diagnostics.push({
        level: "error",
        code: "deploy_config_missing",
        message: `Expected deploy config ${spec.configFile} was not found.`,
      });
    }

    diagnostics.push(...validateProfileScript(options.scripts, spec, "render"));
    diagnostics.push(...validateProfileScript(options.scripts, spec, "validate"));
    diagnostics.push(...validateProfileScript(options.scripts, spec, "doctor"));
    if (spec.modelStage !== undefined) {
      diagnostics.push(...validateProfileScript(options.scripts, spec, "modelStage"));
    }

    results.push({
      configPath: configPath ?? path.join(cwd, DEFAULT_CONFIG_DIR, spec.configFile),
      renderScript: spec.render,
      validateScript: spec.validate,
      doctorScript: spec.doctor,
      modelStageScript: spec.modelStage,
      diagnostics,
      errorCount: diagnostics.length,
    });
  }

  for (const configPath of configPaths) {
    const configFile = path.basename(configPath);
    if (specByConfig.has(configFile)) {
      continue;
    }

    const diagnostics: DeployScriptCoverageDiagnostic[] = [
      {
        level: "error",
        code: "public_config_uncovered",
        message: `Public config ${configFile} does not have package script coverage expectations.`,
      },
    ];

    results.push({
      configPath,
      diagnostics,
      errorCount: diagnostics.length,
    });
  }

  results.sort((left, right) => left.configPath.localeCompare(right.configPath));
  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);

  return {
    ok: errorCount === 0,
    configCount: results.length,
    errorCount,
    results,
  };
}

export function formatTextSummary(cwd: string, summary: DeployScriptCoverageSummary): string {
  const lines = [
    `Validated deploy script coverage for ${summary.configCount} Ray deploy profile${summary.configCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    const scripts = [
      result.renderScript ? `render=${result.renderScript}` : undefined,
      result.validateScript ? `validate=${result.validateScript}` : undefined,
      result.doctorScript ? `doctor=${result.doctorScript}` : undefined,
      result.modelStageScript ? `modelStage=${result.modelStageScript}` : undefined,
    ]
      .filter((entry) => entry !== undefined)
      .join(" ");
    lines.push(
      `- ${status} ${displayPath(cwd, result.configPath)}${scripts.length > 0 ? ` ${scripts}` : ""} errors=${result.errorCount}`,
    );

    for (const diagnostic of result.diagnostics) {
      lines.push(`  error ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  lines.push(`Summary: errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`);
  return lines.join("\n");
}

export async function runDeployScriptCoverageCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  assertDeployScriptCoverageCliIo(io);

  try {
    const args = parseArgs(argv);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const cwd = path.resolve(args.cwd);
    const configPaths = await collectDeployScriptConfigPaths(cwd, args.configDir);
    const scripts = await readPackageScripts(path.resolve(cwd, args.packageJson));
    const summary = validateDeployScriptCoverage({ cwd, configPaths, scripts });
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
  process.exitCode = await runDeployScriptCoverageCli();
}
