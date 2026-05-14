import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NPM_METADATA_BYTES,
  fetchNpmMetadata,
  parseArgs,
  runVerifyNpm,
  runVerifyNpmCli,
  verifyPackageVersion,
} from "./verify-npm.mjs";

function metadata(pkg: string, version: string): string {
  return JSON.stringify({
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name: pkg,
        version,
        dist: {
          integrity: "sha512-AbCdEf0123456789+/==",
          tarball: `https://registry.npmjs.org/${encodeURIComponent(pkg)}/-/${pkg.split("/").pop()}-${version}.tgz`,
        },
      },
    },
  });
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

function createPackageMetadataFetch(version: string) {
  return async (url: string | URL | Request) => {
    const requestUrl = url instanceof Request ? url.url : String(url);
    const pkg = decodeURIComponent(new URL(requestUrl).pathname.slice(1));

    return new Response(metadata(pkg, version), {
      headers: {
        "content-type": "application/json",
      },
    });
  };
}

test("parseArgs accepts strict npm verification options", () => {
  assert.deepEqual(parseArgs(["--", "0.2.0"]), { version: "0.2.0" });
  assert.deepEqual(parseArgs(["1.2.3-beta.1"]), { version: "1.2.3-beta.1" });
});

test("parseArgs rejects malformed npm verification argv", () => {
  assert.throws(
    () => parseArgs(null as unknown as string[]),
    /npm verification argv must be an array/,
  );
  assert.throws(
    () => parseArgs(["0.2.0", 42] as unknown as string[]),
    /npm verification argv\[1\] must be a string/,
  );
  assert.throws(
    () => parseArgs(Array.from({ length: 9 }, () => "0.2.0")),
    /npm verification argv must contain at most 8 entries/,
  );
  assert.throws(
    () => parseArgs([`0.2.0${"\n"}`]),
    /npm verification argv\[0\] must not contain control characters/,
  );
  assert.throws(
    () => parseArgs(["x".repeat(4_097)]),
    /npm verification argv\[0\] must be at most 4096 bytes/,
  );
  assert.throws(() => parseArgs([]), /Usage: bun scripts\/release\/verify-npm\.mjs <version>/);
  assert.throws(
    () => parseArgs(["0.2.0", "extra"]),
    /Usage: bun scripts\/release\/verify-npm\.mjs <version>/,
  );
  assert.throws(
    () => parseArgs(["latest"]),
    /npm verification version must be a valid SemVer string/,
  );
});

test("verifyPackageVersion accepts bounded npm metadata", async () => {
  let requestedRedirect: RequestRedirect | undefined;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    requestedRedirect = init?.redirect;
    return new Response(metadata("@razroo/ray-core", "0.2.0"), {
      headers: {
        "content-type": "application/json",
      },
    });
  };

  assert.equal(
    await verifyPackageVersion("@razroo/ray-core", "0.2.0", {
      fetchImpl,
    }),
    "0.2.0",
  );
  assert.equal(requestedRedirect, "manual");
});

test("fetchNpmMetadata rejects oversized declared metadata", async () => {
  const fetchImpl = async () =>
    new Response("{}", {
      headers: {
        "content-length": "65",
        "content-type": "application/json",
      },
    });

  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
        maxBytes: 64,
      }),
    /@razroo\/ray-core npm metadata exceeded 64 bytes/,
  );
});

test("runVerifyNpm writes checked packages to injected stdout", async () => {
  const output = createTestIo();

  await runVerifyNpm("0.2.0", {
    fetchImpl: createPackageMetadataFetch("0.2.0"),
    io: output.io,
  });

  assert.equal(output.stdout, "@razroo/ray-core: 0.2.0\n@razroo/ray-sdk: 0.2.0\n");
  assert.equal(output.stderr, "");
});

