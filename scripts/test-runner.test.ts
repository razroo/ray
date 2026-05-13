import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertTestDiskHeadroom,
  collectTestFiles,
  resolveMinimumTestFreeSpaceMiB,
  resolveTestCommandTimeoutMs,
  runTestCli,
  runTestCommand,
} from "./test.mjs";

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

test("collectTestFiles rejects malformed direct roots before discovery", async () => {
  await assert.rejects(
    () => collectTestFiles(" /srv/ray"),
    /root must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () => collectTestFiles(`/${"a".repeat(4096)}`),
    /root must be at most 4096 bytes/,
  );
});

test("collectTestFiles streams directory entries without readdir", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-stream-"));
  const originalReaddir = fs.readdir;

  t.after(async () => {
    Object.defineProperty(fs, "readdir", {
      configurable: true,
      value: originalReaddir,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "packages", "runtime", "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "packages", "runtime", "dist", "runtime.test.js"), "");

  Object.defineProperty(fs, "readdir", {
    configurable: true,
    value: async () => {
      throw new Error("readdir should not be used during test discovery");
    },
  });

  const discovered = await collectTestFiles(tempDir);

  assert.deepEqual(relativePaths(tempDir, discovered.testFiles), [
    path.join("packages", "runtime", "dist", "runtime.test.js"),
  ]);
});

test("collectTestFiles rejects excessive entries in one directory", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-entry-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  await writeFile(path.join(tempDir, "scripts", "a.test.ts"), "");
  await writeFile(path.join(tempDir, "scripts", "b.test.ts"), "");

  await assert.rejects(
    () => collectTestFiles(tempDir, { maxDirectoryEntries: 1 }),
    /Test discovery found more than 1 entries in one directory/,
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

  const commands: Array<{ binary: string; args: string[]; cwd?: string; timeoutMs?: number }> = [];
  const code = await runTestCli({
    root: tempDir,
    commandTimeoutMs: 123_456,
    env: {
      RAY_BUN_BINARY: "/usr/local/bin/bun",
      RAY_NODE_BINARY: "/usr/local/bin/node",
    },
    diskPreflight: async () => undefined,
    runCommand: async (
      binary: string,
      args: string[],
      options?: { cwd?: string; timeoutMs?: number },
    ) => {
      commands.push({ binary, args, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
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
  assert.equal(commands[0]?.timeoutMs, 123_456);
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
  assert.equal(commands[1]?.timeoutMs, 123_456);
});

test("runTestCommand times out hung child commands", async () => {
  const stderr: string[] = [];
  const startedAt = Date.now();

  const code = await runTestCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 50,
    io: {
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
    },
  });

  assert.equal(code, 1);
  assert.match(stderr.join(""), /timed out after 50ms/);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("test disk preflight reports low repository or temp space before dispatch", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-test-runner-disk-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      assertTestDiskHeadroom({
        root: tempDir,
        tmpDir: path.join(tempDir, "tmp"),
        minFreeSpaceMiB: 1_024,
        statfs: async (targetPath: string) => ({
          bsize: 1024 * 1024,
          bavail: targetPath === tempDir ? 512 : 2_048,
        }),
      }),
    /requires at least 1024 MiB free on the repository volume/,
  );

  await assert.doesNotReject(() =>
    assertTestDiskHeadroom({
      root: tempDir,
      tmpDir: path.join(tempDir, "tmp"),
      minFreeSpaceMiB: 1_024,
      statfs: async () => ({
        bsize: 0,
        blocks: 4096,
        ffree: 300_000,
      }),
    }),
  );

  const stderr: string[] = [];
  const commands: string[] = [];
  const code = await runTestCli({
    root: tempDir,
    io: {
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
    },
    diskPreflight: async () => {
      throw new Error("disk preflight failed");
    },
    runCommand: async (binary: string) => {
      commands.push(binary);
      return 0;
    },
  });

  assert.equal(code, 1);
  assert.deepEqual(commands, []);
  assert.match(stderr.join(""), /disk preflight failed/);
});

test("test disk preflight rejects malformed direct paths before probing", async () => {
  let statfsCalls = 0;

  await assert.rejects(
    () =>
      assertTestDiskHeadroom({
        root: " /srv/ray",
        minFreeSpaceMiB: 1,
        statfs: async () => {
          statfsCalls += 1;
          return { bsize: 1024 * 1024, bavail: 2_048 };
        },
      }),
    /root must be a path without surrounding whitespace/,
  );

  await assert.rejects(
    () =>
      assertTestDiskHeadroom({
        root: process.cwd(),
        tmpDir: " /tmp",
        minFreeSpaceMiB: 1,
        statfs: async () => {
          statfsCalls += 1;
          return { bsize: 1024 * 1024, bavail: 2_048 };
        },
      }),
    /tmpDir must be a path without surrounding whitespace/,
  );

  await assert.rejects(
    () =>
      assertTestDiskHeadroom({
        root: `/${"a".repeat(4096)}`,
        minFreeSpaceMiB: 1,
        statfs: async () => {
          statfsCalls += 1;
          return { bsize: 1024 * 1024, bavail: 2_048 };
        },
      }),
    /root must be at most 4096 bytes/,
  );

  await assert.rejects(
    () =>
      assertTestDiskHeadroom({
        root: process.cwd(),
        tmpDir: `/${"a".repeat(4096)}`,
        minFreeSpaceMiB: 1,
        statfs: async () => {
          statfsCalls += 1;
          return { bsize: 1024 * 1024, bavail: 2_048 };
        },
      }),
    /tmpDir must be at most 4096 bytes/,
  );

  assert.equal(statfsCalls, 0);
});

test("resolveMinimumTestFreeSpaceMiB accepts bounded overrides", () => {
  assert.equal(resolveMinimumTestFreeSpaceMiB({}), 1024);
  assert.equal(resolveMinimumTestFreeSpaceMiB({ RAY_TEST_MIN_FREE_SPACE_MIB: "0" }), 0);
  assert.equal(resolveMinimumTestFreeSpaceMiB({ RAY_TEST_MIN_FREE_SPACE_MIB: "2048" }), 2048);
  assert.throws(
    () => resolveMinimumTestFreeSpaceMiB({ RAY_TEST_MIN_FREE_SPACE_MIB: "1.5" }),
    /RAY_TEST_MIN_FREE_SPACE_MIB must be a non-negative integer/,
  );
});

test("resolveTestCommandTimeoutMs accepts bounded overrides", () => {
  assert.equal(resolveTestCommandTimeoutMs({}), 600_000);
  assert.equal(resolveTestCommandTimeoutMs({ RAY_TEST_COMMAND_TIMEOUT_MS: "120000" }), 120_000);
  assert.throws(
    () => resolveTestCommandTimeoutMs({ RAY_TEST_COMMAND_TIMEOUT_MS: "0" }),
    /RAY_TEST_COMMAND_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => resolveTestCommandTimeoutMs({ RAY_TEST_COMMAND_TIMEOUT_MS: "3600001" }),
    /RAY_TEST_COMMAND_TIMEOUT_MS must be less than or equal to 3600000/,
  );
});
