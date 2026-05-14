import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  assertPackedPackageManifest,
  assertRequiredTarballEntries,
  buildPackCheckEnv,
  listTarballEntries,
  listPackDestinationFiles,
  parseArgs,
  readTarballJsonEntry,
  resolvePackedTarballs,
  runPack,
  runPackCheck,
  runPackCheckCli,
} from "./pack-check.mjs";

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function createTar(
  entries: Array<{ name: string; contents?: string; typeflag?: string; linkName?: string }>,
): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(" ", 148, 156);
    header.write(entry.typeflag ?? "0", 156, 1, "ascii");
    if (entry.linkName) {
      header.write(entry.linkName, 157, 100, "utf8");
    }
    header.write("ustar", 257, 5, "ascii");
    header.write("00", 263, 2, "ascii");

    let checksum = 0;
    for (const value of header) {
      checksum += value;
    }
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    blocks.push(contents);
    const remainder = contents.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
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

test("parseArgs accepts strict pack check options", () => {
  assert.deepEqual(parseArgs([]), { help: false });
  assert.deepEqual(parseArgs(["--"]), { help: false });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.deepEqual(parseArgs(["-h"]), { help: true });
});

test("parseArgs rejects malformed pack check argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /pack check argv must be an array/);
  assert.throws(
    () => parseArgs(["--help", 42] as unknown as string[]),
    /pack check argv\[1\] must be a string/,
  );
  assert.throws(
    () => parseArgs(Array.from({ length: 9 }, () => "--help")),
    /pack check argv must contain at most 8 entries/,
  );
  assert.throws(
    () => parseArgs(["--help\n"]),
    /pack check argv\[0\] must not contain control characters/,
  );
  assert.throws(
    () => parseArgs(["x".repeat(4_097)]),
    /pack check argv\[0\] must be at most 4096 bytes/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["dist"]), /Unexpected positional argument: dist/);
  assert.throws(() => parseArgs(["--", "dist"]), /Unexpected positional argument: dist/);
});

test("buildPackCheckEnv keeps pack child environments minimal", () => {
  const source = Object.create({
    PATH: "/inherited/bin",
    NODE_AUTH_TOKEN: "inherited-token",
  }) as NodeJS.ProcessEnv;
  source.PATH = "/usr/bin";
  source.LANG = "C.UTF-8";
  source.TMPDIR = "/tmp/ray";
  source.TEMP = "bad\0value";
  source.NODE_AUTH_TOKEN = "npm-token";
  source.NPM_TOKEN = "npm-token";
  source.RAY_API_KEYS = "client-secret";
  source.HOME = "/root";
  source.LD_PRELOAD = "/tmp/hook.so";

  const env = buildPackCheckEnv(source);

  assert.equal(Object.getPrototypeOf(env), null);
  assert.deepEqual(Object.keys(env).sort(), ["LANG", "PATH", "TMPDIR"]);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.TMPDIR, "/tmp/ray");
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.RAY_API_KEYS, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.TEMP, undefined);
});

test("runPack rejects malformed direct options before spawning", async () => {
  await assert.rejects(() => runPack(null as never), /packageConfig must be an object/);
  await assert.rejects(
    () => runPack({ name: "", cwd: "/tmp" } as never),
    /packageConfig\.name must be a non-empty string/,
  );
  await assert.rejects(
    () => runPack({ name: "@razroo/ray-core", cwd: " /tmp/ray" } as never),
    /packageConfig\.cwd must not contain surrounding whitespace/,
  );
  await assert.rejects(
    () => runPack({ name: "@razroo/ray-core", cwd: `/tmp/${"x".repeat(4096)}` } as never),
    /packageConfig\.cwd must be at most 4096 bytes/,
  );
  await assert.rejects(
    () => runPack({ name: "@razroo/ray-core", cwd: "/tmp/ray" }, null as never),
    /options must be an object/,
  );
  await assert.rejects(
    () => runPack({ name: "@razroo/ray-core", cwd: "/tmp/ray" }, { timeoutMs: 0 }),
    /timeoutMs must be a positive safe integer less than or equal to 120000/,
  );
  await assert.rejects(
    () => runPack({ name: "@razroo/ray-core", cwd: "/tmp/ray" }, { timeoutMs: Infinity }),
    /timeoutMs must be a positive safe integer less than or equal to 120000/,
  );
});

