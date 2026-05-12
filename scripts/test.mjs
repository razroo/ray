import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_TEST_DISCOVERY_DIRECTORIES = 4_096;
export const MAX_TEST_DISCOVERY_FILES = 32_768;
export const MAX_BUILT_TEST_FILES = 512;
export const MAX_SCRIPT_TEST_FILES = 256;
export const MAX_TEST_PATH_BYTES = 4_096;
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

function assertDiscoveryLimits(limits) {
  assertPositiveInteger(limits.maxDirectories, "maxDirectories");
  assertPositiveInteger(limits.maxFiles, "maxFiles");
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

function assertDiscoveredFileCount(count, max, label) {
  if (count > max) {
    throw new Error(`Test discovery found more than ${max} ${label}`);
  }
}

async function collectDirectory(current, state, limits, skipNames) {
  state.directoryCount += 1;
  if (state.directoryCount > limits.maxDirectories) {
    throw new Error(`Test discovery visited more than ${limits.maxDirectories} directories`);
  }

  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
  const resolvedRoot = path.resolve(root);
  const limits = resolveDiscoveryLimits(options);
  assertDiscoveryLimits(limits);
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

export function runTestCommand(binary, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: "inherit",
    });

    child.on("error", () => {
      resolve(1);
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function runTestCli(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const io = options.io ?? process;
  const env = options.env ?? process.env;
  const versions = options.versions ?? process.versions;
  const runCommand = options.runCommand ?? runTestCommand;
  const bunBinary = env.RAY_BUN_BINARY ?? (versions.bun ? process.execPath : "bun");
  const nodeBinary = env.RAY_NODE_BINARY ?? "node";
  const discovered = await collectTestFiles(root, options.discovery ?? {});

  if (discovered.testFiles.length === 0) {
    io.stderr.write("No built test files were found. Run `bun run build` first.\n");
    return 1;
  }

  let code = await runCommand(
    nodeBinary,
    ["--test", "--test-concurrency=1", ...discovered.testFiles],
    { cwd: root },
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
    { cwd: root },
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
