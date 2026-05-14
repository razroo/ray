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

export async function runPack(packageConfig, options = {}) {
  const timeoutMs = options.timeoutMs ?? PACK_TIMEOUT_MS;
  await new Promise((resolve, reject) => {
    const child = spawn(bunBin, ["pm", "pack", "--destination", destination], {
      cwd: packageConfig.cwd,
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

function assertSafeTarEntryType(header, entryPath, filePath) {
  const typeflag = header.toString("ascii", 156, 157);
  if (allowedTarEntryTypes.has(typeflag)) {
    return;
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

export async function listTarballEntries(filePath, options = {}) {
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
  const buffer = await gunzipBounded(compressed, maxUncompressedBytes, filePath);
  const entries = [];
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
    assertSafeTarEntryType(header, entryPath, filePath);

    entries.push(entryPath);
    if (entries.length > maxEntries) {
      throw new Error(`Pack tarball must contain at most ${maxEntries} entries: ${filePath}`);
    }

    const contentSize = Number.isFinite(size) ? size : 0;
    offset += 512 + Math.ceil(contentSize / 512) * 512;
    if (offset > buffer.length) {
      throw new Error(`Pack tarball entry extends past archive bounds: ${filePath}`);
    }
  }

  return entries;
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

    const entries = await listTarballEntries(path.join(destination, packedFile));
    assertRequiredTarballEntries(packageConfig.name, entries, packageConfig.requiredEntries);
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
