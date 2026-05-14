import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const embeddableCliEntrypoints = [
  "apps/gateway/src/index.ts",
  "packages/deploy/src/cli.ts",
  "scripts/benchmark.ts",
  "scripts/deploy-storage-preflight.ts",
  "scripts/docs-link-check.ts",
  "scripts/package-runtime-coverage.ts",
  "scripts/test.mjs",
];

test("embeddable CLI entrypoints avoid abrupt process exits", async () => {
  for (const relativePath of embeddableCliEntrypoints) {
    const contents = await readFile(path.join(repoRoot, relativePath), "utf8");

    assert.doesNotMatch(contents, /\bprocess\.exit\s*\(/, relativePath);
    assert.match(contents, /\bprocess\.exitCode\s*=/, relativePath);
  }
});
