import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkReleaseSource, runCheckSource, runCheckSourceCli } from "./check-source.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

async function writePackageJson(root: string, relPath: string, pkg: unknown): Promise<void> {
  const packagePath = path.join(root, relPath);
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
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

const releasePackageFixtures = [
  ["packages/core/package.json", "@razroo/ray-core"],
  ["packages/sdk/package.json", "@razroo/ray-sdk"],
  ["packages/tuner/package.json", "@razroo/ray-tuner"],
  ["packages/prompt-cache/package.json", "@razroo/ray-prompt-cache"],
  ["packages/task-profiles/package.json", "@razroo/ray-task-profiles"],
] as const;

async function writeReleasePackageSet(root: string, version: string): Promise<void> {
  for (const [relPath, name] of releasePackageFixtures) {
    await writePackageJson(root, relPath, {
      name,
      version,
      ...(name !== "@razroo/ray-core"
        ? {
            dependencies: {
              "@razroo/ray-core": "workspace:*",
            },
          }
        : {}),
    });
  }
}

test("checkReleaseSource accepts linked package versions for a release tag", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-ok-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeReleasePackageSet(tempDir, "1.2.3");

  assert.deepEqual(await checkReleaseSource("1.2.3", { cwd: tempDir }), [
    "@razroo/ray-core: 1.2.3",
    "@razroo/ray-sdk: 1.2.3",
    "@razroo/ray-tuner: 1.2.3",
    "@razroo/ray-prompt-cache: 1.2.3",
    "@razroo/ray-task-profiles: 1.2.3",
  ]);
});

test("checkReleaseSource rejects mismatched package versions and local-only dependencies", async (t) => {
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
    /dependencies\["@razroo\/ray-core"\] is "file:\.\.\/core".*local-only dependency specs break published packages/,
  );

  await writePackageJson(tempDir, "packages/sdk/package.json", {
    name: "@razroo/ray-sdk",
    version: "1.2.3",
    dependencies: {
      "@razroo/ray-core": "link:../core",
    },
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /dependencies\["@razroo\/ray-core"\] is "link:\.\.\/core".*local-only dependency specs break published packages/,
  );

  await writePackageJson(tempDir, "packages/sdk/package.json", {
    name: "@razroo/ray-sdk",
    version: "1.2.3",
    optionalDependencies: {
      "@razroo/ray-core": "../core",
    },
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", { cwd: tempDir }),
    /optionalDependencies\["@razroo\/ray-core"\] is "\.\.\/core".*local-only dependency specs break published packages/,
  );
});

test("checkReleaseSource rejects malformed release tags and package name drift", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-name-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeReleasePackageSet(tempDir, "1.2.3");

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
        manifests: null,
      }),
    /manifests must be a non-empty array of paths/,
  );

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

test("checkReleaseSource rejects malformed direct options before reading packages", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-options-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await assert.rejects(
    () => checkReleaseSource("1.2.3", null),
    /release source options must be an object/,
  );

  await assert.rejects(
    () =>
      checkReleaseSource("1.2.3", {
        cwd: ` ${tempDir}`,
      }),
    /cwd must be a path without surrounding whitespace/,
  );
});

test("runCheckSource rejects malformed argv before reading packages", async () => {
  await assert.rejects(() => runCheckSource(null), /release source argv must be an array/);

  await assert.rejects(
    () => runCheckSource(["1.2.3\n"]),
    /release source argv\[0\] must not contain control characters/,
  );

  await assert.rejects(
    () => runCheckSource(["1.2.3", "extra"]),
    /Usage: bun \.\/scripts\/release\/check-source\.mjs <version>/,
  );
});

test("runCheckSource rejects malformed direct io before reading packages", async () => {
  await assert.rejects(
    () => runCheckSource(["1.2.3"], { io: null }),
    /release source io must be an object/,
  );
  await assert.rejects(
    () => runCheckSource(["1.2.3"], { io: { stdout: null, stderr: { write() {} } } }),
    /release source io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runCheckSource(["1.2.3"], { io: { stdout: { write() {} }, stderr: null } }),
    /release source io.stderr.write must be a function/,
  );
});

