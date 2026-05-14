import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import test from "node:test";
import {
  checkDeployStorageHeadroom,
  formatTextSummary,
  loadDeployStoragePreflightArgs,
  parseArgs,
  runDeployStoragePreflightCli,
} from "./deploy-storage-preflight.ts";

type StatFn = typeof import("node:fs/promises").stat;
type StatfsFn = typeof import("node:fs/promises").statfs;
type RealpathFn = typeof import("node:fs/promises").realpath;

function missingPathError(path: string): NodeJS.ErrnoException {
  const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

test("parseArgs accepts deploy storage preflight options", () => {
  assert.deepEqual(parseArgs([], {}).paths, [
    "/",
    "/var/cache/apt",
    "/var/lib/apt",
    "/etc/ray",
    "/etc/systemd/system",
    "/etc/caddy",
    "/var/lib/caddy",
    "/srv/ray",
    "/srv/ray/.ray/bun-install-cache",
    "/var/lib/ray",
    "/var/log",
    "/tmp",
    "/var/tmp",
  ]);
  assert.equal(parseArgs([], {}).pathsExplicit, false);
  assert.equal(parseArgs([], { RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "2048" }).minFreeStorageMiB, 2048);
  assert.equal(
    parseArgs([], { RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "2048" }).minFreeStorageMiBSource,
    "env",
  );
  assert.equal(
    parseArgs([], Object.create({ RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "2048" })).minFreeStorageMiB,
    1024,
  );
  assert.equal(
    parseArgs([], Object.create({ RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "2048" }))
      .minFreeStorageMiBSource,
    "default",
  );
  assert.deepEqual(parseArgs(["--path", "/srv/ray", "--path", "/var/lib/ray"]).paths, [
    "/srv/ray",
    "/var/lib/ray",
  ]);
  assert.equal(parseArgs(["--path", "/srv/ray"]).pathsExplicit, true);
  assert.equal(parseArgs(["--ray-env-file", "/etc/ray/ray.env"]).envFile, "/etc/ray/ray.env");
  assert.equal(parseArgs(["--min-free-mib", "0", "--json"]).minFreeStorageMiB, 0);
  assert.equal(parseArgs(["--min-free-mib", "0", "--json"]).minFreeStorageMiBSource, "flag");
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs rejects malformed deploy storage preflight options", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs([], null as unknown as NodeJS.ProcessEnv),
    /deploy storage preflight env must be an object/,
  );
  assert.throws(() => parseArgs(["--path"]), /--path requires a value/);
  assert.throws(() => parseArgs(["--ray-env-file"]), /--ray-env-file requires a value/);
  assert.throws(
    () => parseArgs(["--ray-env-file", " ray.env"]),
    /--ray-env-file must be a non-empty path without surrounding whitespace/,
  );
  assert.throws(() => parseArgs(["--path", "relative"]), /storage path must be absolute/);
  assert.throws(
    () => parseArgs(["--min-free-mib", "1.5"]),
    /--min-free-mib must be a non-negative integer/,
  );
  assert.throws(
    () => parseArgs([], { RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "bad" }),
    /RAY_DEPLOY_MIN_FREE_STORAGE_MIB must be a non-negative integer/,
  );
});

