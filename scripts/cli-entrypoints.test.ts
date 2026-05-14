import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const sourceRoots = ["apps", "packages", "scripts"] as const;
const sourceExtensions = new Set([".mjs", ".ts"]);
const cliEntrypointGuardPattern =
  /import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\)\.href/;

async function collectCheckedInSourceFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "--", ...sourceRoots], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });

  return stdout
    .split(/\r?\n/)
    .filter(
      (relativePath) =>
        sourceExtensions.has(path.extname(relativePath)) && !relativePath.endsWith(".test.ts"),
    )
    .sort((left, right) => left.localeCompare(right));
}

async function readRelativeSource(relativePath: string): Promise<string> {
  return await readFile(path.join(repoRoot, relativePath), "utf8");
}

test("checked-in non-test source files avoid abrupt process exits", async () => {
  const sourceFiles = await collectCheckedInSourceFiles();

  assert.ok(sourceFiles.length > 0);
  for (const relativePath of sourceFiles) {
    const contents = await readRelativeSource(relativePath);

    assert.doesNotMatch(contents, /\bprocess\.exit\s*\(/, relativePath);
  }
});

test("embeddable CLI entrypoints set process.exitCode", async () => {
  const entrypoints = [];

  for (const relativePath of await collectCheckedInSourceFiles()) {
    const contents = await readRelativeSource(relativePath);
    if (cliEntrypointGuardPattern.test(contents)) {
      entrypoints.push({ contents, relativePath });
    }
  }

  assert.ok(entrypoints.length >= 20);
  for (const { contents, relativePath } of entrypoints) {
    assert.match(contents, /\bprocess\.exitCode\s*=/, relativePath);
  }
});
