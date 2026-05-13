import { access, open, opendir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_CLI_ARGS = 8;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_MARKDOWN_FILES = 512;
const MAX_DISCOVERY_DIRECTORIES = 4_096;
const MAX_DISCOVERY_FILES = 32_768;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_DISCOVERY_PATH_BYTES = 4_096;
const skipDirectoryNames = new Set([
  ".changeset",
  ".git",
  ".playwright-mcp",
  ".ray",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

export interface DocsLinkCheckArgs {
  cwd: string;
  json: boolean;
  help: boolean;
}

export interface DocsLinkDiagnostic {
  level: "error";
  code:
    | "markdown_invalid"
    | "local_markdown_link_invalid"
    | "local_markdown_link_missing"
    | "local_markdown_link_outside_repo";
  message: string;
  docPath: string;
  line?: number;
  target?: string;
}

export interface DocsLinkCheckResult {
  docPath: string;
  linkCount: number;
  diagnostics: DocsLinkDiagnostic[];
  errorCount: number;
}

export interface DocsLinkCheckSummary {
  ok: boolean;
  docCount: number;
  linkCount: number;
  errorCount: number;
  results: DocsLinkCheckResult[];
}

const HELP = `Validate checked-in Markdown local links.

Usage:
  bun ./scripts/docs-link-check.ts [options]

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

function assertDocsPathValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must be a path without surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_DISCOVERY_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_DISCOVERY_PATH_BYTES} bytes`);
  }
}