test("loadDeployStoragePreflightArgs applies bounded ray env file thresholds", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-storage-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    [
      "# deploy overrides",
      "RAY_DEPLOY_MIN_FREE_STORAGE_MIB=2048",
      'RAY_MODEL_PATH="/mnt/ray/models/local 1b.gguf"',
      "RAY_LLAMA_CPP_MODEL_PATH=/ignored/fallback.gguf",
      "RAY_LLAMA_CPP_BINARY_PATH=/opt/ray/bin/llama-server",
      "RAY_ASYNC_QUEUE_STORAGE_DIR=/mnt/ray/async-queue",
      "RAY_LLAMA_CPP_BINARY_SOURCE_PATH=./artifacts/llama-server",
      'RAY_MODEL_SOURCE_PATH="./artifacts/local 1b.gguf"',
      "RAY_API_KEYS=not-retained-by-storage-preflight",
      "",
    ].join("\n"),
  );

  const fromEnvFile = await loadDeployStoragePreflightArgs(["--ray-env-file", envFile], {
    RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "512",
  });
  assert.equal(fromEnvFile.minFreeStorageMiB, 2048);
  assert.equal(fromEnvFile.minFreeStorageMiBSource, "env-file");
  assert.deepEqual(fromEnvFile.paths, [
    "/",
    "/var/cache/apt",
    "/var/lib/apt",
    "/etc/ray",
    "/etc/systemd/system",
    "/etc/caddy",
    "/var/lib/caddy",
    "/srv/ray",
    "/srv/ray/.ray/bun-install-cache",
    "/var/lib/ray",
    "/var/log",
    "/tmp",
    "/var/tmp",
    "/mnt/ray/models/local 1b.gguf",
    "/opt/ray/bin/llama-server",
    "/mnt/ray/async-queue",
    posix.resolve("./artifacts/llama-server"),
    posix.resolve("./artifacts/local 1b.gguf"),
  ]);

  const fromFlag = await loadDeployStoragePreflightArgs(
    ["--ray-env-file", envFile, "--min-free-mib", "128"],
    {},
  );
  assert.equal(fromFlag.minFreeStorageMiB, 128);
  assert.equal(fromFlag.minFreeStorageMiBSource, "flag");
  assert.deepEqual(fromFlag.paths.slice(-2), [
    posix.resolve("./artifacts/llama-server"),
    posix.resolve("./artifacts/local 1b.gguf"),
  ]);
  assert.deepEqual(fromFlag.paths.slice(-5), [
    "/mnt/ray/models/local 1b.gguf",
    "/opt/ray/bin/llama-server",
    "/mnt/ray/async-queue",
    posix.resolve("./artifacts/llama-server"),
    posix.resolve("./artifacts/local 1b.gguf"),
  ]);

  const explicitPath = await loadDeployStoragePreflightArgs(
    ["--ray-env-file", envFile, "--path", "/srv/custom"],
    {},
  );
  assert.deepEqual(explicitPath.paths, ["/srv/custom"]);
  assert.equal(explicitPath.minFreeStorageMiB, 2048);
  assert.equal(explicitPath.minFreeStorageMiBSource, "env-file");

  await writeFile(
    envFile,
    [
      'RAY_MODEL_PATH=" "',
      "RAY_LLAMA_CPP_MODEL_PATH=/mnt/ray/models/fallback.gguf",
      'RAY_LLAMA_CPP_BINARY_PATH=" "',
      'RAY_ASYNC_QUEUE_STORAGE_DIR=""',
      "",
    ].join("\n"),
  );
  const fromFallbackModelPath = await loadDeployStoragePreflightArgs(
    ["--ray-env-file", envFile],
    {},
  );
  assert.deepEqual(fromFallbackModelPath.paths.slice(-1), ["/mnt/ray/models/fallback.gguf"]);
});