test("runPackCheck rejects malformed direct options before touching pack output", async () => {
  await assert.rejects(() => runPackCheck(null as never), /pack check options must be an object/);
  await assert.rejects(
    () => runPackCheck({ io: null } as never),
    /pack check io must be an object/,
  );
  await assert.rejects(
    () => runPackCheck({ io: { stdout: null, stderr: { write() {} } } } as never),
    /pack check io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runPackCheck({ io: { stdout: { write() {} }, stderr: null } } as never),
    /pack check io.stderr.write must be a function/,
  );
});

test("runPackCheckCli prints help to injected stdout", async () => {
  const output = createTestIo();

  const status = await runPackCheckCli(["--help"], output.io);

  assert.equal(status, 0);
  assert.match(output.stdout, /Usage: bun scripts\/release\/pack-check\.mjs \[--help\]/);
  assert.equal(output.stderr, "");
});

test("runPackCheckCli reports parser failures to injected stderr", async () => {
  const output = createTestIo();

  const status = await runPackCheckCli(["--unknown"], output.io);

  assert.equal(status, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /Unknown option: --unknown/);
});

test("runPackCheckCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(() => runPackCheckCli([], null as never), /pack check io must be an object/);
  await assert.rejects(
    () => runPackCheckCli([], { stdout: null, stderr: { write() {} } } as never),
    /pack check io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runPackCheckCli([], { stdout: { write() {} }, stderr: null } as never),
    /pack check io.stderr.write must be a function/,
  );
});

test("runPackCheckCli rejects malformed direct options before parsing", async () => {
  const output = createTestIo();

  await assert.rejects(
    () => runPackCheckCli(["--help"], output.io, null as never),
    /pack check cli options must be an object/,
  );
});

test("listTarballEntries reads bounded npm package entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(
    tarballPath,
    gzipSync(
      createTar([
        { name: "package/package.json", contents: "{}" },
        { name: "package/dist/index.js", contents: "export {};" },
      ]),
    ),
  );

  assert.deepEqual(await listTarballEntries(tarballPath), [
    "package/package.json",
    "package/dist/index.js",
  ]);
  assert.deepEqual(await readTarballJsonEntry(tarballPath, "package/package.json"), {});
});

