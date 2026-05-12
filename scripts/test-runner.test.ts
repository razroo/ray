import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectTestFiles, runTestCli } from "./test.mjs";

function relativePaths(root: string, files: string[]): string[] {
  return files.map((file) => path.relative(root, file)).sort();
}

test("collectTestFiles finds built and script tests while skipping generated directories", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "packages", "runtime", "dist"), { recursive: true });
  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  await mkdir(path.join(tempDir, "node_modules", "pkg", "dist"), { recursive: true });
  await mkdir(path.join(tempDir, ".ray", "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "packages", "runtime", "dist", "runtime.test.js"), "");
  await writeFile(path.join(tempDir, "scripts", "benchmark.test.ts"), "");
  await writeFile(path.join(tempDir, "node_modules", "pkg", "dist", "ignored.test.js"), "");
  await writeFile(path.join(tempDir, ".ray", "dist", "ignored.test.js"), "");

  const discovered = await collectTestFiles(tempDir);

  assert.deepEqual(relativePaths(tempDir, discovered.testFiles), [
    path.join("packages", "runtime", "dist", "runtime.test.js"),
  ]);
  assert.deepEqual(relativePaths(tempDir, discovered.scriptTestFiles), [
    path.join("scripts", "benchmark.test.ts"),
  ]);
});

test("collectTestFiles rejects excessive discovered test files", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  await writeFile(path.join(tempDir, "scripts", "a.test.ts"), "");
  await writeFile(path.join(tempDir, "scripts", "b.test.ts"), "");

  await assert.rejects(
    () => collectTestFiles(tempDir, { maxScriptTestFiles: 1 }),
    /Test discovery found more than 1 script tests/,
  );
});

test("runTestCli dispatches bounded built tests before script tests", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-cli-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "apps", "gateway", "dist"), { recursive: true });
  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  await writeFile(path.join(tempDir, "apps", "gateway", "dist", "index.test.js"), "");
  await writeFile(path.join(tempDir, "scripts", "package-runtime-coverage.test.ts"), "");

  const commands: Array<{ binary: string; args: string[]; cwd?: string }> = [];
  const code = await runTestCli({
    root: tempDir,
    env: {
      RAY_BUN_BINARY: "/usr/local/bin/bun",
      RAY_NODE_BINARY: "/usr/local/bin/node",
    },
    runCommand: async (binary: string, args: string[], options?: { cwd?: string }) => {
      commands.push({ binary, args, cwd: options?.cwd });
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.binary, "/usr/local/bin/node");
  assert.deepEqual(commands[0]?.args.slice(0, 2), ["--test", "--test-concurrency=1"]);
  assert.equal(
    commands[0]?.args.at(-1),
    path.join(tempDir, "apps", "gateway", "dist", "index.test.js"),
  );
  assert.equal(commands[0]?.cwd, tempDir);
  assert.equal(commands[1]?.binary, "/usr/local/bin/bun");
  assert.deepEqual(commands[1]?.args.slice(0, 3), [
    "test",
    "--max-concurrency=1",
    "--timeout=120000",
  ]);
  assert.equal(
    commands[1]?.args.at(-1),
    path.join(tempDir, "scripts", "package-runtime-coverage.test.ts"),
  );
  assert.equal(commands[1]?.cwd, tempDir);
});
