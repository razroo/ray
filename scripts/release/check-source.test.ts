import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkReleaseSource } from "./check-source.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

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

test("checkReleaseSource rejects malformed release tags and package name drift", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-name-"));
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
  });

  await assert.rejects(
    () => checkReleaseSource("1.2", { cwd: tempDir }),
    /release version must be a valid SemVer string/,
  );

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core-next",
    version: "1.2.3",
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /packages\/core\/package\.json must be named @razroo\/ray-core before publishing/,
  );

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core",
    version: "latest",
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /packages\/core\/package\.json version must be a valid SemVer string/,
  );
});

test("checkReleaseSource rejects malformed manifest inputs before reading packages", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-paths-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      checkReleaseSource("1.2.3", {
        cwd: tempDir,
        manifests: [],
      }),
    /manifests must be a non-empty array of paths/,
  );

  await assert.rejects(
    () =>
      checkReleaseSource("1.2.3", {
        cwd: tempDir,
        manifests: [" packages/core/package.json"],
      }),
    /manifests\[0\] must be a path without surrounding whitespace/,
  );

  await assert.rejects(
    () =>
      checkReleaseSource("1.2.3", {
        cwd: tempDir,
        manifests: [path.join(path.dirname(tempDir), "outside-package.json")],
      }),
    /manifests\[0\] must stay inside cwd/,
  );
});

test("package-local release source checks use the bounded root verifier", async () => {
  const packageChecks = [
    {
      scriptPath: path.join(repoRoot, "packages/core/scripts/release/check-source.mjs"),
      packagePath: path.join(repoRoot, "packages/core/package.json"),
      name: "@razroo/ray-core",
    },
    {
      scriptPath: path.join(repoRoot, "packages/sdk/scripts/release/check-source.mjs"),
      packagePath: path.join(repoRoot, "packages/sdk/package.json"),
      name: "@razroo/ray-sdk",
    },
  ];

  for (const check of packageChecks) {
    const pkg = JSON.parse(await readFile(check.packagePath, "utf8")) as { version: string };
    const { stdout } = await execFileAsync(process.execPath, [check.scriptPath, pkg.version], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });

    assert.equal(stdout.trim(), `${check.name}: ${pkg.version}`);
  }
});
