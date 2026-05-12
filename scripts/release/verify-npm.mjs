/**
 * Post-publish smoke: confirm npm `latest` dist-tags match the expected version.
 * Same idea as geometra's scripts/release/verify-npm.mjs (narrowed to Ray packages).
 */
import { pathToFileURL } from "node:url";

export const VERIFY_NPM_TIMEOUT_MS = 15_000;
export const MAX_NPM_METADATA_BYTES = 1024 * 1024;
export const packages = ["@razroo/ray-core", "@razroo/ray-sdk"];

function parseContentLength(value) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  return /^\d+$/.test(normalized) && Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readResponseTextWithinLimit(response, limitBytes, label) {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > limitBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} exceeded ${limitBytes} bytes`);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded ${limitBytes} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes,
  ).toString("utf8");
}

export async function fetchNpmMetadata(pkg, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VERIFY_NPM_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_NPM_METADATA_BYTES;
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: {
      accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch npm metadata for ${pkg}: ${res.status}`);
  }

  const raw = await readResponseTextWithinLimit(res, maxBytes, `${pkg} npm metadata`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse npm metadata for ${pkg}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function verifyPackageVersion(pkg, version, options = {}) {
  const body = await fetchNpmMetadata(pkg, options);
  const published = body?.["dist-tags"]?.latest;
  if (published !== version) {
    throw new Error(`${pkg} latest=${published ?? "unknown"} expected=${version}`);
  }
  return published;
}

export async function runVerifyNpm(version, options = {}) {
  for (const pkg of packages) {
    const published = await verifyPackageVersion(pkg, version, options);
    console.log(`${pkg}: ${published}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];

  if (!version) {
    console.error("Usage: bun scripts/release/verify-npm.mjs <version>");
    process.exit(1);
  }

  runVerifyNpm(version).catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
