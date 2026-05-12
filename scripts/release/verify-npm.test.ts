import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmMetadata, verifyPackageVersion } from "./verify-npm.mjs";

test("verifyPackageVersion accepts bounded npm metadata", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ "dist-tags": { latest: "0.2.0" } }), {
      headers: {
        "content-type": "application/json",
      },
    });

  assert.equal(
    await verifyPackageVersion("@razroo/ray-core", "0.2.0", {
      fetchImpl,
    }),
    "0.2.0",
  );
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

test("verifyPackageVersion rejects npm latest mismatches", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ "dist-tags": { latest: "0.1.0" } }), {
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