test("listPackDestinationFiles streams bounded pack output directories", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-output-"));
  const originalReaddir = fsPromises.readdir;
  t.after(async () => {
    Object.defineProperty(fsPromises, "readdir", {
      configurable: true,
      value: originalReaddir,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  await writeFile(path.join(tempDir, "ray-sdk.tgz"), "");
  await writeFile(path.join(tempDir, "ray-core.tgz"), "");

  Object.defineProperty(fsPromises, "readdir", {
    configurable: true,
    value: async () => {
      throw new Error("readdir should not be used during pack output discovery");
    },
  });

  assert.deepEqual(await listPackDestinationFiles(tempDir), ["ray-core.tgz", "ray-sdk.tgz"]);

  await writeFile(path.join(tempDir, "extra.tgz"), "");
  await assert.rejects(
    () => listPackDestinationFiles(tempDir, 2),
    /Pack output directory must contain at most 2 files/,
  );

  await mkdir(path.join(tempDir, "nested"));
  await assert.rejects(
    () => listPackDestinationFiles(tempDir),
    /Pack output directory entries must be files: nested/,
  );
});

test("resolvePackedTarballs requires exact package output coverage", () => {
  const packageConfigs = [
    { name: "@razroo/ray-core", expectedFragment: "ray-core" },
    { name: "@razroo/ray-sdk", expectedFragment: "ray-sdk" },
  ];

  assert.deepEqual(
    Array.from(
      resolvePackedTarballs(
        ["razroo-ray-sdk-0.2.0.tgz", "razroo-ray-core-0.2.0.tgz"],
        packageConfigs,
      ),
    ),
    [
      ["@razroo/ray-core", "razroo-ray-core-0.2.0.tgz"],
      ["@razroo/ray-sdk", "razroo-ray-sdk-0.2.0.tgz"],
    ],
  );

  assert.throws(
    () => resolvePackedTarballs(["razroo-ray-core-0.2.0.tgz"], packageConfigs),
    /@razroo\/ray-sdk did not produce an npm tarball/,
  );

  assert.throws(
    () =>
      resolvePackedTarballs(
        ["razroo-ray-core-0.2.0.tgz", "extra-ray-core-0.2.0.tgz", "razroo-ray-sdk-0.2.0.tgz"],
        packageConfigs,
      ),
    /@razroo\/ray-core produced multiple npm tarballs/,
  );

  assert.throws(
    () =>
      resolvePackedTarballs(
        ["razroo-ray-core-0.2.0.tgz", "razroo-ray-sdk-0.2.0.tgz", "unexpected.tgz"],
        packageConfigs,
      ),
    /Pack output directory contains unexpected files: unexpected\.tgz/,
  );
});

test("listTarballEntries rejects oversized pack artifacts before reading", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-size-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(tarballPath, Buffer.alloc(128));

  await assert.rejects(
    () => listTarballEntries(tarballPath, { maxTarballBytes: 64 }),
    /Pack tarball must be at most 64 bytes/,
  );
});

test("listTarballEntries rejects pack artifacts that exceed the byte cap after stat", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-post-read-size-"));
  const originalOpen = fsPromises.open;
  t.after(async () => {
    Object.defineProperty(fsPromises, "open", {
      configurable: true,
      value: originalOpen,
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(tarballPath, Buffer.alloc(1));

  Object.defineProperty(fsPromises, "open", {
    configurable: true,
    value: async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== tarballPath) {
        return handle;
      }

      return {
        stat: async () => ({
          isFile: () => true,
          size: 1,
        }),
        readFile: async () => Buffer.alloc(65),
        close: async () => {
          await handle.close();
        },
      } as Awaited<ReturnType<typeof fsPromises.open>>;
    },
  });

  await assert.rejects(
    () => listTarballEntries(tarballPath, { maxTarballBytes: 64 }),
    /Pack tarball must be at most 64 bytes/,
  );
});

test("listTarballEntries rejects excessive tar entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-entries-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  await writeFile(
    tarballPath,
    gzipSync(
      createTar([{ name: "package/a.js" }, { name: "package/b.js" }, { name: "package/c.js" }]),
    ),
  );

  await assert.rejects(
    () => listTarballEntries(tarballPath, { maxEntries: 2 }),
    /Pack tarball must contain at most 2 entries/,
  );
});

test("listTarballEntries rejects unsafe tar entry paths", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-paths-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");

  for (const entryName of [
    "../package.json",
    "/package/package.json",
    "package/../package.json",
    "package\\package.json",
    "package/\npackage.json",
  ]) {
    await writeFile(tarballPath, gzipSync(createTar([{ name: entryName, contents: "{}" }])));

    await assert.rejects(
      () => listTarballEntries(tarballPath),
      /Pack tarball contains an unsafe entry path/,
    );
  }
});

test("listTarballEntries rejects corrupt tar headers", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-checksum-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");
  const tar = createTar([{ name: "package/package.json", contents: "{}" }]);
  tar[0] = "P".charCodeAt(0);
  await writeFile(tarballPath, gzipSync(tar));

  await assert.rejects(
    () => listTarballEntries(tarballPath),
    /Pack tarball contains an invalid header checksum/,
  );
});

