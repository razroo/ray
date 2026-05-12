import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT_PACKAGE_JSON = "package.json";
const DEFAULT_WORKFLOW_DIR = ".github/workflows";
const MAX_CLI_ARGS = 8;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_PACKAGE_JSON_BYTES = 512 * 1024;
const MAX_PACKAGE_JSON_FILES = 128;
const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_WORKFLOW_FILES = 64;
const skipDirectoryNames = new Set([".git", ".ray", "dist", "node_modules"]);
const forbiddenLockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;
const forbiddenPackageManagerPattern =
  /(?:^|[\s;&|()])(?:(?:pnpm|yarn|npx)(?:\s|$)|npm(?:\s+(?:ci|exec|install|publish|run|test)\b|\s*$))/;
const forbiddenWorkflowPackageManagerPattern =
  /(?:^|[\s:>"'`&;|()])(?:(?:pnpm|yarn|npx)(?:\s|$)|npm\s+(?:ci|exec|install|run|test)\b)/;

export interface PackageRuntimeCoverageArgs {
  cwd: string;
  json: boolean;
  help: boolean;
}

export interface PackageRuntimeCoverageDiagnostic {
  level: "error";
  code: string;
  message: string;
  packagePath?: string;
  workflowPath?: string;
  scriptName?: string;
  line?: number;
}

export interface PackageRuntimeCoverageResult {
  kind: "package" | "workflow" | "lockfile";
  packagePath: string;
  packageName?: string;
  packageManager?: string;
  scriptCount: number;
  workflowLineCount?: number;
  diagnostics: PackageRuntimeCoverageDiagnostic[];
  errorCount: number;
}

export interface PackageRuntimeCoverageSummary {
  ok: boolean;
  packageCount: number;
  workflowCount: number;
  scriptCount: number;
  errorCount: number;
  forbiddenLockfiles: string[];
  results: PackageRuntimeCoverageResult[];
}

const HELP = `Validate Bun-first package and workflow runtime coverage.

Usage:
  bun ./scripts/package-runtime-coverage.ts [options]

Options:
  --cwd <path>  Repository root. Default: current directory.
  --json        Print machine-readable summary JSON.
  -h, --help    Show this help.
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

export function parseArgs(argv: string[]): PackageRuntimeCoverageArgs {
  assertArgv(argv);

  const args: PackageRuntimeCoverageArgs = {
    cwd: process.cwd(),
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectPackageJsonPathsFromDirectory(
  currentDirectory: string,
  packageJsonPaths: string[],
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (skipDirectoryNames.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectPackageJsonPathsFromDirectory(absolutePath, packageJsonPaths);
      continue;
    }

    if (entry.isFile() && entry.name === DEFAULT_ROOT_PACKAGE_JSON) {
      packageJsonPaths.push(absolutePath);
    }
  }
}

export async function collectPackageJsonPaths(cwd: string): Promise<string[]> {
  const packageJsonPaths: string[] = [];
  await collectPackageJsonPathsFromDirectory(cwd, packageJsonPaths);
  packageJsonPaths.sort();

  if (packageJsonPaths.length === 0) {
    throw new Error(`No package.json files found in ${cwd}`);
  }

  if (packageJsonPaths.length > MAX_PACKAGE_JSON_FILES) {
    throw new Error(`Repository must contain at most ${MAX_PACKAGE_JSON_FILES} package.json files`);
  }

  return packageJsonPaths;
}

async function collectWorkflowPaths(cwd: string): Promise<string[]> {
  const workflowDirectory = path.join(cwd, DEFAULT_WORKFLOW_DIR);

  try {
    const entries = await readdir(workflowDirectory, { withFileTypes: true });
    const workflowPaths = entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => path.join(workflowDirectory, entry.name))
      .sort();

    if (workflowPaths.length > MAX_WORKFLOW_FILES) {
      throw new Error(
        `Repository must contain at most ${MAX_WORKFLOW_FILES} GitHub workflow files`,
      );
    }

    return workflowPaths;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readPackageJson(packageJsonPath: string): Promise<Record<string, unknown>> {
  const contents = await readFile(packageJsonPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_PACKAGE_JSON_BYTES) {
    throw new Error(`package.json must be at most ${MAX_PACKAGE_JSON_BYTES} bytes`);
  }

  const parsed = JSON.parse(contents) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain an object");
  }

  return parsed as Record<string, unknown>;
}

function readScripts(parsedPackage: Record<string, unknown>): Record<string, string> {
  const scripts = parsedPackage.scripts;
  if (scripts === undefined) {
    return {};
  }

  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    throw new Error("package.json scripts must be an object");
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

function displayPath(cwd: string, filePath: string): string {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

function validateRootPackageManager(
  cwd: string,
  packageJsonPath: string,
  parsedPackage: Record<string, unknown>,
): PackageRuntimeCoverageDiagnostic[] {
  if (path.resolve(cwd, DEFAULT_ROOT_PACKAGE_JSON) !== packageJsonPath) {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const packageManager = parsedPackage.packageManager;
  const engines = parsedPackage.engines;
  const bunEngine =
    typeof engines === "object" && engines !== null && !Array.isArray(engines)
      ? (engines as Record<string, unknown>).bun
      : undefined;

  if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) {
    diagnostics.push({
      level: "error",
      code: "root_package_manager_not_bun",
      packagePath: packageJsonPath,
      message: "Root package.json must pin packageManager to bun@<version>.",
    });
  }

  if (typeof bunEngine !== "string" || bunEngine.trim().length === 0) {
    diagnostics.push({
      level: "error",
      code: "root_bun_engine_missing",
      packagePath: packageJsonPath,
      message: "Root package.json must declare engines.bun for deploy/runtime reproducibility.",
    });
  }

  return diagnostics;
}

function validateScripts(
  packageJsonPath: string,
  scripts: Record<string, string>,
): PackageRuntimeCoverageDiagnostic[] {
  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    if (forbiddenPackageManagerPattern.test(command)) {
      diagnostics.push({
        level: "error",
        code: "non_bun_package_manager_script",
        packagePath: packageJsonPath,
        scriptName: name,
        message: `Script "${name}" invokes a non-Bun package manager. Use bun/bunx or a direct binary instead.`,
      });
    }
  }

  return diagnostics;
}

function isLocalHealthCurl(line: string): boolean {
  return (
    /\bcurl\b/.test(line) &&
    line.includes("http://127.0.0.1:") &&
    (line.includes("/livez") || line.includes("/readyz"))
  );
}

function isPipedShellCurl(line: string): boolean {
  return /\bcurl\b/.test(line) && /\|\s*(?:bash|sh)\b/.test(line);
}

async function validateWorkflow(
  workflowPath: string,
): Promise<{ lineCount: number; diagnostics: PackageRuntimeCoverageDiagnostic[] }> {
  const contents = await readFile(workflowPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_WORKFLOW_BYTES) {
    throw new Error(`GitHub workflow must be at most ${MAX_WORKFLOW_BYTES} bytes`);
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const lines = contents.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (forbiddenWorkflowPackageManagerPattern.test(line)) {
      diagnostics.push({
        level: "error",
        code: "non_bun_workflow_package_manager",
        workflowPath,
        line: index + 1,
        message:
          "Workflow command invokes pnpm/yarn/npx or npm install/run/test. Use bun, bunx, or a direct binary instead; npm publish is only allowed in release jobs.",
      });
    }

    if (isLocalHealthCurl(line) && !line.includes("--max-time")) {
      diagnostics.push({
        level: "error",
        code: "unbounded_workflow_health_probe",
        workflowPath,
        line: index + 1,
        message:
          "Workflow localhost health probes must pass curl --max-time so VPS deploy readiness loops honor their timeout windows.",
      });
    }

    if (
      isPipedShellCurl(line) &&
      (!line.includes("--max-time") ||
        !line.includes("--connect-timeout") ||
        !line.includes("--retry"))
    ) {
      diagnostics.push({
        level: "error",
        code: "unbounded_workflow_curl_install",
        workflowPath,
        line: index + 1,
        message:
          "Workflow curl-to-shell installers must pass curl --retry, --connect-timeout, and --max-time so VPS bootstrap cannot hang on a stalled external download.",
      });
    }
  }

  return {
    lineCount: lines.length,
    diagnostics,
  };
}

export async function validatePackageRuntimeCoverage(options: {
  cwd: string;
  packageJsonPaths: string[];
}): Promise<PackageRuntimeCoverageSummary> {
  const cwd = path.resolve(options.cwd);
  const results: PackageRuntimeCoverageResult[] = [];
  const workflowPaths = await collectWorkflowPaths(cwd);

  for (const packageJsonPath of options.packageJsonPaths.map((filePath) =>
    path.resolve(filePath),
  )) {
    try {
      const parsedPackage = await readPackageJson(packageJsonPath);
      const packageName = typeof parsedPackage.name === "string" ? parsedPackage.name : undefined;
      const packageManager =
        typeof parsedPackage.packageManager === "string" ? parsedPackage.packageManager : undefined;
      const scripts = readScripts(parsedPackage);
      const diagnostics = [
        ...validateRootPackageManager(cwd, packageJsonPath, parsedPackage),
        ...validateScripts(packageJsonPath, scripts),
      ];

      results.push({
        kind: "package",
        packagePath: packageJsonPath,
        ...(packageName ? { packageName } : {}),
        ...(packageManager ? { packageManager } : {}),
        scriptCount: Object.keys(scripts).length,
        diagnostics,
        errorCount: diagnostics.length,
      });
    } catch (error) {
      results.push({
        kind: "package",
        packagePath: packageJsonPath,
        scriptCount: 0,
        diagnostics: [
          {
            level: "error",
            code: "package_json_invalid",
            packagePath: packageJsonPath,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        errorCount: 1,
      });
    }
  }

  for (const workflowPath of workflowPaths) {
    try {
      const { lineCount, diagnostics } = await validateWorkflow(workflowPath);
      results.push({
        kind: "workflow",
        packagePath: workflowPath,
        workflowLineCount: lineCount,
        scriptCount: 0,
        diagnostics,
        errorCount: diagnostics.length,
      });
    } catch (error) {
      results.push({
        kind: "workflow",
        packagePath: workflowPath,
        scriptCount: 0,
        diagnostics: [
          {
            level: "error",
            code: "workflow_invalid",
            workflowPath,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        errorCount: 1,
      });
    }
  }

  const lockfileDiagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const foundForbiddenLockfiles: string[] = [];
  for (const lockfile of forbiddenLockfiles) {
    const lockfilePath = path.join(cwd, lockfile);
    if (await pathExists(lockfilePath)) {
      foundForbiddenLockfiles.push(lockfilePath);
      lockfileDiagnostics.push({
        level: "error",
        code: "non_bun_lockfile_present",
        packagePath: lockfilePath,
        message: `Remove ${lockfile}; this repo uses bun.lock as its package-manager lockfile.`,
      });
    }
  }

  if (lockfileDiagnostics.length > 0) {
    results.push({
      kind: "lockfile",
      packagePath: cwd,
      scriptCount: 0,
      diagnostics: lockfileDiagnostics,
      errorCount: lockfileDiagnostics.length,
    });
  }

  const scriptCount = results.reduce((total, result) => total + result.scriptCount, 0);
  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);

  return {
    ok: errorCount === 0,
    packageCount: options.packageJsonPaths.length,
    workflowCount: workflowPaths.length,
    scriptCount,
    errorCount,
    forbiddenLockfiles: foundForbiddenLockfiles,
    results,
  };
}

export function formatTextSummary(cwd: string, summary: PackageRuntimeCoverageSummary): string {
  const lines = [
    `Checked ${summary.packageCount} package manifest${summary.packageCount === 1 ? "" : "s"} and ${summary.workflowCount} GitHub workflow${summary.workflowCount === 1 ? "" : "s"} for Bun-first runtime coverage:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    if (result.kind === "workflow") {
      lines.push(
        `- ${status} ${displayPath(cwd, result.packagePath)} workflow lines=${result.workflowLineCount ?? 0} errors=${result.errorCount}`,
      );
    } else {
      const name = result.packageName ? ` name=${result.packageName}` : "";
      const packageManager = result.packageManager
        ? ` packageManager=${result.packageManager}`
        : "";
      lines.push(
        `- ${status} ${displayPath(cwd, result.packagePath)}${name}${packageManager} scripts=${result.scriptCount} errors=${result.errorCount}`,
      );
    }

    for (const diagnostic of result.diagnostics) {
      const script = diagnostic.scriptName ? ` script=${diagnostic.scriptName}` : "";
      const line = diagnostic.line ? ` line=${diagnostic.line}` : "";
      lines.push(`  error ${diagnostic.code}${script}${line}: ${diagnostic.message}`);
    }
  }

  lines.push(
    `Summary: packages=${summary.packageCount} workflows=${summary.workflowCount} scripts=${summary.scriptCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
  );

  return lines.join("\n");
}

export async function runPackageRuntimeCoverageCli(
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
    const packageJsonPaths = await collectPackageJsonPaths(cwd);
    const summary = await validatePackageRuntimeCoverage({ cwd, packageJsonPaths });
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
  const exitCode = await runPackageRuntimeCoverageCli();
  process.exit(exitCode);
}
