import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const MAX_CLEAN_DIRECTORIES = 4_096;
export const MAX_CLEAN_FILES = 32_768;
export const MAX_CLEAN_DIRECTORY_ENTRIES = 4_096;
export const MAX_CLEAN_REMOVALS = 2_048;
export const MAX_CLEAN_PATH_BYTES = 4_096;
export const MAX_CLEAN_RULES = 64;
export const MAX_CLEAN_RULE_BYTES = 256;
export const MAX_CLEAN_PACKAGE_JSON_BYTES = 512 * 1024;
export const DEFAULT_REMOVABLE_NAMES = new Set(["dist"]);
export const DEFAULT_REMOVABLE_SUFFIXES = [".tsbuildinfo"];
export const DEFAULT_SKIP_NAMES = new Set([
  ".git",
  ".playwright-mcp",
  ".ray",
  "coverage",
  "node_modules",
  "tmp",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCleanOption(options, key, defaultValue) {
  return Object.hasOwn(options, key) ? options[key] : defaultValue;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertPositiveIntegerAtMost(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
}

function assertCleanRuleValue(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_CLEAN_RULE_BYTES) {
    throw new Error(`${label} must be at most ${MAX_CLEAN_RULE_BYTES} bytes`);
  }
}

function assertCleanNameSet(value, label) {
  if (!(value instanceof Set)) {
    throw new Error(`${label} must be a Set`);
  }

  if (value.size > MAX_CLEAN_RULES) {
    throw new Error(`${label} must contain at most ${MAX_CLEAN_RULES} entries`);
  }

  let index = 0;
  for (const entry of value) {
    const entryLabel = `${label}[${index}]`;
    assertCleanRuleValue(entry, entryLabel);

    if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
      throw new Error(`${entryLabel} must be a single path segment`);
    }

    index += 1;
  }
}

function assertCleanSuffixes(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  if (value.length > MAX_CLEAN_RULES) {
    throw new Error(`${label} must contain at most ${MAX_CLEAN_RULES} entries`);
  }

  for (const [index, entry] of value.entries()) {
    const entryLabel = `${label}[${index}]`;
    assertCleanRuleValue(entry, entryLabel);

    if (entry.includes("/") || entry.includes("\\")) {
      throw new Error(`${entryLabel} must not contain path separators`);
    }
  }
}

function resolveCleanOptions(options) {
  if (!isRecord(options)) {
    throw new Error("clean options must be an object");
  }

  return {
    removableNames: readCleanOption(options, "removableNames", DEFAULT_REMOVABLE_NAMES),
    removableSuffixes: readCleanOption(options, "removableSuffixes", DEFAULT_REMOVABLE_SUFFIXES),
    skipNames: readCleanOption(options, "skipNames", DEFAULT_SKIP_NAMES),
    verifyRoot: readCleanOption(options, "verifyRoot", true),
    maxDirectories: readCleanOption(options, "maxDirectories", MAX_CLEAN_DIRECTORIES),
    maxFiles: readCleanOption(options, "maxFiles", MAX_CLEAN_FILES),
    maxDirectoryEntries: readCleanOption(
      options,
      "maxDirectoryEntries",
      MAX_CLEAN_DIRECTORY_ENTRIES,
    ),
    maxRemovals: readCleanOption(options, "maxRemovals", MAX_CLEAN_REMOVALS),
    maxPathBytes: readCleanOption(options, "maxPathBytes", MAX_CLEAN_PATH_BYTES),
  };
}

function assertCleanOptions(options) {
  assertCleanNameSet(options.removableNames, "removableNames");
  assertCleanSuffixes(options.removableSuffixes, "removableSuffixes");
  assertCleanNameSet(options.skipNames, "skipNames");
  assertBoolean(options.verifyRoot, "verifyRoot");
  assertPositiveIntegerAtMost(options.maxDirectories, "maxDirectories", MAX_CLEAN_DIRECTORIES);
  assertPositiveIntegerAtMost(options.maxFiles, "maxFiles", MAX_CLEAN_FILES);
  assertPositiveIntegerAtMost(
    options.maxDirectoryEntries,
    "maxDirectoryEntries",
    MAX_CLEAN_DIRECTORY_ENTRIES,
  );
  assertPositiveIntegerAtMost(options.maxRemovals, "maxRemovals", MAX_CLEAN_REMOVALS);
  assertPositiveIntegerAtMost(options.maxPathBytes, "maxPathBytes", MAX_CLEAN_PATH_BYTES);
}

function assertPathWithinLimit(root, absolutePath, maxPathBytes) {
  const displayPath = path.relative(root, absolutePath) || absolutePath;
  if (Buffer.byteLength(displayPath, "utf8") > maxPathBytes) {
    throw new Error(`Clean path must be at most ${maxPathBytes} bytes: ${displayPath}`);
  }
}

function assertCleanPathValue(value, label, maxPathBytes) {
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

async function readPackageJsonBounded(packageJsonPath) {
  let fileHandle;

  try {
    fileHandle = await fs.open(packageJsonPath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`package.json path must be a file: ${packageJsonPath}`);
    }

    if (stats.size > MAX_CLEAN_PACKAGE_JSON_BYTES) {
      throw new Error(`package.json must be at most ${MAX_CLEAN_PACKAGE_JSON_BYTES} bytes`);
    }

    const contents = await fileHandle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_CLEAN_PACKAGE_JSON_BYTES) {
      throw new Error(`package.json must be at most ${MAX_CLEAN_PACKAGE_JSON_BYTES} bytes`);
    }

    return contents;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

export async function assertRayRepoRoot(root) {
  const packageJsonPath = path.join(root, "package.json");

  try {
    const rawPackageJson = await readPackageJsonBounded(packageJsonPath);
    const parsed = JSON.parse(rawPackageJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      parsed.name !== "ray" ||
      typeof parsed.packageManager !== "string" ||
      !parsed.packageManager.startsWith("bun@")
    ) {
      throw new Error("package.json is not the Ray workspace root manifest");
    }
  } catch (error) {
    throw new Error(
      `clean must be run from the Ray repository root (${root}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function recordVisitedDirectory(state, options) {
  state.directoryCount += 1;
  if (state.directoryCount > options.maxDirectories) {
    throw new Error(`Clean visited more than ${options.maxDirectories} directories`);
  }
}

function recordVisitedFile(state, options) {
  state.fileCount += 1;
  if (state.fileCount > options.maxFiles) {
    throw new Error(`Clean visited more than ${options.maxFiles} files`);
  }
}

async function removePath(absolutePath, state, options) {
  state.removalCount += 1;
  if (state.removalCount > options.maxRemovals) {
    throw new Error(`Clean attempted more than ${options.maxRemovals} removals`);
  }

  await fs.rm(absolutePath, { recursive: true, force: true });
  state.removedPaths.push(absolutePath);
}

async function readDirectoryEntriesBounded(current, options) {
  const entries = [];
  let directory;

  try {
    directory = await fs.opendir(current);

    for await (const entry of directory) {
      entries.push(entry);

      if (entries.length > options.maxDirectoryEntries) {
        throw new Error(
          `Clean found more than ${options.maxDirectoryEntries} entries in one directory: ${current}`,
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

async function walk(current, state, options) {
  recordVisitedDirectory(state, options);
  const entries = await readDirectoryEntriesBounded(current, options);

  for (const entry of entries) {
    if (options.skipNames.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(current, entry.name);
    assertPathWithinLimit(state.root, absolutePath, options.maxPathBytes);

    if (entry.isDirectory()) {
      if (options.removableNames.has(entry.name)) {
        await removePath(absolutePath, state, options);
        continue;
      }

      await walk(absolutePath, state, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    recordVisitedFile(state, options);
    if (options.removableSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
      await removePath(absolutePath, state, options);
    }
  }
}

export async function cleanWorkspace(root = process.cwd(), options = {}) {
  const resolvedOptions = resolveCleanOptions(options);
  assertCleanOptions(resolvedOptions);
  assertCleanPathValue(root, "root", resolvedOptions.maxPathBytes);
  const resolvedRoot = path.resolve(root);

  if (resolvedOptions.verifyRoot) {
    await assertRayRepoRoot(resolvedRoot);
  }

  const state = {
    root: resolvedRoot,
    directoryCount: 0,
    fileCount: 0,
    removalCount: 0,
    removedPaths: [],
  };

  await walk(resolvedRoot, state, resolvedOptions);

  return {
    root: resolvedRoot,
    directoryCount: state.directoryCount,
    fileCount: state.fileCount,
    removalCount: state.removalCount,
    removedPaths: state.removedPaths.sort(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await cleanWorkspace();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