test("runCheckSource writes checked packages to injected stdout", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-io-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeReleasePackageSet(tempDir, "1.2.3");

  const output = createTestIo();

  await runCheckSource(["1.2.3"], { cwd: tempDir, io: output.io });

  assert.equal(
    output.stdout,
    [
      "@razroo/ray-core: 1.2.3",
      "@razroo/ray-sdk: 1.2.3",
      "@razroo/ray-tuner: 1.2.3",
      "@razroo/ray-prompt-cache: 1.2.3",
      "@razroo/ray-task-profiles: 1.2.3",
      "",
    ].join("\n"),
  );
  assert.equal(output.stderr, "");
});

test("runCheckSourceCli reports release source failures to injected stderr", async () => {
  const output = createTestIo();

  const status = await runCheckSourceCli(["1.2"], output.io);

  assert.equal(status, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /release version must be a valid SemVer string/);
});

test("runCheckSourceCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(
    () => runCheckSourceCli(["1.2.3"], null),
    /release source io must be an object/,
  );
  await assert.rejects(
    () => runCheckSourceCli(["1.2.3"], { stdout: null, stderr: { write() {} } }),
    /release source io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runCheckSourceCli(["1.2.3"], { stdout: { write() {} }, stderr: null }),
    /release source io.stderr.write must be a function/,
  );
});

test("runCheckSourceCli rejects malformed direct options before parsing", async () => {
  const output = createTestIo();

  await assert.rejects(
    () => runCheckSourceCli(["1.2.3"], output.io, null),
    /release source cli options must be an object/,
  );
});

test("checkReleaseSource rejects package manifests that exceed the byte cap after stat", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-release-check-source-post-read-size-"));
  const originalOpen = fsPromises.open;
  t.after(async () => {
    Object.defineProperty(fsPromises, "open", {
      configurable: true,
      value: originalOpen,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  await writePackageJson(tempDir, "packages/core/package.json", {
    name: "@razroo/ray-core",
    version: "1.2.3",
  });

  Object.defineProperty(fsPromises, "open", {
    configurable: true,
    value: async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args);
      return {
        stat: async () => ({
          isFile: () => true,
          size: 2,
        }),
        readFile: async () => "x".repeat(256 * 1024 + 1),
        close: async () => {
          await handle.close();
        },
      } as Awaited<ReturnType<typeof fsPromises.open>>;
    },
  });

  await assert.rejects(
    () =>
      checkReleaseSource("1.2.3", {
        cwd: tempDir,
        manifests: ["packages/core/package.json"],
      }),
    /package\.json must be at most 262144 bytes/,
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
    const scriptSource = await readFile(check.scriptPath, "utf8");
    assert.doesNotMatch(scriptSource, /process\.exit\(/);
    assert.doesNotMatch(scriptSource, /console\./);

    const pkg = JSON.parse(await readFile(check.packagePath, "utf8")) as { version: string };
    const previousExitCode = process.exitCode;
    const imported = await import(
      `${pathToFileURL(check.scriptPath).href}?import-test=${Date.now()}-${check.name}`
    );
    assert.equal(typeof imported.runPackageCheckSourceCli, "function");
    assert.equal(process.exitCode, previousExitCode);

    const output = createTestIo();
    const importedStatus = await imported.runPackageCheckSourceCli([pkg.version], output.io);
    assert.equal(importedStatus, 0);
    assert.equal(output.stdout.trim(), `${check.name}: ${pkg.version}`);
    assert.equal(output.stderr, "");

    const { stdout } = await execFileAsync(process.execPath, [check.scriptPath, pkg.version], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });

    assert.equal(stdout.trim(), `${check.name}: ${pkg.version}`);

    const failure = await execFileAsync(process.execPath, [check.scriptPath], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    }).then(
      () => undefined,
      (error: unknown) => error as { code: number; stdout: string; stderr: string },
    );

    assert.equal(failure?.code, 1);
    assert.equal(failure?.stdout, "");
    assert.match(
      failure?.stderr ?? "",
      /Usage: bun \.\/scripts\/release\/check-source\.mjs <version>/,
    );
  }
});
