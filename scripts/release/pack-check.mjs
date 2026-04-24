import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const destination = path.join(root, ".ray", "packs");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
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
    const child = spawn(pnpmBin, ["pack", "--pack-destination", destination], {
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

await fs.rm(destination, { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });

for (const packageConfig of packages) {
  await runPack(packageConfig);
}

const packedFiles = await fs.readdir(destination);

for (const packageConfig of packages) {
  const found = packedFiles.some(
    (file) => file.includes(packageConfig.expectedFragment) && file.endsWith(".tgz"),
  );

  if (!found) {
    throw new Error(`${packageConfig.name} did not produce an npm tarball`);
  }
}

console.log(`Packed npm artifacts: ${packedFiles.join(", ")}`);
