import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDeployStorageHeadroom,
  formatTextSummary,
  parseArgs,
  runDeployStoragePreflightCli,
} from "./deploy-storage-preflight.ts";

type StatFn = typeof import("node:fs/promises").stat;
type StatfsFn = typeof import("node:fs/promises").statfs;

function missingPathError(path: string): NodeJS.ErrnoException {
  const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

test("parseArgs accepts deploy storage preflight options", () => {
  assert.deepEqual(parseArgs([], {}).paths, ["/srv/ray", "/var/lib/ray", "/tmp"]);
  assert.equal(parseArgs([], { RAY_DEPLOY_MIN_FREE_STORAGE_MIB: "2048" }).minFreeStorageMiB, 2048);
  assert.deepEqual(parseArgs(["--path", "/srv/ray", "--path", "/var/lib/ray"]).paths, [
    "/srv/ray",
    "/var/lib/ray",
  ]);
  assert.equal(parseArgs(["--min-free-mib", "0", "--json"]).minFreeStorageMiB, 0);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs rejects malformed deploy storage preflight options", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(() => parseArgs(["--path"]), /--path requires a value/);
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
