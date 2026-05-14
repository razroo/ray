import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const root = process.cwd();
const destination = path.join(root, ".ray", "packs");
const bunBin = process.platform === "win32" ? "bun.exe" : "bun";
export const PACK_TIMEOUT_MS = 120_000;
export const PACK_SHUTDOWN_GRACE_MS = 5_000;
export const MAX_PACK_TARBALL_BYTES = 5 * 1024 * 1024;
export const MAX_PACK_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const MAX_PACK_TARBALL_ENTRIES = 512;
const DEFAULT_PACK_CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PACK_CHILD_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"];
const packedManifestDependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const unsafeManifestKeys = new Set(["__proto__", "constructor", "prototype"]);
const localOnlyDependencySpecPattern = /^(?:workspace|file|link|portal):|^(?:\.{1,2}\/|\/)/;
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packages = [
  {
    name: "@razroo/ray-core",
    cwd: path.join(root, "packages/core"),
    expectedFragment: "ray-core",
    requiredEntries: [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/src/index.ts",
      "package/CHANGELOG.md",
    ],
  },
  {
    name: "@razroo/ray-sdk",
    cwd: path.join(root, "packages/sdk"),
    expectedFragment: "ray-sdk",
    requiredEntries: [
      "package/package.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/src/index.ts",
      "package/README.md",
      "package/CHANGELOG.md",
    ],
  },
];
const allowedTarEntryTypes = new Set(["", "\0", "0", "5"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOwnEnvString(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    return undefined;
  }

  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function isSafePackChildEnvValue(value) {
  return value.length > 0 && !value.includes("\0");
}

export function buildPackCheckEnv(env = process.env) {
  if (env === null || typeof env !== "object") {
    throw new Error("env must be an object");
  }

  const childEnv = Object.create(null);
  const pathValue = readOwnEnvString(env, "PATH");
  childEnv.PATH =
    pathValue !== undefined && isSafePackChildEnvValue(pathValue)
      ? pathValue
      : DEFAULT_PACK_CHILD_PATH;

  for (const key of PACK_CHILD_ENV_KEYS) {
    const value = readOwnEnvString(env, key);
    if (value !== undefined && isSafePackChildEnvValue(value)) {
      childEnv[key] = value;
    }
  }

  return childEnv;
}

export async function runPack(packageConfig, options = {}) {
  const timeoutMs = options.timeoutMs ?? PACK_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    const child = spawn(bunBin, ["pm", "pack", "--destination", destination], {
      cwd: packageConfig.cwd,
      env: buildPackCheckEnv(),
      stdio: "inherit",
    });
    let timedOut = false;
    let killed = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      killed = child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, PACK_SHUTDOWN_GRACE_MS);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (timedOut) {
        reject(
          new Error(
            `${packageConfig.name} pack timed out after ${timeoutMs}ms${
              killed ? "" : " and could not be signalled"
            }`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${packageConfig.name} pack failed with exit code ${code ?? "unknown"} signal ${
            signal ?? "unknown"
          }`,
        ),
      );
    });
  });
}

async function gunzipBounded(compressed, maxBytes, filePath) {
  return await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks = [];
    let total = 0;

    gunzip.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        gunzip.destroy(new Error(`Pack tarball expands beyond ${maxBytes} bytes: ${filePath}`));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("error", reject);
    gunzip.on("end", () => {
      resolve(Buffer.concat(chunks, total));
    });
    gunzip.end(compressed);
  });
}

function assertSafePackEntryPath(entryPath, filePath) {
  if (
    !entryPath ||
    entryPath.includes("\\") ||
    /[\0\r\n]/.test(entryPath) ||
    path.posix.isAbsolute(entryPath)
  ) {
    throw new Error(`Pack tarball contains an unsafe entry path: ${entryPath || "[empty]"}`);
  }

  const segments = entryPath.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment === "." || segment === ".." || (segment === "" && index !== segments.length - 1),
    )
  ) {
    throw new Error(`Pack tarball contains an unsafe entry path: ${entryPath}`);
  }

  if (segments[0] !== "package") {
    throw new Error(`Pack tarball entry is outside the package root: ${entryPath} in ${filePath}`);
  }
}

function parseTarOctalField(header, offset, length, label, filePath) {
  const raw = header
    .toString("ascii", offset, offset + length)
    .replace(/\0.*$/, "")
    .trim();
  if (raw.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Pack tarball contains an invalid ${label}: ${filePath}`);
  }

  return Number.parseInt(raw, 8);
}

function checksumTarHeader(header) {
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(" ", 148, 156);
  let checksum = 0;
  for (const value of checksumHeader) {
    checksum += value;
  }
  return checksum;
}

function assertValidTarHeaderChecksum(header, filePath) {
  const expected = parseTarOctalField(header, 148, 8, "header checksum", filePath);
  const actual = checksumTarHeader(header);

  if (expected !== actual) {
    throw new Error(`Pack tarball contains an invalid header checksum: ${filePath}`);
  }
}

function readSafeTarEntryType(header, entryPath, filePath) {
  const typeflag = header.toString("ascii", 156, 157);
  if (allowedTarEntryTypes.has(typeflag)) {
    return typeflag;
  }

  const label =
    typeflag === "1"
      ? "hard link"
      : typeflag === "2"
        ? "symbolic link"
        : typeflag === "3" || typeflag === "4"
          ? "device"
          : `type ${JSON.stringify(typeflag)}`;
  throw new Error(`Pack tarball contains an unsafe ${label} entry: ${entryPath} in ${filePath}`);
}

async function inspectTarball(filePath, options = {}) {
  const maxTarballBytes = options.maxTarballBytes ?? MAX_PACK_TARBALL_BYTES;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? MAX_PACK_UNCOMPRESSED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_PACK_TARBALL_ENTRIES;
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error(`Pack artifact must be a file: ${filePath}`);
  }
  if (stats.size > maxTarballBytes) {
    throw new Error(`Pack tarball must be at most ${maxTarballBytes} bytes: ${filePath}`);
  }

  const compressed = await fs.readFile(filePath);
  if (compressed.byteLength > maxTarballBytes) {
    throw new Error(`Pack tarball must be at most ${maxTarballBytes} bytes: ${filePath}`);
  }

  const buffer = await gunzipBounded(compressed, maxUncompressedBytes, filePath);
  const entries = [];
  const files = new Map();
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const isEmptyHeader = header.every((value) => value === 0);

    if (isEmptyHeader) {
      break;
    }

    assertValidTarHeaderChecksum(header, filePath);

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const size = parseTarOctalField(header, 124, 12, "entry size", filePath);

    const entryPath = prefix ? `${prefix}/${name}` : name;
    assertSafePackEntryPath(entryPath, filePath);
    const typeflag = readSafeTarEntryType(header, entryPath, filePath);

    entries.push(entryPath);
    if (entries.length > maxEntries) {
      throw new Error(`Pack tarball must contain at most ${maxEntries} entries: ${filePath}`);
    }

    const contentSize = Number.isFinite(size) ? size : 0;
    const contentStart = offset + 512;
    const contentEnd = contentStart + contentSize;
    if (contentEnd > buffer.length) {
      throw new Error(`Pack tarball entry extends past archive bounds: ${filePath}`);
    }
    if (typeflag !== "5") {
      files.set(entryPath, buffer.subarray(contentStart, contentEnd));
    }

    offset += 512 + Math.ceil(contentSize / 512) * 512;
    if (offset > buffer.length) {
      throw new Error(`Pack tarball entry extends past archive bounds: ${filePath}`);
    }
  }

  return { entries, files };
}

