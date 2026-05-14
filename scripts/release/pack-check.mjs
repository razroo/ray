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
  },
  {
    name: "@razroo/ray-sdk",
    cwd: path.join(root, "packages/sdk"),
    expectedFragment: "ray-sdk",
  },
];

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

    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const sizeRaw = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();

    if (sizeRaw && !/^[0-7]+$/.test(sizeRaw)) {
      throw new Error(`Pack tarball contains an invalid entry size: ${filePath}`);
    }

    const size = Number.parseInt(sizeRaw || "0", 8);

    const entryPath = prefix ? `${prefix}/${name}` : name;
    assertSafePackEntryPath(entryPath, filePath);

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
