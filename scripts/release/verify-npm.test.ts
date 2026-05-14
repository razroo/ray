import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmMetadata, verifyPackageVersion } from "./verify-npm.mjs";

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
