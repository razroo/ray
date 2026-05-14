import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheckSourceCli } from "../../../../scripts/release/check-source.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const manifest = path
  .relative(repoRoot, path.join(packageRoot, "package.json"))
  .replaceAll("\\", "/");

export async function runPackageCheckSourceCli(argv = process.argv.slice(2), io = process) {
  return runCheckSourceCli(argv, io, {
    cwd: repoRoot,
    manifests: [manifest],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPackageCheckSourceCli();
}
