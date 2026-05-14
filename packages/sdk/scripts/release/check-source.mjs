import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseSource } from "../../../../scripts/release/check-source.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const manifest = path
  .relative(repoRoot, path.join(packageRoot, "package.json"))
  .replaceAll("\\", "/");

function usage() {
  return "Usage: bun scripts/release/check-source.mjs <version>";
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const version = args[0];

  if (!version) {
    throw new Error(usage());
  }

  const checked = await checkReleaseSource(version, {
    cwd: repoRoot,
    manifests: [manifest],
  });

  for (const line of checked) {
    console.log(line);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