export async function listTarballEntries(filePath, options = {}) {
  const inspected = await inspectTarball(filePath, options);
  return inspected.entries;
}

export async function readTarballJsonEntry(filePath, entryPath, options = {}) {
  assertSafePackEntryPath(entryPath, filePath);
  const inspected = await inspectTarball(filePath, options);
  const contents = inspected.files.get(entryPath);
  if (!contents) {
    throw new Error(`Pack tarball is missing JSON entry: ${entryPath} in ${filePath}`);
  }

  try {
    const parsed = JSON.parse(contents.toString("utf8"));
    if (!isRecord(parsed)) {
      throw new Error("expected object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Pack tarball contains invalid JSON entry ${entryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertNoUnsafeManifestKey(key, label) {
  if (unsafeManifestKeys.has(key)) {
    throw new Error(`${label} must not contain unsafe key "${key}"`);
  }
}

function manifestFieldLabel(parent, key) {
  return /^[A-Za-z0-9_$-]+$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function assertPackageManifestPathTarget(packageName, field, value, entrySet) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${packageName} package.json ${field} must be a non-empty string`);
  }
  if (value !== value.trim() || /[\0\r\n]/.test(value) || value.includes("\\")) {
    throw new Error(`${packageName} package.json ${field} must be a clean relative path`);
  }
  if (!value.startsWith("./")) {
    throw new Error(`${packageName} package.json ${field} must start with ./`);
  }

  const target = `package/${value.slice(2)}`;
  assertSafePackEntryPath(target, `${packageName} package.json`);
  if (!entrySet.has(target)) {
    throw new Error(`${packageName} package.json ${field} points to missing entry ${target}`);
  }
}

function collectExportTargets(packageName, value, label, targets) {
  if (typeof value === "string") {
    targets.push({ field: label, value });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectExportTargets(packageName, item, `${label}[${index}]`, targets),
    );
    return;
  }

  if (!isRecord(value)) {
    throw new Error(`${packageName} package.json ${label} must contain strings or objects`);
  }

  for (const [key, item] of Object.entries(value)) {
    assertNoUnsafeManifestKey(key, `${packageName} package.json ${label}`);
    collectExportTargets(packageName, item, manifestFieldLabel(label, key), targets);
  }
}

function assertNoLocalOnlyDependencySpecs(packageName, manifest) {
  for (const section of packedManifestDependencySections) {
    const dependencies = manifest[section];
    if (dependencies === undefined) {
      continue;
    }
    if (!isRecord(dependencies)) {
      throw new Error(`${packageName} package.json ${section} must be an object`);
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      assertNoUnsafeManifestKey(name, `${packageName} package.json ${section}`);
      if (typeof spec !== "string" || spec.length === 0 || spec !== spec.trim()) {
        throw new Error(`${packageName} package.json ${section}.${name} must be a clean string`);
      }
      if (localOnlyDependencySpecPattern.test(spec)) {
        throw new Error(
          `${packageName} package.json ${section}.${name} must not publish local-only dependency spec ${spec}`,
        );
      }
    }
  }
}

function assertNoPackedPackageScripts(packageName, manifest) {
  if (manifest.scripts !== undefined) {
    throw new Error(`${packageName} package.json must not publish scripts`);
  }
}

export function assertPackedPackageManifest(packageName, manifest, entries) {
  if (!isRecord(manifest)) {
    throw new Error(`${packageName} package.json must contain an object`);
  }

  if (manifest.name !== packageName) {
    throw new Error(
      `${packageName} package.json name must be ${packageName}; found ${
        typeof manifest.name === "string" ? manifest.name : "unknown"
      }`,
    );
  }
  if (typeof manifest.version !== "string" || !semverPattern.test(manifest.version)) {
    throw new Error(`${packageName} package.json version must be a valid SemVer string`);
  }
  if (!isRecord(manifest.publishConfig) || manifest.publishConfig.access !== "public") {
    throw new Error(`${packageName} package.json publishConfig.access must be public`);
  }

  const entrySet = new Set(entries);
  assertPackageManifestPathTarget(packageName, "main", manifest.main, entrySet);
  assertPackageManifestPathTarget(packageName, "types", manifest.types, entrySet);
  if (manifest.exports === undefined) {
    throw new Error(`${packageName} package.json exports must be present`);
  }

  const exportTargets = [];
  collectExportTargets(packageName, manifest.exports, "exports", exportTargets);
  for (const target of exportTargets) {
    assertPackageManifestPathTarget(packageName, target.field, target.value, entrySet);
  }

  assertNoLocalOnlyDependencySpecs(packageName, manifest);
  assertNoPackedPackageScripts(packageName, manifest);
}

export function assertRequiredTarballEntries(packageName, entries, requiredEntries) {
  const entrySet = new Set(entries);
  const missingEntries = requiredEntries.filter((entry) => !entrySet.has(entry));

  if (missingEntries.length > 0) {
    throw new Error(
      `${packageName} package is missing required entries: ${missingEntries.join(", ")}`,
    );
  }
}

export async function runPackCheck() {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });

  for (const packageConfig of packages) {
    await runPack(packageConfig);
  }

  const packedFiles = await fs.readdir(destination);

  for (const packageConfig of packages) {
    const packedFile = packedFiles.find(
      (file) => file.includes(packageConfig.expectedFragment) && file.endsWith(".tgz"),
    );

    if (!packedFile) {
      throw new Error(`${packageConfig.name} did not produce an npm tarball`);
    }

    const tarballPath = path.join(destination, packedFile);
    const entries = await listTarballEntries(tarballPath);
    assertRequiredTarballEntries(packageConfig.name, entries, packageConfig.requiredEntries);
    assertPackedPackageManifest(
      packageConfig.name,
      await readTarballJsonEntry(tarballPath, "package/package.json"),
      entries,
    );
    const testEntries = entries.filter((entry) => entry.includes(".test."));

    if (testEntries.length > 0) {
      throw new Error(
        `${packageConfig.name} package includes test artifacts: ${testEntries.join(", ")}`,
      );
    }
  }

  console.log(`Packed npm artifacts: ${packedFiles.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPackCheck();
}
