import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const destination = path.join(root, ".ray", "packs");
const bunBin = process.platform === "win32" ? "bun.exe" : "bun";
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

async function runPack(packageConfig) {
  await new Promise((resolve, reject) => {
    const child = spawn(bunBin, ["pm", "pack", "--destination", destination], {
      cwd: packageConfig.cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${packageConfig.name} pack failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function listTarballEntries(filePath) {
  const compressed = await fs.readFile(filePath);
  const buffer = gunzipSync(compressed);
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
    const size = Number.parseInt(sizeRaw || "0", 8);

    entries.push(prefix ? `${prefix}/${name}` : name);

    const contentSize = Number.isFinite(size) ? size : 0;
    offset += 512 + Math.ceil(contentSize / 512) * 512;
  }

  return entries;
}

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
