import assert from "node:assert/strict";
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
