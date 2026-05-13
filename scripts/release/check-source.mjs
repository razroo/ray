import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
export const releasePackageManifests = ["packages/core/package.json", "packages/sdk/package.json"];

function usage() {
  return "Usage: bun ./scripts/release/check-source.mjs <version>";
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
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(usage());
  }

  const root = path.resolve(options.cwd ?? process.cwd());
  const manifests = options.manifests ?? releasePackageManifests;
  const checked = [];

  for (const manifest of manifests) {
    const packagePath = path.resolve(root, manifest);
    const pkg = await readPackageJsonBounded(packagePath);

    if (pkg.version !== version) {
      throw new Error(
        `${path.relative(root, packagePath)} version ${pkg.version ?? "unknown"} does not match release tag ${version}. Bump package.json, commit, and retag before publishing.`,
      );
    }

    validateNoFileDependencies(path.relative(root, packagePath), pkg);
    checked.push(`${pkg.name ?? path.relative(root, packagePath)}: ${pkg.version}`);
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