test("runVerifyNpm rejects malformed direct io before fetching", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response(metadata("@razroo/ray-core", "0.2.0"));
  };

  await assert.rejects(
    () => runVerifyNpm("0.2.0", { fetchImpl, io: null }),
    /npm verification io must be an object/,
  );
  await assert.rejects(
    () => runVerifyNpm("0.2.0", { fetchImpl, io: { stdout: null, stderr: { write() {} } } }),
    /npm verification io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runVerifyNpm("0.2.0", { fetchImpl, io: { stdout: { write() {} }, stderr: null } }),
    /npm verification io.stderr.write must be a function/,
  );

  assert.equal(fetchCount, 0);
});

test("runVerifyNpmCli reports npm verification failures to injected stderr", async () => {
  const output = createTestIo();

  const status = await runVerifyNpmCli(["latest"], output.io, {
    fetchImpl: createPackageMetadataFetch("0.2.0"),
  });

  assert.equal(status, 1);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /npm verification version must be a valid SemVer string/);
});

test("runVerifyNpmCli verifies packages with injected dependencies", async () => {
  const output = createTestIo();

  const status = await runVerifyNpmCli(["0.2.0"], output.io, {
    fetchImpl: createPackageMetadataFetch("0.2.0"),
  });

  assert.equal(status, 0);
  assert.equal(output.stdout, "@razroo/ray-core: 0.2.0\n@razroo/ray-sdk: 0.2.0\n");
  assert.equal(output.stderr, "");
});

test("runVerifyNpmCli rejects malformed direct io and options before parsing", async () => {
  const output = createTestIo();

  await assert.rejects(
    () => runVerifyNpmCli(["0.2.0"], null),
    /npm verification io must be an object/,
  );
  await assert.rejects(
    () => runVerifyNpmCli(["0.2.0"], { stdout: null, stderr: { write() {} } }),
    /npm verification io.stdout.write must be a function/,
  );
  await assert.rejects(
    () => runVerifyNpmCli(["0.2.0"], { stdout: { write() {} }, stderr: null }),
    /npm verification io.stderr.write must be a function/,
  );
  await assert.rejects(
    () => runVerifyNpmCli(["0.2.0"], output.io, null),
    /npm verification cli options must be an object/,
  );
});

test("fetchNpmMetadata rejects invalid options before fetching", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response(metadata("@razroo/ray-core", "0.2.0"), {
      headers: {
        "content-type": "application/json",
      },
    });
  };

  await assert.rejects(
    () => fetchNpmMetadata("@razroo/ray-core", null),
    /npm verification options must be an object/,
  );
  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl: "fetch",
      }),
    /npm verification fetchImpl must be a function/,
  );
  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
        timeoutMs: 0,
      }),
    /npm verification timeoutMs must be a positive safe integer no greater than 15000/,
  );
  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
        timeoutMs: Infinity,
      }),
    /npm verification timeoutMs must be a positive safe integer no greater than 15000/,
  );
  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
        maxBytes: 0,
      }),
    /npm verification maxBytes must be a positive safe integer no greater than 1048576/,
  );
  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
        maxBytes: MAX_NPM_METADATA_BYTES + 1,
      }),
    /npm verification maxBytes must be a positive safe integer no greater than 1048576/,
  );

  assert.equal(fetchCount, 0);
});

test("fetchNpmMetadata rejects redirected registry metadata", async () => {
  const fetchImpl = async () =>
    new Response("", {
      status: 302,
      headers: {
        location: "https://registry.example.invalid/@razroo/ray-core",
      },
    });

  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
      }),
    /Failed to fetch npm metadata for @razroo\/ray-core: 302/,
  );
});

test("fetchNpmMetadata rejects non-JSON registry metadata", async () => {
  const fetchImpl = async () =>
    new Response("<html></html>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });

  await assert.rejects(
    () =>
      fetchNpmMetadata("@razroo/ray-core", {
        fetchImpl,
      }),
    /expected JSON response, got text\/html; charset=utf-8/,
  );
});

test("verifyPackageVersion rejects npm latest mismatches", async () => {
  const fetchImpl = async () =>
    new Response(metadata("@razroo/ray-sdk", "0.1.0"), {
      headers: {
        "content-type": "application/json",
      },
    });

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-sdk", "0.2.0", {
        fetchImpl,
      }),
    /@razroo\/ray-sdk latest=0\.1\.0 expected=0\.2\.0/,
  );
});

