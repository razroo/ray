import { access, open, opendir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT_PACKAGE_JSON = "package.json";
const DEFAULT_WORKFLOW_DIR = ".github/workflows";
const DEFAULT_RUNTIME_DOCS = [
  "README.md",
  "examples/deploy/vps/README.md",
  "docs/integrations/razroo-email-ai.md",
  "docs/npm-publishing.md",
  "docs/portable-1b.md",
  "docs/release-checklist.md",
] as const;
const WORKSPACE_RUNTIME_DOC_DIRS = ["apps", "packages"] as const;
const VPS_TIMEOUT_DOCS = new Set([
  "examples/deploy/vps/README.md",
  "docs/integrations/razroo-email-ai.md",
  "docs/portable-1b.md",
]);
const MAX_CLI_ARGS = 8;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_PACKAGE_JSON_BYTES = 512 * 1024;
const MAX_PACKAGE_JSON_FILES = 128;
const MAX_PACKAGE_DISCOVERY_DIRECTORIES = 4_096;
const MAX_PACKAGE_DISCOVERY_FILES = 32_768;
const MAX_DISCOVERY_PATH_BYTES = 4_096;
const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_WORKFLOW_FILES = 64;
const MAX_WORKFLOW_DIRECTORY_ENTRIES = 1_024;
const MAX_RUNTIME_DOC_BYTES = 512 * 1024;
const MAX_WORKSPACE_RUNTIME_DOC_DIRECTORY_ENTRIES = 512;
const skipDirectoryNames = new Set([".git", ".ray", "dist", "node_modules"]);
const forbiddenLockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;
const forbiddenPackageManagerPattern =
  /(?:^|[\s;&|()])(?:(?:pnpm|yarn|npx)(?:\s|$)|npm(?:\s+(?:ci|exec|install|publish|run|test)\b|\s*$))/;
const forbiddenWorkflowPackageManagerPattern =
  /(?:^|[\s:>"'`&;|()])(?:(?:pnpm|yarn|npx)(?:\s|$)|npm\s+(?:ci|exec|install|run|test)\b)/;
const documentedBunRunScriptPattern = /\bbun\s+run\s+([A-Za-z0-9][A-Za-z0-9:_-]*\*?)/g;

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
  docPath?: string;
  scriptName?: string;
  line?: number;
}

export interface PackageRuntimeCoverageResult {
  kind: "package" | "workflow" | "lockfile" | "doc";
  packagePath: string;
  packageName?: string;
  packageManager?: string;
  scriptCount: number;
  workflowLineCount?: number;
  docLineCount?: number;
  diagnostics: PackageRuntimeCoverageDiagnostic[];
  errorCount: number;
}

export interface PackageRuntimeCoverageSummary {
  ok: boolean;
  packageCount: number;
  workflowCount: number;
  docCount: number;
  scriptCount: number;
  errorCount: number;
  forbiddenLockfiles: string[];
  results: PackageRuntimeCoverageResult[];
}

const HELP = `Validate Bun-first package, workflow, and runtime-doc coverage.

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

async function readTextFileBounded(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`${label} path must be a file: ${filePath}`);
    }

    if (stats.size > maxBytes) {
      throw new Error(`${label} must be at most ${maxBytes} bytes`);
    }

    const contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      throw new Error(`${label} must be at most ${maxBytes} bytes`);
    }

    return contents;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

interface PackageDiscoveryState {
  root: string;
  packageJsonPaths: string[];
  directoryCount: number;
  fileCount: number;
}

function assertDiscoveryPathWithinLimit(root: string, absolutePath: string): void {
  const displayPath = path.relative(root, absolutePath) || absolutePath;
  if (Buffer.byteLength(displayPath, "utf8") > MAX_DISCOVERY_PATH_BYTES) {
    throw new Error(
      `Package runtime coverage discovery path must be at most ${MAX_DISCOVERY_PATH_BYTES} bytes: ${displayPath}`,
    );
  }
}

async function collectPackageJsonPathsFromDirectory(
  currentDirectory: string,
  state: PackageDiscoveryState,
): Promise<void> {
  state.directoryCount += 1;
  if (state.directoryCount > MAX_PACKAGE_DISCOVERY_DIRECTORIES) {
    throw new Error(
      `Package runtime coverage discovery visited more than ${MAX_PACKAGE_DISCOVERY_DIRECTORIES} directories`,
    );
  }

  let directory: Awaited<ReturnType<typeof opendir>> | undefined;

  try {
    directory = await opendir(currentDirectory);
    for await (const entry of directory) {
      if (skipDirectoryNames.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentDirectory, entry.name);
      assertDiscoveryPathWithinLimit(state.root, absolutePath);

      if (entry.isDirectory()) {
        await collectPackageJsonPathsFromDirectory(absolutePath, state);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      state.fileCount += 1;
      if (state.fileCount > MAX_PACKAGE_DISCOVERY_FILES) {
        throw new Error(
          `Package runtime coverage discovery visited more than ${MAX_PACKAGE_DISCOVERY_FILES} files`,
        );
      }

      if (entry.name === DEFAULT_ROOT_PACKAGE_JSON) {
        state.packageJsonPaths.push(absolutePath);
        if (state.packageJsonPaths.length > MAX_PACKAGE_JSON_FILES) {
          throw new Error(
            `Repository must contain at most ${MAX_PACKAGE_JSON_FILES} package.json files`,
          );
        }
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
}

export async function collectPackageJsonPaths(cwd: string): Promise<string[]> {
  const resolvedCwd = path.resolve(cwd);
  const state: PackageDiscoveryState = {
    root: resolvedCwd,
    packageJsonPaths: [],
    directoryCount: 0,
    fileCount: 0,
  };
  await collectPackageJsonPathsFromDirectory(resolvedCwd, state);
  const packageJsonPaths = state.packageJsonPaths.sort();

  if (packageJsonPaths.length === 0) {
    throw new Error(`No package.json files found in ${resolvedCwd}`);
  }

  return packageJsonPaths;
}

async function collectWorkflowPaths(cwd: string): Promise<string[]> {
  const workflowDirectory = path.join(cwd, DEFAULT_WORKFLOW_DIR);

  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  const workflowPaths: string[] = [];
  let entryCount = 0;

  try {
    directory = await opendir(workflowDirectory);
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_WORKFLOW_DIRECTORY_ENTRIES) {
        throw new Error(
          `GitHub workflow discovery visited more than ${MAX_WORKFLOW_DIRECTORY_ENTRIES} entries`,
        );
      }

      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
        continue;
      }

      workflowPaths.push(path.join(workflowDirectory, entry.name));
      if (workflowPaths.length > MAX_WORKFLOW_FILES) {
        throw new Error(
          `Repository must contain at most ${MAX_WORKFLOW_FILES} GitHub workflow files`,
        );
      }
    }

    return workflowPaths.sort();
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The async iterator closes the directory after normal completion.
      }
    }
  }
}

async function collectWorkspaceReadmeDocPaths(
  cwd: string,
  workspaceDir: string,
): Promise<string[]> {
  const workspacePath = path.join(cwd, workspaceDir);
  const docPaths: string[] = [];
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  let entryCount = 0;

  try {
    directory = await opendir(workspacePath);
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_WORKSPACE_RUNTIME_DOC_DIRECTORY_ENTRIES) {
        throw new Error(
          `Workspace runtime doc discovery visited more than ${MAX_WORKSPACE_RUNTIME_DOC_DIRECTORY_ENTRIES} entries in ${workspaceDir}`,
        );
      }

      if (!entry.isDirectory() || skipDirectoryNames.has(entry.name)) {
        continue;
      }

      const docPath = path.join(workspacePath, entry.name, "README.md");
      assertDiscoveryPathWithinLimit(cwd, docPath);
      if (await pathExists(docPath)) {
        docPaths.push(docPath);
      }
    }

    return docPaths.sort();
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The async iterator closes the directory after normal completion.
      }
    }
  }
}

async function collectRuntimeDocPaths(cwd: string): Promise<string[]> {
  const docPaths: string[] = [];
  const seenDocPaths = new Set<string>();
  const addDocPath = async (docPath: string): Promise<void> => {
    if (!seenDocPaths.has(docPath) && (await pathExists(docPath))) {
      seenDocPaths.add(docPath);
      docPaths.push(docPath);
    }
  };

  for (const docRel of DEFAULT_RUNTIME_DOCS) {
    await addDocPath(path.join(cwd, docRel));
  }

  for (const workspaceDir of WORKSPACE_RUNTIME_DOC_DIRS) {
    for (const docPath of await collectWorkspaceReadmeDocPaths(cwd, workspaceDir)) {
      await addDocPath(docPath);
    }
  }

  return docPaths;
}

async function readPackageJson(packageJsonPath: string): Promise<Record<string, unknown>> {
  const contents = await readTextFileBounded(
    packageJsonPath,
    MAX_PACKAGE_JSON_BYTES,
    "package.json",
  );
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

  const releaseGate = scripts["release:gate"];
  if (
    releaseGate !== undefined &&
    !releaseGate.includes("RAY_API_KEYS=smoke bun run validate:config:public")
  ) {
    diagnostics.push({
      level: "error",
      code: "release_gate_public_auth_validate_missing",
      packagePath: packageJsonPath,
      scriptName: "release:gate",
      message:
        'Script "release:gate" must run RAY_API_KEYS=smoke bun run validate:config:public so CI proves public configs have usable auth material.',
    });
  }

  if (releaseGate !== undefined && !releaseGate.includes("bun run smoke:tiny")) {
    diagnostics.push({
      level: "error",
      code: "release_gate_tiny_gateway_smoke_missing",
      packagePath: packageJsonPath,
      scriptName: "release:gate",
      message:
        'Script "release:gate" must run bun run smoke:tiny so CI proves the tiny mock-provider gateway can boot and serve inference.',
    });
  }

  if (releaseGate !== undefined && !releaseGate.includes("bun run smoke:tiny:public")) {
    diagnostics.push({
      level: "error",
      code: "release_gate_tiny_public_smoke_missing",
      packagePath: packageJsonPath,
      scriptName: "release:gate",
      message:
        'Script "release:gate" must run bun run smoke:tiny:public so CI proves public-facing gateway auth and rate-limit guards stay wired.',
    });
  }

  if (releaseGate !== undefined && !releaseGate.includes("bun run smoke:tiny:async")) {
    diagnostics.push({
      level: "error",
      code: "release_gate_tiny_async_smoke_missing",
      packagePath: packageJsonPath,
      scriptName: "release:gate",
      message:
        'Script "release:gate" must run bun run smoke:tiny:async so CI proves the durable async job HTTP path can submit and complete work.',
    });
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
  return /\bcurl\b/.test(line) && /\|\s*(?:timeout\s+\d+s\s+)?(?:bash|sh)\b/.test(line);
}

function hasPipedShellTimeout(line: string): boolean {
  return /\|\s*timeout\s+\d+s\s+(?:bash|sh)\b/.test(line);
}

function isVpsRuntimeCurlCommand(line: string): boolean {
  return (
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*(?:timeout\s+\d+s\s+)?curl\b/.test(
      line,
    ) && !isPipedShellCurl(line)
  );
}

function hasDocumentationDomainCallbackUrl(line: string): boolean {
  return /(?:["']callbackUrl["']|\bcallbackUrl\b)\s*:\s*["']https?:\/\/(?:[^/."']+\.)?example\.(?:com|net|org)\b/i.test(
    line,
  );
}

function workflowWindowIncludes(lines: string[], index: number, pattern: string): boolean {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 3);

  for (let windowIndex = start; windowIndex < end; windowIndex += 1) {
    if (lines[windowIndex]?.includes(pattern)) {
      return true;
    }
  }

  return false;
}

function workflowLineNumber(lines: string[], pattern: string): number | undefined {
  const lineIndex = lines.findIndex((line) => line.includes(pattern));
  return lineIndex >= 0 ? lineIndex + 1 : undefined;
}

function workflowCommandContinuationIncludes(
  lines: string[],
  index: number,
  pattern: string,
): boolean {
  const end = Math.min(lines.length, index + 12);

  for (let windowIndex = index; windowIndex < end; windowIndex += 1) {
    const rawLine = lines[windowIndex] ?? "";
    if (rawLine.includes(pattern)) {
      return true;
    }

    const line = rawLine.trim();
    if (windowIndex > index && (line.length === 0 || line.startsWith("- "))) {
      break;
    }
  }

  return false;
}

function validateDeployWorkflowPublicCaddyAuthGuard(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (
    !contents.includes("RAY_DEPLOY_INSTALL_CADDY") ||
    !contents.includes("systemctl reload caddy")
  ) {
    return [];
  }

  if (
    contents.includes("authEnabled: config.auth.enabled") &&
    contents.includes('[ "$INSTALL_CADDY" = "true" ] && [ "$AUTH_ENABLED" != "true" ]')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_public_caddy_auth_guard_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_INSTALL_CADDY"),
      message:
        "VPS deploy workflow must refuse RAY_DEPLOY_INSTALL_CADDY=true when the resolved config has auth.enabled=false.",
    },
  ];
}

function validateDeployWorkflowPublicCaddyDomainGuard(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (
    !contents.includes("RAY_DEPLOY_INSTALL_CADDY") ||
    !contents.includes("systemctl reload caddy")
  ) {
    return [];
  }

  if (
    (contents.includes("DEPLOY_DOMAIN_HOST") || contents.includes("deployDomainHost")) &&
    (contents.includes("ray.local|localhost|*.local|127.*|::1") ||
      (contents.includes('deployDomainHost === "ray.local"') &&
        contents.includes('deployDomainHost === "localhost"') &&
        contents.includes('deployDomainHost.endsWith(".local")') &&
        contents.includes('deployDomainHost.startsWith("127.")') &&
        contents.includes('deployDomainHost === "::1"'))) &&
    contents.includes(
      "RAY_DEPLOY_INSTALL_CADDY=true requires RAY_DEPLOY_DOMAIN to be a real public DNS name",
    )
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_public_caddy_domain_guard_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_INSTALL_CADDY"),
      message:
        "VPS deploy workflow must refuse RAY_DEPLOY_INSTALL_CADDY=true when RAY_DEPLOY_DOMAIN is still a local placeholder such as ray.local, localhost, loopback, or .local.",
    },
  ];
}

function validateDeployWorkflowCaddyEnvOverrides(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("RAY_DEPLOY_INSTALL_CADDY") || !contents.includes("RAY_DEPLOY_DOMAIN")) {
    return [];
  }

  if (
    contents.includes("envOverrides.RAY_DEPLOY_DOMAIN") &&
    contents.includes("envOverrides.RAY_DEPLOY_INSTALL_CADDY") &&
    contents.includes("process.env.RAY_DEPLOY_DOMAIN") &&
    contents.includes("process.env.RAY_DEPLOY_INSTALL_CADDY") &&
    contents.includes("deployDomain") &&
    contents.includes("installCaddy") &&
    contents.includes('echo "deploy_domain=$DEPLOY_DOMAIN" >> "$GITHUB_OUTPUT"') &&
    contents.includes('echo "install_caddy=$INSTALL_CADDY" >> "$GITHUB_OUTPUT"')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_caddy_env_override_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_INSTALL_CADDY"),
      message:
        "VPS deploy workflow must resolve RAY_DEPLOY_DOMAIN and RAY_DEPLOY_INSTALL_CADDY after parsing RAY_ENV_FILE_CONTENTS so env-file Caddy deploy settings feed remote prerequisites, doctor, render, and reload decisions.",
    },
  ];
}

function validateDeployWorkflowMemoryEnvOverride(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("RAY_DEPLOY_MEMORY_MIB")) {
    return [];
  }

  if (
    contents.includes("envOverrides.RAY_DEPLOY_MEMORY_MIB") &&
    contents.includes("process.env.RAY_DEPLOY_MEMORY_MIB") &&
    contents.includes("deployMemoryMiB") &&
    contents.includes('echo "deploy_memory_mib=$DEPLOY_MEMORY_MIB" >> "$GITHUB_OUTPUT"') &&
    contents.includes("DEPLOY_MEMORY_MIB: ${{ steps.settings.outputs.deploy_memory_mib }}") &&
    contents.includes('RAY_DEPLOY_MEMORY_MIB=$(shell_quote "${DEPLOY_MEMORY_MIB:-}")')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_memory_env_override_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_MEMORY_MIB"),
      message:
        "VPS deploy workflow must resolve RAY_DEPLOY_MEMORY_MIB after parsing RAY_ENV_FILE_CONTENTS so malformed env-file memory budgets fail before SSH and resolved budgets feed remote doctor, render, and staging.",
    },
  ];
}

function validateDeployWorkflowStoragePreflight(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (
    !contents.includes("rsync -az --delete") ||
    !contents.includes("/usr/local/bin/bun install --production")
  ) {
    return [];
  }

  const remoteStorageSettingCount =
    contents.split('DEPLOY_MIN_FREE_STORAGE_MIB=$(shell_quote "$DEPLOY_MIN_FREE_STORAGE_MIB")')
      .length - 1;

  if (
    contents.includes(
      "RAY_DEPLOY_MIN_FREE_STORAGE_MIB: ${{ vars.RAY_DEPLOY_MIN_FREE_STORAGE_MIB }}",
    ) &&
    contents.includes("envOverrides.RAY_DEPLOY_MIN_FREE_STORAGE_MIB") &&
    contents.includes("process.env.RAY_DEPLOY_MIN_FREE_STORAGE_MIB") &&
    contents.includes("parseOptionalNonNegativeInteger") &&
    contents.includes(
      'echo "deploy_min_free_storage_mib=$DEPLOY_MIN_FREE_STORAGE_MIB" >> "$GITHUB_OUTPUT"',
    ) &&
    remoteStorageSettingCount >= 2 &&
    contents.includes("timeout 30s df -Pm") &&
    contents.includes('check_free_storage /srv/ray "synced checkout"') &&
    contents.includes('check_free_storage /var/lib/ray "Ray state"') &&
    contents.includes('check_free_storage /tmp "temporary directory"') &&
    contents.includes('check_free_storage /srv/ray "Bun production install"') &&
    contents.includes("Remote deploy preflight requires at least")
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_remote_storage_preflight_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_MIN_FREE_STORAGE_MIB"),
      message:
        "VPS deploy workflow must preflight remote free storage before package bootstrap, repository sync follow-up, and Bun production install so small VPS disks fail clearly before deploy work fills them.",
    },
  ];
}

function validateDeployWorkflowReadyTimeoutEnvOverride(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("RAY_DEPLOY_READY_TIMEOUT_SECONDS")) {
    return [];
  }

  if (
    contents.includes("envOverrides.RAY_DEPLOY_READY_TIMEOUT_SECONDS") &&
    contents.includes("process.env.RAY_DEPLOY_READY_TIMEOUT_SECONDS") &&
    contents.includes("parseDeployReadyTimeoutSeconds") &&
    contents.includes("readyTimeoutSeconds") &&
    contents.includes('echo "ready_timeout_seconds=$READY_TIMEOUT_SECONDS" >> "$GITHUB_OUTPUT"') &&
    contents.includes("READY_TIMEOUT_SECONDS: ${{ steps.settings.outputs.ready_timeout_seconds }}")
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_ready_timeout_env_override_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_READY_TIMEOUT_SECONDS"),
      message:
        "VPS deploy workflow must resolve RAY_DEPLOY_READY_TIMEOUT_SECONDS after parsing RAY_ENV_FILE_CONTENTS so env-file readiness windows can cover slow local model warmup and malformed values fail before SSH.",
    },
  ];
}

function validateDeployWorkflowReadyzSnapshotLogging(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (
    contents.includes("ready_snapshot=") &&
    contents.includes(
      'ready_snapshot="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/readyz"',
    ) &&
    contents.includes(
      'ready_snapshot="$(curl -sS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/readyz"',
    ) &&
    contents.includes("::group::Ray readiness snapshot") &&
    contents.includes("printf '%s\\n' \"$ready_snapshot\"")
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_readyz_snapshot_logging_missing",
      workflowPath,
      line: workflowLineNumber(lines, "/readyz"),
      message:
        "VPS deploy workflow must capture and print the final /readyz snapshot so successful and failed deploy logs include backend, queue, memory, CPU, or async-queue readiness reasons.",
    },
  ];
}

function validateDeployWorkflowResolvedEnvPersistence(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("/etc/ray/ray.env")) {
    return [];
  }

  if (
    contents.includes("append_ray_env_default()") &&
    contents.includes('append_ray_env_default RAY_DEPLOY_SERVICE_USER "$SERVICE_USER"') &&
    contents.includes('append_ray_env_default RAY_DEPLOY_DOMAIN "$DEPLOY_DOMAIN"') &&
    contents.includes(
      'append_ray_env_default RAY_DEPLOY_MEMORY_MIB "${RAY_DEPLOY_MEMORY_MIB:-}"',
    ) &&
    contents.includes(
      'append_ray_env_default RAY_GATEWAY_RUNTIME_BINARY "$GATEWAY_RUNTIME_BINARY"',
    ) &&
    contents.includes('append_ray_env_default RAY_DEPLOY_CADDY_BINARY "${CADDY_BINARY:-}"') &&
    contents.includes('"^[[:space:]]*${key}[[:space:]]*="') &&
    contents.includes("timeout 60s $SUDO tee -a /etc/ray/ray.env")
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_resolved_env_persistence_missing",
      workflowPath,
      line: workflowLineNumber(lines, "/etc/ray/ray.env"),
      message:
        "VPS deploy workflow must persist resolved non-secret deploy settings into /etc/ray/ray.env when absent so later doctor, render, and model-stage runs use the same service user, domain, memory target, and runtime paths.",
    },
  ];
}

function validateDeployWorkflowCaddyBinaryGuards(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const caddyArgsExpansionCount = lines.filter((line) =>
    line.includes('"${CADDY_ARGS[@]}"'),
  ).length;

  if (
    contents.includes("RAY_DEPLOY_CADDY_BINARY: ${{ vars.RAY_DEPLOY_CADDY_BINARY }}") &&
    contents.includes("normalizeCaddyBinaryPath") &&
    contents.includes('echo "caddy_binary=$CADDY_BINARY" >> "$GITHUB_OUTPUT"') &&
    contents.includes("CADDY_BINARY: ${{ steps.settings.outputs.caddy_binary }}") &&
    contents.includes('CADDY_ARGS=(--caddy-binary "$CADDY_BINARY")') &&
    caddyArgsExpansionCount >= 2 &&
    contents.includes('"$CADDY_RUNTIME" validate --config "$CADDY_TMP"')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_caddy_binary_guard_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_CADDY_BINARY"),
      message:
        "VPS deploy workflow must honor RAY_DEPLOY_CADDY_BINARY for remote doctor, render, and Caddyfile validation so custom Caddy install paths work consistently.",
    },
  ];
}

function validateDeployWorkflowServiceUserGuard(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (
    !contents.includes("RAY_DEPLOY_SERVICE_USER") ||
    !contents.includes('echo "service_user=$SERVICE_USER" >> "$GITHUB_OUTPUT"')
  ) {
    return [];
  }

  if (
    contents.includes("parseDeployServiceUser") &&
    contents.includes(
      'parseDeployServiceUser(process.env.SERVICE_USER ?? "", "RAY_DEPLOY_SERVICE_USER")',
    ) &&
    !contents.includes("^[A-Za-z_][A-Za-z0-9_-]{0,30}$")
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_service_user_parser_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_SERVICE_USER"),
      message:
        "VPS deploy workflow must validate RAY_DEPLOY_SERVICE_USER through the shared deploy parser so numeric UIDs and CLI --user behavior stay consistent.",
    },
  ];
}

function validateDeployWorkflowNumericServiceUserGuard(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("RAY_DEPLOY_SERVICE_USER")) {
    return [];
  }

  const serviceGroupResolutionCount =
    contents.split('SERVICE_GROUP="$(id -g "$SERVICE_USER")"').length - 1;

  if (
    contents.includes("*[!0-9]*)") &&
    contents.includes("RAY_DEPLOY_SERVICE_USER numeric UID must already exist on the VPS") &&
    contents.includes("Could not resolve primary GID for RAY_DEPLOY_SERVICE_USER=$SERVICE_USER.") &&
    serviceGroupResolutionCount >= 2 &&
    !contents.includes('SERVICE_GROUP="$(id -gn "$SERVICE_USER")"')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_numeric_service_user_guard_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_DEPLOY_SERVICE_USER"),
      message:
        "VPS deploy workflow must keep numeric RAY_DEPLOY_SERVICE_USER values out of useradd and resolve ownership through the existing account primary GID.",
    },
  ];
}

function validateDeployWorkflowSecretFileInstalls(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (
      /\btee\s+\/etc\/ray\/ray\.(?:env|json)\b/.test(line) ||
      /\btee\s+-a\s+\/etc\/ray\/ray\.json\b/.test(line)
    ) {
      diagnostics.push({
        level: "error",
        code: "workflow_secret_file_install_mode_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow should install /etc/ray config and env files with install -m so secret files are created with their final restrictive mode.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowStateOwnershipGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (/\bchown\s+-R\b/.test(line) && line.includes("/var/lib/ray")) {
      diagnostics.push({
        level: "error",
        code: "workflow_recursive_state_chown",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow must not recursively chown /var/lib/ray because model files can be multi-GB; chown the state directories directly and let staging own staged artifacts.",
      });
    }
    if (/\bchown\s+-R\b/.test(line) && line.includes("/srv/ray")) {
      diagnostics.push({
        level: "error",
        code: "workflow_recursive_checkout_chown",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow must not recursively chown /srv/ray because stale node_modules and built artifacts can be large; chown the checkout root directly and let rsync plus Bun install set service-readable modes.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowAptGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (
      /\bapt-get\s+(?:update|install)\b/.test(line) &&
      (!line.includes("timeout ") ||
        !line.includes("Acquire::Retries=") ||
        !line.includes("Dpkg::Lock::Timeout="))
    ) {
      diagnostics.push({
        level: "error",
        code: "workflow_apt_get_unbounded",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow apt-get update/install calls must set an overall timeout, Acquire::Retries, and Dpkg::Lock::Timeout so package bootstrap cannot hang indefinitely.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowRsyncGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const rsyncCommand = /^(?:-\s+run:\s+)?(?:timeout\s+\d+s\s+)?rsync\b/.test(line);
    if (rsyncCommand && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_rsync_session_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow rsync calls must run under an overall timeout so long repository transfers cannot hold the deploy job indefinitely.",
      });
    }
    if (rsyncCommand && !workflowCommandContinuationIncludes(lines, index, "--timeout")) {
      diagnostics.push({
        level: "error",
        code: "workflow_rsync_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow rsync calls must pass --timeout so stalled repository transfers fail instead of hanging a deploy indefinitely.",
      });
    }
    if (rsyncCommand && !workflowCommandContinuationIncludes(lines, index, "--chmod=")) {
      diagnostics.push({
        level: "error",
        code: "workflow_rsync_checkout_chmod_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow rsync calls must set service-readable checkout modes during transfer so deploys do not need a recursive chmod over the synced repository.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowCheckoutPermissionGuards(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (/\bchmod\s+-R\b/.test(line) && line.includes("/srv/ray")) {
      diagnostics.push({
        level: "error",
        code: "workflow_recursive_checkout_chmod",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow must not recursively chmod /srv/ray after dependency install; normalize rsync modes and Bun install umask instead so small VPS deploys avoid walking node_modules.",
      });
    }
  }

  if (
    contents.includes("/usr/local/bin/bun install --production") &&
    !contents.includes("umask 022")
  ) {
    diagnostics.push({
      level: "error",
      code: "workflow_remote_bun_install_umask_missing",
      workflowPath,
      line: workflowLineNumber(lines, "/usr/local/bin/bun install --production"),
      message:
        "VPS deploy workflow must set umask 022 before the remote Bun production install so node_modules is service-readable without a recursive chmod.",
    });
  }

  return diagnostics;
}

function validateDeployWorkflowSshSessionGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (/^(?:-\s+run:\s+)?ssh\s/.test(line) && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_ssh_session_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow remote SSH sessions must run under an overall timeout so a connected but wedged host cannot hold the deploy job indefinitely.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowServiceCommandGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (/\bsystemctl\b/.test(line) && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_systemctl_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow systemctl calls must run under timeout so systemd or D-Bus stalls cannot hang a deploy indefinitely.",
      });
    }

    if (/\bjournalctl\b/.test(line) && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_journalctl_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow journalctl calls must run under timeout so diagnostic collection cannot hang a failed deploy indefinitely.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowRemoteBunInstallGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const contents = lines.join("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.includes("/usr/local/bin/bun install") && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_remote_bun_install_unbounded",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow remote bun install calls must run under an overall timeout so dependency installation cannot hang indefinitely on a small host.",
      });
    }
  }

  if (
    contents.includes("/usr/local/bin/bun install --production") &&
    !contents.includes("timeout 120s $SUDO rm -rf node_modules")
  ) {
    diagnostics.push({
      level: "error",
      code: "workflow_remote_bun_install_prune_missing",
      workflowPath,
      line: workflowLineNumber(lines, "/usr/local/bin/bun install --production"),
      message:
        "VPS deploy workflow must remove stale node_modules through the validated sudo path under timeout before the remote Bun production install so old dev dependencies cannot accumulate on small VPS disks even when ownership changed.",
    });
  }

  return diagnostics;
}

function validateDeployWorkflowRemoteBunCommandGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.includes("$SUDO /usr/local/bin/bun") && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_remote_bun_command_unbounded",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow remote Bun helper calls must run under an overall timeout so deploy-side config, doctor, render, or staging helpers cannot hang indefinitely.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowBunVersionProbeGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (
      /(?:"\$binary"|\$binary|\/usr\/local\/bin\/bun|\bbun)\s+--version\b/.test(line) &&
      !line.includes("timeout ")
    ) {
      diagnostics.push({
        level: "error",
        code: "workflow_bun_version_probe_unbounded",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow Bun version probes must run under timeout so a broken runtime binary cannot hang deploy bootstrap before doctor runs.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowGatewayRuntimeBunInstall(
  workflowPath: string,
  contents: string,
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("GATEWAY_RUNTIME_BINARY")) {
    return [];
  }

  if (
    contents.includes('basename "${GATEWAY_RUNTIME_BINARY:-}"') &&
    contents.includes("tr '[:upper:]' '[:lower:]'") &&
    contents.includes('[ "${GATEWAY_RUNTIME_BINARY:-}" != "/usr/local/bin/bun" ]') &&
    contents.includes('install -D -m 0755 /usr/local/bin/bun "$GATEWAY_RUNTIME_BINARY"')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_gateway_runtime_bun_install_missing",
      workflowPath,
      message:
        "VPS deploy workflow must copy the refreshed /usr/local/bin/bun to custom Bun gateway runtime paths so --gateway-runtime-binary does not point generated services at a stale or missing Bun binary.",
    },
  ];
}

function validateDeployWorkflowGatewayRuntimeEnvOverride(
  workflowPath: string,
  contents: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  if (!contents.includes("RAY_GATEWAY_RUNTIME_BINARY")) {
    return [];
  }

  if (
    contents.includes("normalizeGatewayRuntimeBinaryPath") &&
    contents.includes("envOverrides.RAY_GATEWAY_RUNTIME_BINARY") &&
    contents.includes("readNonEmpty(process.env.RAY_GATEWAY_RUNTIME_BINARY)") &&
    contents.includes('"/usr/local/bin/bun"') &&
    contents.includes("gatewayRuntimeBinary") &&
    contents.includes('echo "gateway_runtime_binary=$GATEWAY_RUNTIME_BINARY" >> "$GITHUB_OUTPUT"')
  ) {
    return [];
  }

  return [
    {
      level: "error",
      code: "workflow_gateway_runtime_env_override_missing",
      workflowPath,
      line: workflowLineNumber(lines, "RAY_GATEWAY_RUNTIME_BINARY"),
      message:
        "VPS deploy workflow must resolve RAY_GATEWAY_RUNTIME_BINARY after parsing RAY_ENV_FILE_CONTENTS so env-file runtime overrides feed doctor, render, and generated systemd units.",
    },
  ];
}

function validateDeployWorkflowRootCommandGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const rootCommandPattern =
    /(?:^|[\s|;&(])(?:sudo|\$SUDO)\s+(?:install|cp|rm|chown|chmod|mkdir|useradd|tee|grep|tail)\b/;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (rootCommandPattern.test(line) && !line.includes("timeout ")) {
      diagnostics.push({
        level: "error",
        code: "workflow_root_command_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow root file and account commands must run under timeout so filesystem or NSS stalls cannot consume the whole deploy session.",
      });
    }
  }

  return diagnostics;
}

function validateDeployWorkflowRayEnvReadGuards(
  workflowPath: string,
  lines: string[],
): PackageRuntimeCoverageDiagnostic[] {
  if (path.basename(workflowPath) !== "deploy-vps.yml") {
    return [];
  }

  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (/\breadFileSync\(["']\/etc\/ray\/ray\.env["']/.test(line)) {
      diagnostics.push({
        level: "error",
        code: "workflow_ray_env_read_unbounded",
        workflowPath,
        line: index + 1,
        message:
          "VPS deploy workflow must stat /etc/ray/ray.env before reading it so deploy-side Bun helpers cannot allocate an oversized env file on a small host.",
      });
    }
  }

  return diagnostics;
}

async function validateWorkflow(
  workflowPath: string,
): Promise<{ lineCount: number; diagnostics: PackageRuntimeCoverageDiagnostic[] }> {
  const contents = await readTextFileBounded(workflowPath, MAX_WORKFLOW_BYTES, "GitHub workflow");
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

    if (/\bbun\s+install\b/.test(line) && !line.includes("--frozen-lockfile")) {
      diagnostics.push({
        level: "error",
        code: "workflow_bun_install_frozen_lockfile_missing",
        workflowPath,
        line: index + 1,
        message:
          "Workflow bun install commands must pass --frozen-lockfile so CI and deploy jobs use the checked-in Bun dependency graph.",
      });
    }

    if (
      isLocalHealthCurl(line) &&
      (!line.includes("--connect-timeout") || !line.includes("--max-time"))
    ) {
      diagnostics.push({
        level: "error",
        code: "unbounded_workflow_health_probe",
        workflowPath,
        line: index + 1,
        message:
          "Workflow localhost health probes must pass curl --connect-timeout and --max-time so VPS deploy readiness loops honor their timeout windows.",
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

    if (isPipedShellCurl(line) && !hasPipedShellTimeout(line)) {
      diagnostics.push({
        level: "error",
        code: "workflow_curl_install_body_timeout_missing",
        workflowPath,
        line: index + 1,
        message:
          "Workflow curl-to-shell installers must pipe through timeout so installer bodies cannot hang after the script download succeeds.",
      });
    }

    if (
      line.includes("ConnectTimeout=") &&
      (!workflowWindowIncludes(lines, index, "ServerAliveInterval=") ||
        !workflowWindowIncludes(lines, index, "ServerAliveCountMax="))
    ) {
      diagnostics.push({
        level: "error",
        code: "workflow_ssh_missing_keepalive",
        workflowPath,
        line: index + 1,
        message:
          "Workflow SSH deploy commands with ConnectTimeout must also set ServerAliveInterval and ServerAliveCountMax so connected VPS sessions cannot hang indefinitely.",
      });
    }
  }

  diagnostics.push(...validateDeployWorkflowPublicCaddyAuthGuard(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowPublicCaddyDomainGuard(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowCaddyEnvOverrides(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowMemoryEnvOverride(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowStoragePreflight(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowReadyTimeoutEnvOverride(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowReadyzSnapshotLogging(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowResolvedEnvPersistence(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowCaddyBinaryGuards(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowServiceUserGuard(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowNumericServiceUserGuard(workflowPath, contents, lines));
  diagnostics.push(...validateDeployWorkflowSecretFileInstalls(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowStateOwnershipGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowAptGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowRsyncGuards(workflowPath, lines));
  diagnostics.push(
    ...validateDeployWorkflowCheckoutPermissionGuards(workflowPath, contents, lines),
  );
  diagnostics.push(...validateDeployWorkflowSshSessionGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowServiceCommandGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowRemoteBunInstallGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowRemoteBunCommandGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowBunVersionProbeGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowGatewayRuntimeBunInstall(workflowPath, contents));
  diagnostics.push(
    ...validateDeployWorkflowGatewayRuntimeEnvOverride(workflowPath, contents, lines),
  );
  diagnostics.push(...validateDeployWorkflowRootCommandGuards(workflowPath, lines));
  diagnostics.push(...validateDeployWorkflowRayEnvReadGuards(workflowPath, lines));

  return {
    lineCount: lines.length,
    diagnostics,
  };
}

function isShellFenceStart(line: string): boolean {
  return /^```\s*(?:bash|sh|shell)\s*$/.test(line.trim());
}

function isFenceEnd(line: string): boolean {
  return /^```\s*$/.test(line.trim());
}

function isVpsReadmeCommandRequiringTimeout(line: string): boolean {
  return (
    /\bgit\s+clone\b/.test(line) ||
    /\bbun\s+run\s+build\b/.test(line) ||
    /\bbun\s+packages\/deploy\/dist\/cli\.js\s+render\b/.test(line) ||
    /\bsudo\s+(?:install|cp|rm|chown|chmod|mkdir|useradd|systemctl|caddy)\b/.test(line) ||
    /\bsystemctl\b/.test(line)
  );
}

function isVpsRayHelperScriptRequiringTimeout(scriptName: string): boolean {
  return (
    scriptName === "doctor" ||
    scriptName.startsWith("doctor:") ||
    scriptName === "render:service" ||
    scriptName.startsWith("render:service:") ||
    scriptName === "model:stage" ||
    scriptName.startsWith("model:stage:") ||
    scriptName === "deploy:storage" ||
    scriptName === "deploy:smoke" ||
    scriptName === "deploy:scripts" ||
    scriptName === "validate:config" ||
    scriptName.startsWith("validate:config:") ||
    scriptName.startsWith("benchmark:") ||
    scriptName.startsWith("autotune:")
  );
}

function isVpsRayHelperCommandRequiringTimeout(line: string): boolean {
  return collectDocumentedBunRunScripts(line).some((scriptName) =>
    isVpsRayHelperScriptRequiringTimeout(scriptName),
  );
}

function referencesImplicitRaySystemdUnit(line: string): boolean {
  return /\b(?:journalctl|systemctl)\b.*\bray-(?:gateway|llama-cpp)(?!\.service)\b/.test(line);
}

function collectDocumentedBunRunScripts(line: string): string[] {
  return [...line.matchAll(documentedBunRunScriptPattern)].map((match) =>
    (match[1] ?? "").replace(/\*$/, ""),
  );
}

async function validateRuntimeDoc(
  docPath: string,
  options: {
    enforceExplicitRayServiceUnits: boolean;
    enforceVpsTimeouts: boolean;
    rootScripts: Record<string, string>;
  },
): Promise<{ lineCount: number; diagnostics: PackageRuntimeCoverageDiagnostic[] }> {
  const contents = await readTextFileBounded(docPath, MAX_RUNTIME_DOC_BYTES, "Runtime doc");
  const diagnostics: PackageRuntimeCoverageDiagnostic[] = [];
  const lines = contents.split(/\r?\n/);
  let inShellBlock = false;

  for (const [index, rawLine] of lines.entries()) {
    if (isShellFenceStart(rawLine)) {
      inShellBlock = true;
      continue;
    }

    if (isFenceEnd(rawLine)) {
      inShellBlock = false;
      continue;
    }

    const line = rawLine.trim();

    if (hasDocumentationDomainCallbackUrl(line)) {
      diagnostics.push({
        level: "error",
        code: "runtime_doc_example_callback_url",
        docPath,
        line: index + 1,
        message:
          "Runtime docs must not put documentation-domain callbackUrl values in executable examples. Omit callbackUrl or use an operator-owned endpoint.",
      });
    }

    for (const scriptName of collectDocumentedBunRunScripts(line)) {
      if (scriptName.length > 0 && options.rootScripts[scriptName] === undefined) {
        diagnostics.push({
          level: "error",
          code: "runtime_doc_bun_script_missing",
          docPath,
          line: index + 1,
          message: `Runtime docs reference "bun run ${scriptName}", but root package.json does not define that script.`,
        });
      }
    }

    if (
      options.enforceExplicitRayServiceUnits &&
      line.length > 0 &&
      !line.startsWith("#") &&
      referencesImplicitRaySystemdUnit(line)
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_ray_service_suffix_missing",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must reference generated Ray systemd units with their explicit .service suffix so manual commands match the rendered unit files.",
      });
    }

    if (!inShellBlock) {
      continue;
    }

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (forbiddenWorkflowPackageManagerPattern.test(line)) {
      diagnostics.push({
        level: "error",
        code: "non_bun_runtime_doc_command",
        docPath,
        line: index + 1,
        message:
          "Runtime docs must not tell operators to use pnpm/yarn/npx or npm install/run/test. Use bun, bunx, or a direct binary instead.",
      });
    }

    if (options.enforceVpsTimeouts && isPipedShellCurl(line) && !hasPipedShellTimeout(line)) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_curl_install_unbounded",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must pipe curl-to-shell installers through timeout so the installer body cannot hang after the script download succeeds.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      isVpsRuntimeCurlCommand(line) &&
      (!line.includes("--connect-timeout") || !line.includes("--max-time"))
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_curl_timeout_missing",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must run runtime curl probes with --connect-timeout and --max-time so a wedged gateway cannot hang operator checks.",
      });
    }

    if (
      !options.enforceVpsTimeouts &&
      isVpsRuntimeCurlCommand(line) &&
      (!line.includes("--connect-timeout") || !line.includes("--max-time"))
    ) {
      diagnostics.push({
        level: "error",
        code: "runtime_doc_curl_timeout_missing",
        docPath,
        line: index + 1,
        message:
          "Runtime docs must run curl probes with --connect-timeout and --max-time so local gateway checks cannot hang indefinitely.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      /\bbun\s+install\b/.test(line) &&
      (!line.includes("timeout ") || !line.includes("--frozen-lockfile"))
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_bun_install_unbounded",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must run bun install under timeout with --frozen-lockfile so manual installs stay bounded and reproducible.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      /\bapt-get\s+(?:update|install)\b/.test(line) &&
      !line.includes("timeout ")
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_apt_get_unbounded",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must run apt-get update/install under timeout so package bootstrap cannot hang indefinitely.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      /\bgit\s+clone\b/.test(line) &&
      !/\s--depth(?:=|\s+)/.test(line)
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_git_clone_shallow_missing",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must use shallow git clones so manual checkouts do not spend small-host disk and bandwidth on full history.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      isVpsReadmeCommandRequiringTimeout(line) &&
      !line.includes("timeout ")
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_command_timeout_missing",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must bound root, service-management, build, clone, and render commands with timeout so manual setup cannot hang indefinitely.",
      });
    }

    if (
      options.enforceVpsTimeouts &&
      isVpsRayHelperCommandRequiringTimeout(line) &&
      !line.includes("timeout ")
    ) {
      diagnostics.push({
        level: "error",
        code: "vps_readme_ray_helper_timeout_missing",
        docPath,
        line: index + 1,
        message:
          "VPS deployment docs must run Ray helper scripts under timeout so config, staging, doctor, benchmark, or autotune commands cannot hang indefinitely on small hosts.",
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
  const runtimeDocPaths = await collectRuntimeDocPaths(cwd);
  let rootScripts: Record<string, string> = {};

  for (const packageJsonPath of options.packageJsonPaths.map((filePath) =>
    path.resolve(filePath),
  )) {
    try {
      const parsedPackage = await readPackageJson(packageJsonPath);
      const packageName = typeof parsedPackage.name === "string" ? parsedPackage.name : undefined;
      const packageManager =
        typeof parsedPackage.packageManager === "string" ? parsedPackage.packageManager : undefined;
      const scripts = readScripts(parsedPackage);
      if (packageJsonPath === path.resolve(cwd, DEFAULT_ROOT_PACKAGE_JSON)) {
        rootScripts = scripts;
      }
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

  for (const docPath of runtimeDocPaths) {
    try {
      const docRelPath = displayPath(cwd, docPath);
      const { lineCount, diagnostics } = await validateRuntimeDoc(docPath, {
        enforceExplicitRayServiceUnits: VPS_TIMEOUT_DOCS.has(docRelPath),
        enforceVpsTimeouts: VPS_TIMEOUT_DOCS.has(docRelPath),
        rootScripts,
      });
      results.push({
        kind: "doc",
        packagePath: docPath,
        docLineCount: lineCount,
        scriptCount: 0,
        diagnostics,
        errorCount: diagnostics.length,
      });
    } catch (error) {
      results.push({
        kind: "doc",
        packagePath: docPath,
        scriptCount: 0,
        diagnostics: [
          {
            level: "error",
            code: "runtime_doc_invalid",
            docPath,
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
    docCount: runtimeDocPaths.length,
    scriptCount,
    errorCount,
    forbiddenLockfiles: foundForbiddenLockfiles,
    results,
  };
}

export function formatTextSummary(cwd: string, summary: PackageRuntimeCoverageSummary): string {
  const lines = [
    `Checked ${summary.packageCount} package manifest${summary.packageCount === 1 ? "" : "s"}, ${summary.workflowCount} GitHub workflow${summary.workflowCount === 1 ? "" : "s"}, and ${summary.docCount} runtime doc${summary.docCount === 1 ? "" : "s"} for Bun-first runtime coverage:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    if (result.kind === "workflow") {
      lines.push(
        `- ${status} ${displayPath(cwd, result.packagePath)} workflow lines=${result.workflowLineCount ?? 0} errors=${result.errorCount}`,
      );
    } else if (result.kind === "doc") {
      lines.push(
        `- ${status} ${displayPath(cwd, result.packagePath)} doc lines=${result.docLineCount ?? 0} errors=${result.errorCount}`,
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
    `Summary: packages=${summary.packageCount} workflows=${summary.workflowCount} docs=${summary.docCount} scripts=${summary.scriptCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
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