export function parseArgs(argv: string[]): DocsLinkCheckArgs {
  assertArgv(argv);

  const args: DocsLinkCheckArgs = {
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

function displayPath(cwd: string, filePath: string): string {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

function assertDiscoveryPathWithinLimit(root: string, absolutePath: string): void {
  const display = displayPath(root, absolutePath);
  if (Buffer.byteLength(display, "utf8") > MAX_DISCOVERY_PATH_BYTES) {
    throw new Error(
      `Markdown link discovery path must be at most ${MAX_DISCOVERY_PATH_BYTES} bytes: ${display}`,
    );
  }
}

async function readDirectoryEntriesBounded(currentDirectory: string): Promise<
  Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }>
> {
  const entries: Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }> = [];
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;

  try {
    directory = await opendir(currentDirectory);
    for await (const entry of directory) {
      entries.push(entry);
      if (entries.length > MAX_DIRECTORY_ENTRIES) {
        throw new Error(
          `Markdown link discovery found more than ${MAX_DIRECTORY_ENTRIES} entries in one directory: ${currentDirectory}`,
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

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

interface MarkdownDiscoveryState {
  root: string;
  markdownPaths: string[];
  directoryCount: number;
  fileCount: number;
}

async function collectMarkdownPathsFromDirectory(
  currentDirectory: string,
  state: MarkdownDiscoveryState,
): Promise<void> {
  state.directoryCount += 1;
  if (state.directoryCount > MAX_DISCOVERY_DIRECTORIES) {
    throw new Error(
      `Markdown link discovery visited more than ${MAX_DISCOVERY_DIRECTORIES} directories`,
    );
  }

  const entries = await readDirectoryEntriesBounded(currentDirectory);
  for (const entry of entries) {
    if (skipDirectoryNames.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(currentDirectory, entry.name);
    assertDiscoveryPathWithinLimit(state.root, absolutePath);

    if (entry.isDirectory()) {
      await collectMarkdownPathsFromDirectory(absolutePath, state);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.fileCount += 1;
    if (state.fileCount > MAX_DISCOVERY_FILES) {
      throw new Error(`Markdown link discovery visited more than ${MAX_DISCOVERY_FILES} files`);
    }

    if (entry.name.endsWith(".md")) {
      state.markdownPaths.push(absolutePath);
      if (state.markdownPaths.length > MAX_MARKDOWN_FILES) {
        throw new Error(`Repository must contain at most ${MAX_MARKDOWN_FILES} Markdown files`);
      }
    }
  }
}

export async function collectMarkdownPaths(cwd: string): Promise<string[]> {
  assertDocsPathValue(cwd, "cwd");
  const resolvedCwd = path.resolve(cwd);
  const state: MarkdownDiscoveryState = {
    root: resolvedCwd,
    markdownPaths: [],
    directoryCount: 0,
    fileCount: 0,
  };

  await collectMarkdownPathsFromDirectory(resolvedCwd, state);
  const markdownPaths = state.markdownPaths.sort();

  if (markdownPaths.length === 0) {
    throw new Error(`No Markdown files found in ${resolvedCwd}`);
  }

  return markdownPaths;
}

async function readMarkdownFileBounded(filePath: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`Markdown path must be a file: ${filePath}`);
    }

    if (stats.size > MAX_MARKDOWN_BYTES) {
      throw new Error(`Markdown file must be at most ${MAX_MARKDOWN_BYTES} bytes`);
    }

    const contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_MARKDOWN_BYTES) {
      throw new Error(`Markdown file must be at most ${MAX_MARKDOWN_BYTES} bytes`);
    }

    return contents;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function normalizeRawLinkTarget(rawTarget: string): string | undefined {
  let target = rawTarget.trim();
  if (target.length === 0) {
    return undefined;
  }

  if (target.startsWith("<")) {
    const closingIndex = target.indexOf(">");
    if (closingIndex < 0) {
      return undefined;
    }
    target = target.slice(1, closingIndex);
  } else {
    const whitespaceIndex = target.search(/\s/);
    if (whitespaceIndex >= 0) {
      target = target.slice(0, whitespaceIndex);
    }
  }

  return target.length > 0 ? target : undefined;
}

function shouldSkipLinkTarget(target: string): boolean {
  return (
    target.startsWith("#") || target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
  );
}

function resolveLocalLinkTarget(
  cwd: string,
  docPath: string,
  target: string,
): { targetPath?: string; error?: string } {
  const pathWithoutFragment = target.split("#", 1)[0] ?? "";
  const pathWithoutQuery = pathWithoutFragment.split("?", 1)[0] ?? "";

  if (pathWithoutQuery.length === 0) {
    return {};
  }

  if (pathWithoutQuery.includes("\0")) {
    return { error: "local Markdown link target must not contain NUL bytes" };
  }

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(pathWithoutQuery);
  } catch {
    return { error: "local Markdown link target is not valid percent-encoding" };
  }

  const targetPath = decodedTarget.startsWith("/")
    ? path.resolve(cwd, `.${decodedTarget}`)
    : path.resolve(path.dirname(docPath), decodedTarget);

  return { targetPath };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateMarkdownFileLinks(
  cwd: string,
  docPath: string,
): Promise<DocsLinkCheckResult> {
  const diagnostics: DocsLinkDiagnostic[] = [];
  let linkCount = 0;

  try {
    const contents = await readMarkdownFileBounded(docPath);
    const lines = contents.split(/\r?\n/);
    const linkPattern = /\[[^\]\n]*]\(([^)\n]*)\)/g;

    for (const [index, line] of lines.entries()) {
      linkPattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = linkPattern.exec(line)) !== null) {
        if (match.index > 0 && line[match.index - 1] === "!") {
          continue;
        }

        const rawTarget = match[1] ?? "";
        const target = normalizeRawLinkTarget(rawTarget);
        if (target === undefined || shouldSkipLinkTarget(target)) {
          continue;
        }

        linkCount += 1;
        const resolved = resolveLocalLinkTarget(cwd, docPath, target);
        if (resolved.error) {
          diagnostics.push({
            level: "error",
            code: "local_markdown_link_invalid",
            docPath,
            line: index + 1,
            target,
            message: resolved.error,
          });
          continue;
        }

        if (resolved.targetPath === undefined) {
          continue;
        }

        if (!isPathInside(cwd, resolved.targetPath)) {
          diagnostics.push({
            level: "error",
            code: "local_markdown_link_outside_repo",
            docPath,
            line: index + 1,
            target,
            message: `Local Markdown link points outside the repository: ${target}`,
          });
          continue;
        }

        if (!(await pathExists(resolved.targetPath))) {
          diagnostics.push({
            level: "error",
            code: "local_markdown_link_missing",
            docPath,
            line: index + 1,
            target,
            message: `Local Markdown link target does not exist: ${target}`,
          });
        }
      }
    }
  } catch (error) {
    diagnostics.push({
      level: "error",
      code: "markdown_invalid",
      docPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    docPath,
    linkCount,
    diagnostics,
    errorCount: diagnostics.length,
  };
}

export async function validateDocsLinks(options: {
  cwd: string;
  markdownPaths?: string[];
}): Promise<DocsLinkCheckSummary> {
  assertDocsPathValue(options.cwd, "cwd");
  const cwd = path.resolve(options.cwd);
  if (options.markdownPaths && options.markdownPaths.length > MAX_MARKDOWN_FILES) {
    throw new Error(`Markdown link check can inspect at most ${MAX_MARKDOWN_FILES} Markdown files`);
  }

  const markdownPaths = options.markdownPaths
    ? options.markdownPaths
        .map((filePath, index) => {
          assertDocsPathValue(filePath, `markdownPaths[${index}]`);
          return path.resolve(cwd, filePath);
        })
        .sort()
    : await collectMarkdownPaths(cwd);

  const results: DocsLinkCheckResult[] = [];
  for (const docPath of markdownPaths) {
    results.push(await validateMarkdownFileLinks(cwd, docPath));
  }

  const linkCount = results.reduce((total, result) => total + result.linkCount, 0);
  const errorCount = results.reduce((total, result) => total + result.errorCount, 0);

  return {
    ok: errorCount === 0,
    docCount: markdownPaths.length,
    linkCount,
    errorCount,
    results,
  };
}

export function formatTextSummary(cwd: string, summary: DocsLinkCheckSummary): string {
  const lines = [
    `Checked ${summary.docCount} Markdown file${summary.docCount === 1 ? "" : "s"} with ${summary.linkCount} local link${summary.linkCount === 1 ? "" : "s"}:`,
  ];

  for (const result of summary.results) {
    const status = result.errorCount > 0 ? "FAIL" : "OK";
    lines.push(
      `- ${status} ${displayPath(cwd, result.docPath)} links=${result.linkCount} errors=${result.errorCount}`,
    );

    for (const diagnostic of result.diagnostics) {
      const line = diagnostic.line ? ` line=${diagnostic.line}` : "";
      const target = diagnostic.target ? ` target=${diagnostic.target}` : "";
      lines.push(`  error ${diagnostic.code}${line}${target}: ${diagnostic.message}`);
    }
  }

  lines.push(
    `Summary: docs=${summary.docCount} links=${summary.linkCount} errors=${summary.errorCount}${summary.ok ? "" : " (failed)"}`,
  );

  return lines.join("\n");
}

export async function runDocsLinkCheckCli(
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
    const summary = await validateDocsLinks({ cwd });
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
  const exitCode = await runDocsLinkCheckCli();
  process.exit(exitCode);
}
