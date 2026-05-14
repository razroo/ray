import assert from "node:assert/strict";
import test from "node:test";
import { fetchNpmMetadata, verifyPackageVersion } from "./verify-npm.mjs";

test("verifyPackageVersion accepts bounded npm metadata", async () => {
  let requestedRedirect: RequestRedirect | undefined;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    requestedRedirect = init?.redirect;
    return new Response(JSON.stringify({ "dist-tags": { latest: "0.2.0" } }), {
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
