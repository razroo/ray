/**
 * Post-publish smoke: confirm npm `latest` dist-tags match the expected version.
 * Same idea as geometra's scripts/release/verify-npm.mjs (narrowed to Ray packages).
 */
import { pathToFileURL } from "node:url";

export const VERIFY_NPM_TIMEOUT_MS = 15_000;
export const MAX_NPM_METADATA_BYTES = 1024 * 1024;
const MAX_VERIFY_NPM_ARGV = 8;
const MAX_VERIFY_NPM_ARG_BYTES = 4_096;
export const packages = ["@razroo/ray-core", "@razroo/ray-sdk"];
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return "Usage: bun scripts/release/verify-npm.mjs <version>";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertReleaseVersion(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(usage());
  }
  if (version !== version.trim() || !semverPattern.test(version)) {
    throw new Error(`npm verification version must be a valid SemVer string: ${version}`);
  }
}

function assertVerifyNpmArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new Error("npm verification argv must be an array");
  }

  if (argv.length > MAX_VERIFY_NPM_ARGV) {
    throw new Error(`npm verification argv must contain at most ${MAX_VERIFY_NPM_ARGV} entries`);
  }

  for (const [index, arg] of argv.entries()) {
    if (typeof arg !== "string") {
      throw new Error(`npm verification argv[${index}] must be a string`);
    }

    if (/[\0\r\n]/.test(arg)) {
      throw new Error(`npm verification argv[${index}] must not contain control characters`);
    }

    if (Buffer.byteLength(arg, "utf8") > MAX_VERIFY_NPM_ARG_BYTES) {
      throw new Error(
        `npm verification argv[${index}] must be at most ${MAX_VERIFY_NPM_ARG_BYTES} bytes`,
      );
    }
  }
}

function assertVerifyNpmCliIo(io) {
  if (!isRecord(io)) {
    throw new Error("npm verification io must be an object");
  }

  if (!isRecord(io.stdout) || typeof io.stdout.write !== "function") {
    throw new Error("npm verification io.stdout.write must be a function");
  }

  if (!isRecord(io.stderr) || typeof io.stderr.write !== "function") {
    throw new Error("npm verification io.stderr.write must be a function");
  }
}

function resolveRunVerifyNpmOptions(options) {
  if (!isRecord(options)) {
    throw new Error("npm verification options must be an object");
  }

  const io = Object.hasOwn(options, "io") ? options.io : process;
  assertVerifyNpmCliIo(io);
  return { io };
}

function assertRunVerifyNpmCliOptions(options) {
  if (!isRecord(options)) {
    throw new Error("npm verification cli options must be an object");
  }
}

function assertReleasePackageName(pkg) {
  if (typeof pkg !== "string" || pkg.length === 0) {
    throw new Error("npm verification package must be a non-empty package name");
  }

  if (/[\0-\x20\x7f]/.test(pkg)) {
    throw new Error("npm verification package must not contain control characters or whitespace");
  }

  if (!packages.includes(pkg)) {
    throw new Error(`npm verification package must be one of: ${packages.join(", ")}`);
  }
}

function parseContentLength(value) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  return /^\d+$/.test(normalized) && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isJsonContentType(value) {
  if (!value) {
    return false;
  }

  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function readPositiveBoundedIntegerOption(options, key, defaultValue) {
  const value = Object.hasOwn(options, key) ? options[key] : defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0 || value > defaultValue) {
    throw new Error(
      `npm verification ${key} must be a positive safe integer no greater than ${defaultValue}`,
    );
  }

  return value;
}

function resolveFetchNpmOptions(options) {
  if (!isRecord(options)) {
    throw new Error("npm verification options must be an object");
  }

  const fetchImpl = Object.hasOwn(options, "fetchImpl") ? options.fetchImpl : fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("npm verification fetchImpl must be a function");
  }

  return {
    fetchImpl,
    maxBytes: readPositiveBoundedIntegerOption(options, "maxBytes", MAX_NPM_METADATA_BYTES),
    timeoutMs: readPositiveBoundedIntegerOption(options, "timeoutMs", VERIFY_NPM_TIMEOUT_MS),
  };
}

