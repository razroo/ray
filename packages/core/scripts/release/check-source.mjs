import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckSourceCli } from "../../../../scripts/release/check-source.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const manifest = path
  .relative(repoRoot, path.join(packageRoot, "package.json"))
  .replaceAll("\\", "/");

process.exitCode = await runCheckSourceCli(process.argv.slice(2), process, {
  cwd: repoRoot,
  manifests: [manifest],
});
