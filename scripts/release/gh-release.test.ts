import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts", "release", "gh-release.sh");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readCurrentVersion(): Promise<string> {
  const raw = await readFile(path.join(repoRoot, "packages", "core", "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

test("gh release helper validates syntax and dry-runs without mutating git state", async () => {
  const version = await readCurrentVersion();
  const escapedVersion = escapeRegExp(version);

  await execFileAsync("bash", ["-n", scriptPath], {
    cwd: repoRoot,
    timeout: 5_000,
  });

  const { stdout } = await execFileAsync("bash", [scriptPath, "--dry-run"], {
    cwd: repoRoot,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });

  assert.match(stdout, new RegExp(`Version:\\s+${escapedVersion}`));
  assert.match(stdout, new RegExp(`Tags:\\s+core-v${escapedVersion}\\s+sdk-v${escapedVersion}`));
  assert.match(stdout, /\[dry-run\] ok/);
});

test("gh release helper gates destructive releases on clean synced main", async () => {
  const contents = await readFile(scriptPath, "utf8");

  assert.match(contents, /git status --porcelain --untracked-files=normal/);
  assert.match(contents, /git branch --show-current/);
  assert.match(contents, /refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(contents, /git rev-parse HEAD/);
  assert.match(contents, /git rev-parse origin\/main/);
  assert.match(contents, /git ls-remote --exit-code --tags origin/);
  assert.match(contents, /gh release view "\$tag"/);
  assert.match(contents, /gh auth status/);
  assert.match(contents, /bun \.\/scripts\/release\/check-source\.mjs "\$VER"/);
});
