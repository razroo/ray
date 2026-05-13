import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkReleaseSource } from "./check-source.mjs";

async function writePackageJson(root: string, relPath: string, pkg: unknown): Promise<void> {
  const packagePath = path.join(root, relPath);
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

test("checkReleaseSource accepts linked package versions for a release tag", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-ok-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core",
    version: "1.2.3",
  });
  await writePackageJson(tempDir, "packages/sdk/package.json", {
    name: "@razroo/ray-sdk",
    version: "1.2.3",
    dependencies: {
      "@razroo/ray-core": "workspace:*",
    },
  });

  assert.deepEqual(await checkReleaseSource("1.2.3", { cwd: tempDir }), [
    "@razroo/ray-core: 1.2.3",
    "@razroo/ray-sdk: 1.2.3",
  ]);
});

test("checkReleaseSource rejects mismatched package versions and file dependencies", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-bad-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core",
    version: "1.2.2",
  });
  await writePackageJson(tempDir, "packages/sdk/package.json", {
    name: "@razroo/ray-sdk",
    version: "1.2.3",
    dependencies: {
      "@razroo/ray-core": "file:../core",
    },
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /packages\/core\/package\.json version 1\.2\.2 does not match release tag 1\.2\.3/,
  );

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core",
    version: "1.2.3",
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /file: dependencies are published verbatim/,
  );
});
