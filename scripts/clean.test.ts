import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_CLEAN_REMOVALS, cleanWorkspace, parseArgs, runCleanCli } from "./clean.mjs";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeRayPackageJson(root: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "ray", packageManager: "bun@1.3.9" }),
  );
}

function createTestIo() {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test("parseArgs accepts strict clean CLI options", () => {
  assert.deepEqual(parseArgs(["--cwd", "/srv/ray", "--json"]), {
    cwd: "/srv/ray",
    json: true,
    help: false,
  });

  assert.deepEqual(parseArgs(["--help"]), {
    cwd: ".",
    json: false,
    help: true,
  });
});

test("parseArgs rejects malformed clean argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(
    () => parseArgs(Array.from({ length: 5 }, () => "--json")),
    /argv must contain at most 4 entries/,
  );
  assert.throws(
    () => parseArgs(["--cwd", `/${"a".repeat(4096)}`]),
    /argv\[1\] must be at most 4096 bytes/,
  );
  assert.throws(() => parseArgs(["--cwd", `ray${"\0"}`]), /argv\[1\] must not contain NUL bytes/);
  assert.throws(
    () => parseArgs(["--cwd", " /srv/ray"]),
    /--cwd must be a path without surrounding whitespace/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["dist"]), /Unexpected positional argument: dist/);
});

test("cleanWorkspace removes build artifacts while skipping generated state directories", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeRayPackageJson(tempDir);
  await mkdir(path.join(tempDir, "packages", "runtime", "dist"), { recursive: true });
  await mkdir(path.join(tempDir, "packages", "runtime"), { recursive: true });
  await mkdir(path.join(tempDir, ".ray", "dist"), { recursive: true });
  await mkdir(path.join(tempDir, "node_modules", "pkg", "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "packages", "runtime", "dist", "index.js"), "");
  await writeFile(path.join(tempDir, "packages", "runtime", "tsconfig.tsbuildinfo"), "");
  await writeFile(path.join(tempDir, ".ray", "dist", "keep.js"), "");
  await writeFile(path.join(tempDir, "node_modules", "pkg", "dist", "keep.js"), "");

  const result = await cleanWorkspace(tempDir);

  assert.equal(result.removalCount, 2);
  assert.equal(await pathExists(path.join(tempDir, "packages", "runtime", "dist")), false);
  assert.equal(
    await pathExists(path.join(tempDir, "packages", "runtime", "tsconfig.tsbuildinfo")),
    false,
  );
  assert.equal(await pathExists(path.join(tempDir, ".ray", "dist", "keep.js")), true);
  assert.equal(
    await pathExists(path.join(tempDir, "node_modules", "pkg", "dist", "keep.js")),
    true,
  );
});

test("cleanWorkspace rejects non-Ray roots before walking", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-root-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "dist"), { recursive: true });

  await assert.rejects(
    () => cleanWorkspace(tempDir),
    /clean must be run from the Ray repository root/,
  );
  assert.equal(await pathExists(path.join(tempDir, "dist")), true);
});

test("cleanWorkspace rejects oversized package.json files after stat", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-root-post-read-limit-"));
  const originalOpen = fs.open;
  t.after(async () => {
    Object.defineProperty(fs, "open", {
      configurable: true,
      value: originalOpen,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  const packageJsonPath = path.join(tempDir, "package.json");
  await writeRayPackageJson(tempDir);

  Object.defineProperty(fs, "open", {
    configurable: true,
    value: async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== packageJsonPath) {
        return handle;
      }

      return {
        stat: async () => ({
          isFile: () => true,
          size: 64,
        }),
        readFile: async () => "x".repeat(512 * 1024 + 1),
        close: async () => {
          await handle.close();
        },
      } as Awaited<ReturnType<typeof fs.open>>;
    },
  });

  await assert.rejects(() => cleanWorkspace(tempDir), /package\.json must be at most 524288 bytes/);
});

test("cleanWorkspace rejects malformed direct roots before walking", async () => {
  await assert.rejects(
    () => cleanWorkspace(" /srv/ray"),
    /root must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () => cleanWorkspace(`/${"a".repeat(4096)}`),
    /root must be at most 4096 bytes/,
  );
});

test("cleanWorkspace rejects malformed clean rules before walking", async () => {
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { removableNames: new Set(["dist/build"]) }),
    /removableNames\[0\] must be a single path segment/,
  );
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { removableSuffixes: [".cache/file"] }),
    /removableSuffixes\[0\] must not contain path separators/,
  );
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { skipNames: new Set(["node_modules\n"]) }),
    /skipNames\[0\] must not contain control characters/,
  );
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { removableNames: ["dist"] }),
    /removableNames must be a Set/,
  );
});

