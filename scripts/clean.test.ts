import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanWorkspace } from "./clean.mjs";

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
