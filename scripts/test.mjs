import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const MAX_TEST_DISCOVERY_DIRECTORIES = 4_096;
export const MAX_TEST_DISCOVERY_FILES = 32_768;
export const MAX_TEST_DIRECTORY_ENTRIES = 4_096;
export const MAX_BUILT_TEST_FILES = 512;
export const MAX_SCRIPT_TEST_FILES = 256;
export const MAX_TEST_PATH_BYTES = 4_096;
export const DEFAULT_MIN_TEST_FREE_SPACE_MIB = 1_024;
export const MAX_TEST_FREE_SPACE_MIB = 1_048_576;
export const DEFAULT_TEST_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_TEST_COMMAND_TIMEOUT_MS = 3_600_000;
const BYTES_PER_MIB = 1024 * 1024;
const TEST_COMMAND_KILL_GRACE_MS = 5_000;
const MAX_TEST_COMMAND_DISPLAY_CHARS = 512;
export const DEFAULT_SKIP_NAMES = new Set([
  ".git",
  ".playwright-mcp",
  ".ray",
  "coverage",
  "node_modules",
  "tmp",
]);

function resolveDiscoveryLimits(options) {
  return {
    maxDirectories: options.maxDirectories ?? MAX_TEST_DISCOVERY_DIRECTORIES,
    maxFiles: options.maxFiles ?? MAX_TEST_DISCOVERY_FILES,
    maxDirectoryEntries: options.maxDirectoryEntries ?? MAX_TEST_DIRECTORY_ENTRIES,
    maxBuiltTestFiles: options.maxBuiltTestFiles ?? MAX_BUILT_TEST_FILES,
    maxScriptTestFiles: options.maxScriptTestFiles ?? MAX_SCRIPT_TEST_FILES,
    maxPathBytes: options.maxPathBytes ?? MAX_TEST_PATH_BYTES,
  };
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function parseNonNegativeInteger(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  if (parsed > MAX_TEST_FREE_SPACE_MIB) {
    throw new Error(`${label} must be less than or equal to ${MAX_TEST_FREE_SPACE_MIB}`);
  }

  return parsed;
}

function parsePositiveIntegerAtMost(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  if (parsed > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }

  return parsed;
}

export function resolveMinimumTestFreeSpaceMiB(env = process.env) {
  return (
    parseNonNegativeInteger(env.RAY_TEST_MIN_FREE_SPACE_MIB, "RAY_TEST_MIN_FREE_SPACE_MIB") ??
    DEFAULT_MIN_TEST_FREE_SPACE_MIB
  );
}

export function resolveTestCommandTimeoutMs(env = process.env) {
  return (
    parsePositiveIntegerAtMost(
      env.RAY_TEST_COMMAND_TIMEOUT_MS,
      "RAY_TEST_COMMAND_TIMEOUT_MS",
      MAX_TEST_COMMAND_TIMEOUT_MS,
    ) ?? DEFAULT_TEST_COMMAND_TIMEOUT_MS
  );
}

function assertDiscoveryLimits(limits) {
  assertPositiveInteger(limits.maxDirectories, "maxDirectories");
  assertPositiveInteger(limits.maxFiles, "maxFiles");
  assertPositiveInteger(limits.maxDirectoryEntries, "maxDirectoryEntries");
  assertPositiveInteger(limits.maxBuiltTestFiles, "maxBuiltTestFiles");
  assertPositiveInteger(limits.maxScriptTestFiles, "maxScriptTestFiles");
  assertPositiveInteger(limits.maxPathBytes, "maxPathBytes");
}

function assertPathWithinLimit(root, absolutePath, maxPathBytes) {
  const displayPath = path.relative(root, absolutePath) || absolutePath;
  if (Buffer.byteLength(displayPath, "utf8") > maxPathBytes) {
    throw new Error(`Test discovery path must be at most ${maxPathBytes} bytes: ${displayPath}`);
  }
}

function assertTestPathValue(value, label, maxPathBytes = MAX_TEST_PATH_BYTES) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must be a path without surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > maxPathBytes) {
    throw new Error(`${label} must be at most ${maxPathBytes} bytes`);
  }
}

function assertDiscoveredFileCount(count, max, label) {
  if (count > max) {
    throw new Error(`Test discovery found more than ${max} ${label}`);
  }
}