test("verifyPackageVersion rejects malformed version arguments", async () => {
  const fetchImpl = async () => new Response(metadata("@razroo/ray-core", "0.2.0"));

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "latest", {
        fetchImpl,
      }),
    /npm verification version must be a valid SemVer string/,
  );
});

test("verifyPackageVersion rejects package names outside the release allowlist", async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return new Response(metadata("@razroo/ray-core", "0.2.0"));
  };

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-plugin", "0.2.0", {
        fetchImpl,
      }),
    /npm verification package must be one of: @razroo\/ray-core, @razroo\/ray-sdk/,
  );
  assert.equal(fetched, false);
});

test("verifyPackageVersion requires matching npm version metadata", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        "dist-tags": { latest: "0.2.0" },
        versions: {
          "0.2.0": {
            name: "@razroo/ray-core-copy",
            version: "0.2.0",
            dist: {
              integrity: "sha512-AbCdEf0123456789+/==",
              tarball: "https://registry.npmjs.org/%40razroo%2Fray-core/-/ray-core-0.2.0.tgz",
            },
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "0.2.0", {
        fetchImpl,
      }),
    /@razroo\/ray-core npm metadata version 0\.2\.0 has name @razroo\/ray-core-copy/,
  );
});

test("verifyPackageVersion requires npm dist integrity and exact registry tarball", async () => {
  const invalidIntegrity = async () =>
    new Response(
      JSON.stringify({
        "dist-tags": { latest: "0.2.0" },
        versions: {
          "0.2.0": {
            name: "@razroo/ray-core",
            version: "0.2.0",
            dist: {
              integrity: "sha1-deadbeef",
              tarball: "https://registry.npmjs.org/%40razroo%2Fray-core/-/ray-core-0.2.0.tgz",
            },
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "0.2.0", {
        fetchImpl: invalidIntegrity,
      }),
    /@razroo\/ray-core npm metadata version 0\.2\.0 is missing sha512 integrity/,
  );

  const invalidTarball = async () =>
    new Response(
      JSON.stringify({
        "dist-tags": { latest: "0.2.0" },
        versions: {
          "0.2.0": {
            name: "@razroo/ray-core",
            version: "0.2.0",
            dist: {
              integrity: "sha512-AbCdEf0123456789+/==",
              tarball: "https://registry.example.invalid/%40razroo%2Fray-core.tgz",
            },
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "0.2.0", {
        fetchImpl: invalidTarball,
      }),
    /@razroo\/ray-core npm metadata version 0\.2\.0 has unexpected tarball URL origin/,
  );

  const wrongTarballPath = async () =>
    new Response(
      JSON.stringify({
        "dist-tags": { latest: "0.2.0" },
        versions: {
          "0.2.0": {
            name: "@razroo/ray-core",
            version: "0.2.0",
            dist: {
              integrity: "sha512-AbCdEf0123456789+/==",
              tarball: "https://registry.npmjs.org/%40razroo%2Fray-sdk/-/ray-sdk-0.2.0.tgz",
            },
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "0.2.0", {
        fetchImpl: wrongTarballPath,
      }),
    /@razroo\/ray-core npm metadata version 0\.2\.0 has unexpected tarball URL path/,
  );

  const decoratedTarball = async () =>
    new Response(
      JSON.stringify({
        "dist-tags": { latest: "0.2.0" },
        versions: {
          "0.2.0": {
            name: "@razroo/ray-core",
            version: "0.2.0",
            dist: {
              integrity: "sha512-AbCdEf0123456789+/==",
              tarball:
                "https://publisher:token@registry.npmjs.org/%40razroo%2Fray-core/-/ray-core-0.2.0.tgz?download=1#sha512",
            },
          },
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    );

  await assert.rejects(
    () =>
      verifyPackageVersion("@razroo/ray-core", "0.2.0", {
        fetchImpl: decoratedTarball,
      }),
    /@razroo\/ray-core npm metadata version 0\.2\.0 has decorated tarball URL/,
  );
});
