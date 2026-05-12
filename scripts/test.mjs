import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = process.cwd();
const testFiles = [];
const scriptTestFiles = [];
const skipNames = new Set([".git", "node_modules"]);
const bunBinary = process.env.RAY_BUN_BINARY ?? (process.versions.bun ? process.execPath : "bun");
const nodeBinary = process.env.RAY_NODE_BINARY ?? "node";

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

    if (entry.name.endsWith(".test.ts") && absolutePath.includes(`${path.sep}scripts${path.sep}`)) {
      scriptTestFiles.push(absolutePath);
    }
  }
}

await collect(root);

if (testFiles.length === 0) {
  console.error("No built test files were found. Run `bun run build` first.");
  process.exit(1);
}

function runTestCommand(binary, args) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: root,
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

let code = await runTestCommand(nodeBinary, [
  "--test",
  "--test-concurrency=1",
  ...testFiles.sort(),
]);
if (code !== 0) {
  process.exit(code);
}

if (scriptTestFiles.length > 0) {
  code = await runTestCommand(bunBinary, [
    "test",
    "--max-concurrency=1",
    "--timeout=120000",
    ...scriptTestFiles.sort(),
  ]);
  if (code !== 0) {
    process.exit(code);
  }
}