function expectedTarballPathname(pkg, version) {
  return `/${pkg}/-/${pkg.split("/").pop()}-${version}.tgz`;
}

function decodeUrlPathname(url, pkg, version) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    throw new Error(`${pkg} npm metadata version ${version} has invalid tarball URL path`);
  }
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

export function parseArgs(argv) {
  assertVerifyNpmArgv(argv);
  const args = argv.filter((arg) => arg !== "--");

  if (args.length !== 1) {
    throw new Error(usage());
  }

  const version = args[0];
  assertReleaseVersion(version);

  return { version };
}

export async function fetchNpmMetadata(pkg, options = {}) {
  assertReleasePackageName(pkg);
  const { fetchImpl, maxBytes, timeoutMs } = resolveFetchNpmOptions(options);
  const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
    headers: {
      accept: "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch npm metadata for ${pkg}: ${res.status}`);
  }

  const contentType = res.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(
      `Failed to fetch npm metadata for ${pkg}: expected JSON response, got ${contentType ?? "missing content-type"}`,
    );
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
  assertReleasePackageName(pkg);
  assertReleaseVersion(version);
  const body = await fetchNpmMetadata(pkg, options);
  const published = body?.["dist-tags"]?.latest;
  if (published !== version) {
    throw new Error(`${pkg} latest=${published ?? "unknown"} expected=${version}`);
  }

  const versions = body?.versions;
  if (!isRecord(versions)) {
    throw new Error(`${pkg} npm metadata is missing versions`);
  }

  const packageVersion = versions[version];
  if (!isRecord(packageVersion)) {
    throw new Error(`${pkg} npm metadata is missing version ${version}`);
  }

  if (packageVersion.name !== pkg) {
    throw new Error(
      `${pkg} npm metadata version ${version} has name ${packageVersion.name ?? "unknown"}`,
    );
  }

  if (packageVersion.version !== version) {
    throw new Error(
      `${pkg} npm metadata version ${version} has package.json version ${
        packageVersion.version ?? "unknown"
      }`,
    );
  }

  const dist = packageVersion.dist;
  if (!isRecord(dist)) {
    throw new Error(`${pkg} npm metadata version ${version} is missing dist metadata`);
  }

  if (typeof dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(dist.integrity)) {
    throw new Error(`${pkg} npm metadata version ${version} is missing sha512 integrity`);
  }

  if (typeof dist.tarball !== "string") {
    throw new Error(`${pkg} npm metadata version ${version} is missing tarball URL`);
  }

  let tarballUrl;
  try {
    tarballUrl = new URL(dist.tarball);
  } catch {
    throw new Error(`${pkg} npm metadata version ${version} has invalid tarball URL`);
  }

  if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") {
    throw new Error(`${pkg} npm metadata version ${version} has unexpected tarball URL origin`);
  }
  if (tarballUrl.username || tarballUrl.password || tarballUrl.search || tarballUrl.hash) {
    throw new Error(`${pkg} npm metadata version ${version} has decorated tarball URL`);
  }

  const pathname = decodeUrlPathname(tarballUrl, pkg, version);
  if (pathname !== expectedTarballPathname(pkg, version)) {
    throw new Error(`${pkg} npm metadata version ${version} has unexpected tarball URL path`);
  }

  return published;
}

export async function runVerifyNpm(version, options = {}) {
  assertReleaseVersion(version);
  const { io } = resolveRunVerifyNpmOptions(options);

  for (const pkg of packages) {
    const published = await verifyPackageVersion(pkg, version, options);
    io.stdout.write(`${pkg}: ${published}\n`);
  }
}

export async function runVerifyNpmCli(argv = process.argv.slice(2), io = process, options = {}) {
  assertVerifyNpmCliIo(io);
  assertRunVerifyNpmCliOptions(options);

  try {
    const args = parseArgs(argv);
    await runVerifyNpm(args.version, { ...options, io });
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runVerifyNpmCli();
}