test("listTarballEntries rejects unsafe tar entry types", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-pack-check-types-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const tarballPath = path.join(tempDir, "package.tgz");

  for (const entry of [
    { name: "package/external", typeflag: "1", linkName: "../outside" },
    { name: "package/external", typeflag: "2", linkName: "/etc/passwd" },
    { name: "package/null", typeflag: "3" },
  ]) {
    await writeFile(tarballPath, gzipSync(createTar([entry])));

    await assert.rejects(
      () => listTarballEntries(tarballPath),
      /Pack tarball contains an unsafe (hard link|symbolic link|device) entry/,
    );
  }
});

test("assertRequiredTarballEntries rejects missing publish-critical files", () => {
  assert.doesNotThrow(() =>
    assertRequiredTarballEntries(
      "@razroo/ray-core",
      [
        "package/package.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/src/index.ts",
        "package/CHANGELOG.md",
      ],
      [
        "package/package.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/src/index.ts",
        "package/CHANGELOG.md",
      ],
    ),
  );

  assert.throws(
    () =>
      assertRequiredTarballEntries(
        "@razroo/ray-sdk",
        ["package/package.json", "package/dist/index.js"],
        [
          "package/package.json",
          "package/dist/index.js",
          "package/dist/index.d.ts",
          "package/README.md",
        ],
      ),
    /@razroo\/ray-sdk package is missing required entries: package\/dist\/index\.d\.ts, package\/README\.md/,
  );
});

const safePackedManifestEntries = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/src/index.ts",
];

function safePackedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "@razroo/ray-sdk",
    version: "0.2.0",
    publishConfig: {
      access: "public",
    },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        development: "./src/index.ts",
        default: "./dist/index.js",
      },
    },
    dependencies: {
      "@razroo/ray-core": "0.2.0",
    },
    ...overrides,
  };
}

test("assertPackedPackageManifest accepts consumer-visible package metadata", () => {
  assert.doesNotThrow(() =>
    assertPackedPackageManifest("@razroo/ray-sdk", safePackedManifest(), safePackedManifestEntries),
  );
});

test("assertPackedPackageManifest rejects broken entry point targets", () => {
  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              development: "./src/missing.ts",
              default: "./dist/index.js",
            },
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json exports\["\."\]\.development points to missing entry package\/src\/missing\.ts/,
  );

  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          main: "../dist/index.js",
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json main must start with \.\//,
  );
});

test("assertPackedPackageManifest requires root export types", () => {
  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          exports: {
            ".": {
              development: "./src/index.ts",
              default: "./dist/index.js",
            },
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json exports\["\."\]\.types must match package\.json types/,
  );

  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          exports: {
            ".": "./dist/index.js",
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json exports\["\."\] must be an object/,
  );
});

test("assertPackedPackageManifest requires root export default", () => {
  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              development: "./src/index.ts",
              default: "./dist/other.js",
            },
          },
        }),
        [...safePackedManifestEntries, "package/dist/other.js"],
      ),
    /@razroo\/ray-sdk package\.json exports\["\."\]\.default must match package\.json main/,
  );
});

test("assertPackedPackageManifest rejects local-only dependencies and package scripts", () => {
  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          dependencies: {
            "@razroo/ray-core": "workspace:*",
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json dependencies\.@razroo\/ray-core must not publish local-only dependency spec workspace:\*/,
  );

  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          optionalDependencies: {
            "@razroo/ray-core": "../core",
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json optionalDependencies\.@razroo\/ray-core must not publish local-only dependency spec \.\.\/core/,
  );

  assert.throws(
    () =>
      assertPackedPackageManifest(
        "@razroo/ray-sdk",
        safePackedManifest({
          scripts: {
            postinstall: "node ./install.js",
          },
        }),
        safePackedManifestEntries,
      ),
    /@razroo\/ray-sdk package\.json must not publish scripts/,
  );
});