test("cleanWorkspace rejects malformed clean options before walking", async () => {
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), null),
    /clean options must be an object/,
  );
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { verifyRoot: "false" }),
    /verifyRoot must be a boolean/,
  );
  await assert.rejects(
    () => cleanWorkspace(process.cwd(), { maxRemovals: MAX_CLEAN_REMOVALS + 1 }),
    /maxRemovals must be a positive safe integer no greater than 2048/,
  );
});

test("runCleanCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(() => runCleanCli([], null), /clean io must be an object/);
  await assert.rejects(
    () => runCleanCli([], { stdout: null, stderr: { write() {} } }),
    /clean io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runCleanCli([], { stdout: { write() {} }, stderr: null }),
    /clean io.stderr.write must be a function/,
  );
});

test("runCleanCli prints help to injected stdout", async () => {
  const output = createTestIo();

  const status = await runCleanCli(["--help"], output.io);

  assert.equal(status, 0);
  assert.match(output.stdout, /Usage:/);
  assert.match(output.stdout, /--cwd <path>/);
  assert.equal(output.stderr, "");
});

test("runCleanCli reports parser failures to injected stderr", async () => {
  const output = createTestIo();

  const status = await runCleanCli(["--cwd", " /srv/ray"], output.io);

  assert.equal(status, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /--cwd must be a path without surrounding whitespace/);
});

test("runCleanCli cleans a requested cwd and can print JSON", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-cli-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeRayPackageJson(tempDir);
  await mkdir(path.join(tempDir, "packages", "runtime", "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "packages", "runtime", "dist", "index.js"), "");

  const output = createTestIo();
  const status = await runCleanCli(["--cwd", tempDir, "--json"], output.io);

  assert.equal(status, 0);
  assert.equal(output.stderr, "");
  const summary = JSON.parse(output.stdout) as {
    root: string;
    removalCount: number;
    removedPaths: string[];
  };
  assert.equal(summary.root, tempDir);
  assert.equal(summary.removalCount, 1);
  assert.deepEqual(summary.removedPaths, [path.join(tempDir, "packages", "runtime", "dist")]);
  assert.equal(await pathExists(path.join(tempDir, "packages", "runtime", "dist")), false);
});

test("cleanWorkspace streams directory entries without readdir", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-stream-"));
  const originalReaddir = fs.readdir;

  t.after(async () => {
    Object.defineProperty(fs, "readdir", {
      configurable: true,
      value: originalReaddir,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeRayPackageJson(tempDir);
  await mkdir(path.join(tempDir, "packages", "runtime", "dist"), { recursive: true });
  await writeFile(path.join(tempDir, "packages", "runtime", "dist", "index.js"), "");

  Object.defineProperty(fs, "readdir", {
    configurable: true,
    value: async () => {
      throw new Error("readdir should not be used during clean traversal");
    },
  });

  const result = await cleanWorkspace(tempDir);

  assert.equal(result.removalCount, 1);
  assert.equal(await pathExists(path.join(tempDir, "packages", "runtime", "dist")), false);
});

test("cleanWorkspace rejects excessive entries in one directory", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-entry-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeRayPackageJson(tempDir);
  await writeFile(path.join(tempDir, "a.tsbuildinfo"), "");
  await writeFile(path.join(tempDir, "b.tsbuildinfo"), "");

  await assert.rejects(
    () => cleanWorkspace(tempDir, { maxDirectoryEntries: 1 }),
    /Clean found more than 1 entries in one directory/,
  );
});

test("cleanWorkspace caps removal work", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-clean-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeRayPackageJson(tempDir);
  await writeFile(path.join(tempDir, "a.tsbuildinfo"), "");
  await writeFile(path.join(tempDir, "b.tsbuildinfo"), "");

  await assert.rejects(
    () => cleanWorkspace(tempDir, { maxRemovals: 1 }),
    /Clean attempted more than 1 removals/,
  );
});