test("loadDeployStoragePreflightArgs rejects malformed ray env file thresholds", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-storage-env-bad-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const envFile = join(tempDir, "ray.env");
  await writeFile(envFile, "RAY_DEPLOY_MIN_FREE_STORAGE_MIB=bad\n");

  await assert.rejects(
    () => loadDeployStoragePreflightArgs(["--ray-env-file", envFile], {}),
    /RAY_DEPLOY_MIN_FREE_STORAGE_MIB must be a non-negative integer/,
  );
  await assert.rejects(
    () => loadDeployStoragePreflightArgs(["--ray-env-file", join(tempDir, "missing.env")], {}),
    /Env file not found:/,
  );

  if (process.getuid?.() !== 0) {
    await writeFile(envFile, "RAY_DEPLOY_MIN_FREE_STORAGE_MIB=1024\n");
    await chmod(envFile, 0o000);
    await assert.rejects(
      () => loadDeployStoragePreflightArgs(["--ray-env-file", envFile], {}),
      /Env file is not readable: .*Run this helper with privileges/,
    );
    await chmod(envFile, 0o600);
  }

  await writeFile(envFile, "RAY_MODEL_PATH=models/local.gguf\n");
  await assert.rejects(
    () => loadDeployStoragePreflightArgs(["--ray-env-file", envFile], {}),
    /RAY_MODEL_PATH must be absolute/,
  );

  await writeFile(envFile, 'RAY_MODEL_SOURCE_PATH=" models/source.gguf"\n');
  await assert.rejects(
    () => loadDeployStoragePreflightArgs(["--ray-env-file", envFile], {}),
    /RAY_MODEL_SOURCE_PATH must be a non-empty path without surrounding whitespace/,
  );
});

test("checkDeployStorageHeadroom rejects malformed direct options before probing", async () => {
  await assert.rejects(
    () => checkDeployStorageHeadroom(null as unknown as never),
    /deploy storage preflight options must be an object/,
  );
  await assert.rejects(
    () => checkDeployStorageHeadroom({ paths: null } as unknown as never),
    /paths must be an array when provided/,
  );
  await assert.rejects(
    () => checkDeployStorageHeadroom({ paths: [10] } as unknown as never),
    /paths\[0\] must be a string/,
  );
  await assert.rejects(
    () =>
      checkDeployStorageHeadroom({
        paths: Array.from({ length: 21 }, (_value, index) => `/srv/ray-${index}`),
      }),
    /at most 20 storage paths/,
  );
  await assert.rejects(
    () => checkDeployStorageHeadroom({ paths: ["/srv/ray"], minFreeStorageMiB: -1 }),
    /minFreeStorageMiB must be a non-negative integer/,
  );
  await assert.rejects(
    () => checkDeployStorageHeadroom({ paths: ["/srv/ray"], minFreeStorageMiB: 1.5 }),
    /minFreeStorageMiB must be a non-negative integer/,
  );
  await assert.rejects(
    () => checkDeployStorageHeadroom({ paths: ["/srv/ray"], minFreeStorageMiB: 1_048_577 }),
    /minFreeStorageMiB must be less than or equal to 1048576/,
  );
  await assert.rejects(
    () =>
      checkDeployStorageHeadroom({
        paths: ["/srv/ray"],
        stat: null,
      } as unknown as never),
    /stat must be a function when provided/,
  );
  await assert.rejects(
    () =>
      checkDeployStorageHeadroom({
        paths: ["/srv/ray"],
        statfs: null,
      } as unknown as never),
    /statfs must be a function when provided/,
  );
  await assert.rejects(
    () =>
      checkDeployStorageHeadroom({
        paths: ["/srv/ray"],
        realpath: null,
      } as unknown as never),
    /realpath must be a function when provided/,
  );
});