async function readDirectoryEntriesBounded(current, limits) {
  const entries = [];
  let directory;

  try {
    directory = await fs.opendir(current);

    for await (const entry of directory) {
      entries.push(entry);

      if (entries.length > limits.maxDirectoryEntries) {
        throw new Error(
          `Test discovery found more than ${limits.maxDirectoryEntries} entries in one directory: ${current}`,
        );
      }
    }
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // Directory async iteration closes the handle on normal completion in some runtimes.
      }
    }
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectDirectory(current, state, limits, skipNames) {
  state.directoryCount += 1;
  if (state.directoryCount > limits.maxDirectories) {
    throw new Error(`Test discovery visited more than ${limits.maxDirectories} directories`);
  }

  const entries = await readDirectoryEntriesBounded(current, limits);

  for (const entry of entries) {
    if (skipNames.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(current, entry.name);
    assertPathWithinLimit(state.root, absolutePath, limits.maxPathBytes);

    if (entry.isDirectory()) {
      await collectDirectory(absolutePath, state, limits, skipNames);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.fileCount += 1;
    if (state.fileCount > limits.maxFiles) {
      throw new Error(`Test discovery visited more than ${limits.maxFiles} files`);
    }

    if (entry.name.endsWith(".test.js") && absolutePath.includes(`${path.sep}dist${path.sep}`)) {
      state.testFiles.push(absolutePath);
      assertDiscoveredFileCount(state.testFiles.length, limits.maxBuiltTestFiles, "built tests");
    }

    if (entry.name.endsWith(".test.ts") && absolutePath.includes(`${path.sep}scripts${path.sep}`)) {
      state.scriptTestFiles.push(absolutePath);
      assertDiscoveredFileCount(
        state.scriptTestFiles.length,
        limits.maxScriptTestFiles,
        "script tests",
      );
    }
  }
}

export async function collectTestFiles(root = process.cwd(), options = {}) {
  const limits = resolveDiscoveryLimits(options);
  assertDiscoveryLimits(limits);
  assertTestPathValue(root, "root", limits.maxPathBytes);
  const resolvedRoot = path.resolve(root);
  const state = {
    root: resolvedRoot,
    testFiles: [],
    scriptTestFiles: [],
    directoryCount: 0,
    fileCount: 0,
  };
  const skipNames = options.skipNames ?? DEFAULT_SKIP_NAMES;

  await collectDirectory(resolvedRoot, state, limits, skipNames);

  return {
    testFiles: state.testFiles.sort(),
    scriptTestFiles: state.scriptTestFiles.sort(),
    directoryCount: state.directoryCount,
    fileCount: state.fileCount,
  };
}

async function getAvailableSpaceMiB(targetPath, statfs) {
  const stats = await statfs(targetPath);
  const rawBlockSize = Number(stats.bsize);
  const blockSize =
    Number.isFinite(rawBlockSize) && rawBlockSize > 0 ? rawBlockSize : Number(stats.blocks);
  const availableBlocks =
    Number.isFinite(rawBlockSize) && rawBlockSize > 0
      ? Number(stats.bavail)
      : Number(stats.ffree ?? stats.bfree);

  if (
    !Number.isFinite(availableBlocks) ||
    !Number.isFinite(blockSize) ||
    availableBlocks < 0 ||
    blockSize <= 0
  ) {
    throw new Error(`Could not inspect available disk space at ${targetPath}`);
  }

  return Math.floor((availableBlocks * blockSize) / BYTES_PER_MIB);
}

export async function assertTestDiskHeadroom(options = {}) {
  const env = options.env ?? process.env;
  const minFreeSpaceMiB = options.minFreeSpaceMiB ?? resolveMinimumTestFreeSpaceMiB(env);
  const statfs = options.statfs ?? fs.statfs;

  if (minFreeSpaceMiB === 0) {
    return;
  }

  const rootPath = options.root ?? process.cwd();
  const tmpPath = options.tmpDir ?? tmpdir();
  assertTestPathValue(rootPath, "root");
  assertTestPathValue(tmpPath, "tmpDir");

  const targets = [
    { label: "repository", path: path.resolve(rootPath) },
    { label: "temporary directory", path: path.resolve(tmpPath) },
  ];

  for (const target of targets) {
    const availableMiB = await getAvailableSpaceMiB(target.path, statfs);
    if (availableMiB < minFreeSpaceMiB) {
      throw new Error(
        `Test disk preflight requires at least ${minFreeSpaceMiB} MiB free on the ${target.label} volume at ${target.path}, but only ${availableMiB} MiB is available. Clear caches or lower RAY_TEST_MIN_FREE_SPACE_MIB for constrained machines.`,
      );
    }
  }
}

export function runTestCommand(binary, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_COMMAND_TIMEOUT_MS;
    const io = options.io ?? process;
    let settled = false;
    let timeout;
    let killTimer;
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: "inherit",
    });

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(code);
    };

    timeout = setTimeout(() => {
      const command = formatTestCommand(binary, args);
      io.stderr.write(`${command} timed out after ${timeoutMs}ms\n`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, TEST_COMMAND_KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    child.on("error", () => {
      finish(1);
    });

    child.on("exit", (code) => {
      finish(code ?? 1);
    });
  });
}

function formatTestCommand(binary, args) {
  const command = [binary, ...args].join(" ");
  if (command.length <= MAX_TEST_COMMAND_DISPLAY_CHARS) {
    return command;
  }

  return `${command.slice(0, MAX_TEST_COMMAND_DISPLAY_CHARS)}...`;
}

export async function runTestCli(options = {}) {
  const rootPath = options.root ?? process.cwd();
  assertTestPathValue(rootPath, "root");
  const root = path.resolve(rootPath);
  const io = options.io ?? process;
  const env = options.env ?? process.env;
  const versions = options.versions ?? process.versions;
  const runCommand = options.runCommand ?? runTestCommand;
  const diskPreflight = options.diskPreflight ?? assertTestDiskHeadroom;
  const bunBinary = env.RAY_BUN_BINARY ?? (versions.bun ? process.execPath : "bun");
  const nodeBinary = env.RAY_NODE_BINARY ?? "node";
  const commandTimeoutMs = options.commandTimeoutMs ?? resolveTestCommandTimeoutMs(env);

  try {
    await diskPreflight({ root, env });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const discovered = await collectTestFiles(root, options.discovery ?? {});

  if (discovered.testFiles.length === 0) {
    io.stderr.write("No built test files were found. Run `bun run build` first.\n");
    return 1;
  }

  let code = await runCommand(
    nodeBinary,
    ["--test", "--test-concurrency=1", ...discovered.testFiles],
    { cwd: root, timeoutMs: commandTimeoutMs, io },
  );
  if (code !== 0) {
    return code;
  }

  if (discovered.scriptTestFiles.length === 0) {
    return 0;
  }

  code = await runCommand(
    bunBinary,
    ["test", "--max-concurrency=1", "--timeout=120000", ...discovered.scriptTestFiles],
    { cwd: root, timeoutMs: commandTimeoutMs, io },
  );

  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exitCode = await runTestCli();
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
