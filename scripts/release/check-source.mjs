import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
export const releasePackageManifests = ["packages/core/package.json", "packages/sdk/package.json"];
export const releasePackageNames = {
  "packages/core/package.json": "@razroo/ray-core",
  "packages/sdk/package.json": "@razroo/ray-sdk",
};
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return "Usage: bun ./scripts/release/check-source.mjs <version>";
}

function normalizeManifestPath(manifest) {
  return manifest.replaceAll("\\", "/");
}

function validateReleaseVersion(version) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(usage());
  }
  if (version !== version.trim() || !semverPattern.test(version)) {
    throw new Error(`release version must be a valid SemVer string without whitespace: ${version}`);
  }
}

async function readPackageJsonBounded(packagePath) {
  const stats = await stat(packagePath);
  if (!stats.isFile()) {
    throw new Error(`package.json path must be a file: ${packagePath}`);
  }
  if (stats.size > MAX_PACKAGE_JSON_BYTES) {
    throw new Error(`package.json must be at most ${MAX_PACKAGE_JSON_BYTES} bytes: ${packagePath}`);
  }

  const raw = await readFile(packagePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_PACKAGE_JSON_BYTES) {
    throw new Error(`package.json must be at most ${MAX_PACKAGE_JSON_BYTES} bytes: ${packagePath}`);
  }

  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`package.json must contain an object: ${packagePath}`);
  }

  return parsed;
}

function validateNoFileDependencies(packagePath, pkg) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = pkg[section];
    if (deps === undefined) {
      continue;
    }
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      throw new Error(`${section} must be an object in ${packagePath}`);
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("file:")) {
        throw new Error(
          `${section}["${name}"] is "${spec}" in ${packagePath}; file: dependencies are published verbatim and break consumers.`,
        );
      }
    }
  }
}

export async function checkReleaseSource(version, options = {}) {
  validateReleaseVersion(version);

  const root = path.resolve(options.cwd ?? process.cwd());
  const manifests = options.manifests ?? releasePackageManifests;
  const checked = [];

  for (const manifest of manifests) {
    const packagePath = path.resolve(root, manifest);
    const relativePackagePath = path.relative(root, packagePath);
    const manifestKey = normalizeManifestPath(relativePackagePath);
    const pkg = await readPackageJsonBounded(packagePath);
    const expectedName = releasePackageNames[manifestKey];

    if (expectedName !== undefined && pkg.name !== expectedName) {
      throw new Error(
        `${manifestKey} must be named ${expectedName} before publishing; found ${typeof pkg.name === "string" ? pkg.name : "unknown"}.`,
      );
    }

    if (typeof pkg.version !== "string" || !semverPattern.test(pkg.version)) {
      throw new Error(`${manifestKey} version must be a valid SemVer string before publishing.`);
    }

    if (pkg.version !== version) {
      throw new Error(
        `${manifestKey} version ${pkg.version} does not match release tag ${version}. Bump package.json, commit, and retag before publishing.`,
      );
    }

    validateNoFileDependencies(manifestKey, pkg);
    checked.push(`${pkg.name}: ${pkg.version}`);
  }

  return checked;
}

export async function runCheckSource(argv = process.argv.slice(2), options = {}) {
  const args = argv.filter((arg) => arg !== "--");
  const version = args[0];
  const checked = await checkReleaseSource(version, options);
  for (const line of checked) {
    console.log(line);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCheckSource().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