test("checkDeployStorageHeadroom reports nearest existing parent and Bun statfs layout", async () => {
  const existingPaths = new Set(["/srv", "/var/lib/ray", "/tmp"]);
  const summary = await checkDeployStorageHeadroom({
    paths: ["/srv/ray", "/var/lib/ray", "/tmp"],
    minFreeStorageMiB: 1_024,
    stat: (async (targetPath: string) => {
      if (!existingPaths.has(targetPath)) {
        throw missingPathError(targetPath);
      }

      return {} as Awaited<ReturnType<StatFn>>;
    }) as StatFn,
    statfs: (async (targetPath: string) => {
      if (targetPath === "/srv") {
        return {
          bsize: 1024 * 1024,
          bavail: 512,
        };
      }

      return {
        bsize: 0,
        blocks: 4096,
        ffree: 300_000,
      };
    }) as StatfsFn,
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.checks[0]?.path, "/srv/ray");
  assert.equal(summary.checks[0]?.checkPath, "/srv");
  assert.equal(summary.checks[0]?.availableMiB, 512);
  assert.equal(summary.checks[0]?.ok, false);
  assert.equal(summary.checks[1]?.ok, true);
  assert.match(formatTextSummary(summary), /LOW \/srv\/ray \(checked \/srv\): 512 MiB free/);
});

test("checkDeployStorageHeadroom reports resolved symlink storage targets", async () => {
  const summary = await checkDeployStorageHeadroom({
    paths: ["/srv/ray-models/local.gguf"],
    minFreeStorageMiB: 1_024,
    stat: (async (targetPath: string) => {
      if (targetPath !== "/srv/ray-models") {
        throw missingPathError(targetPath);
      }

      return {} as Awaited<ReturnType<StatFn>>;
    }) as StatFn,
    statfs: (async (targetPath: string) => {
      assert.equal(targetPath, "/srv/ray-models");
      return {
        bsize: 1024 * 1024,
        bavail: 4_096,
      };
    }) as StatfsFn,
    realpath: (async (targetPath: string) => {
      assert.equal(targetPath, "/srv/ray-models");
      return "/mnt/ray-models";
    }) as RealpathFn,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.checks[0]?.checkPath, "/srv/ray-models");
  assert.equal(summary.checks[0]?.checkRealPath, "/mnt/ray-models");
  assert.match(
    formatTextSummary(summary),
    /OK \/srv\/ray-models\/local\.gguf \(checked \/srv\/ray-models -> \/mnt\/ray-models\): 4096 MiB free/,
  );
});

test("runDeployStoragePreflightCli reports malformed thresholds", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDeployStoragePreflightCli(
    ["--path", "/srv/ray", "--min-free-mib", "1048577"],
    {
      stdout: {
        write: (message: string) => {
          stdout.push(message);
          return true;
        },
      },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
    },
    {},
  );

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /--min-free-mib must be less than or equal to/);
});

test("deploy storage preflight entrypoint guard does not run on import", async () => {
  const previousExitCode = process.exitCode;
  const imported = await import(`./deploy-storage-preflight.ts?entrypoint-test=${Date.now()}`);

  assert.equal(typeof imported.runDeployStoragePreflightCli, "function");
  assert.equal(process.exitCode, previousExitCode);
});

test("runDeployStoragePreflightCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(
    () => runDeployStoragePreflightCli([], null as unknown as never),
    /deploy storage preflight io must be an object/,
  );

  await assert.rejects(
    () =>
      runDeployStoragePreflightCli(["--help"], {
        stdout: {},
        stderr: {
          write() {
            return true;
          },
        },
      } as unknown as never),
    /deploy storage preflight io\.stdout\.write must be a function/,
  );

  await assert.rejects(
    () =>
      runDeployStoragePreflightCli(["--unknown"], {
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {},
      } as unknown as never),
    /deploy storage preflight io\.stderr\.write must be a function/,
  );
});

test("runDeployStoragePreflightCli reports malformed direct env before probing", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDeployStoragePreflightCli(
    [],
    {
      stdout: {
        write: (message: string) => {
          stdout.push(message);
          return true;
        },
      },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
    },
    null as unknown as NodeJS.ProcessEnv,
  );

  assert.equal(code, 1);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /deploy storage preflight env must be an object/);
});

test("runDeployStoragePreflightCli help documents env-file artifact storage paths", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runDeployStoragePreflightCli(
    ["--help"],
    {
      stdout: {
        write: (message: string) => {
          stdout.push(message);
          return true;
        },
      },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
    },
    {},
  );

  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Defaults to \//);
  assert.match(
    stdout.join(""),
    /model, llama\.cpp binary, async-queue, and artifact staging source paths/,
  );
  assert.match(stdout.join(""), /Relative source paths resolve from the current working directory/);
});
