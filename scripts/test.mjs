import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = process.cwd();
const testFiles = [];
const skipNames = new Set([".git", "node_modules"]);

async function collect(current) {
  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (skipNames.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await collect(absolutePath);
      continue;
    }

    if (entry.name.endsWith(".test.js") && absolutePath.includes(`${path.sep}dist${path.sep}`)) {
      testFiles.push(absolutePath);
    }
  }
}

await collect(root);

if (testFiles.length === 0) {
  console.error("No built test files were found. Run `pnpm build` first.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

