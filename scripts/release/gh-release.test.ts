import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
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

async function writeExecutable(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

async function createReleaseHelperFixture(
  t: TestContext,
  options: { ghReleaseViewScript: string },
): Promise<{ binDir: string; logPath: string; scriptPath: string; tempDir: string }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-gh-release-helper-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const fixtureScriptPath = path.join(tempDir, "scripts", "release", "gh-release.sh");
  await mkdir(path.dirname(fixtureScriptPath), { recursive: true });
  await writeFile(fixtureScriptPath, await readFile(scriptPath, "utf8"), "utf8");

  const binDir = path.join(tempDir, "bin");
  const logPath = path.join(tempDir, "commands.log");

  await writeExecutable(
    path.join(binDir, "timeout"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$#" -lt 2 ]; then',
      '  echo "timeout stub requires a duration and command" >&2',
      "  exit 125",
      "fi",
      "shift",
      '"$@"',
      "",
    ].join("\n"),
  );

  await writeExecutable(
    path.join(binDir, "bun"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "bun %s\\n" "$*" >> "${RAY_TEST_LOG:?}"',
      'if [ "${1:-}" = "--print" ]; then',
      '  echo "1.2.3"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "./scripts/release/check-source.mjs" ] && [ "${2:-}" = "1.2.3" ]; then',
      "  exit 0",
      "fi",
      'echo "unexpected bun invocation: $*" >&2',
      "exit 98",
      "",
    ].join("\n"),
  );

  await writeExecutable(
    path.join(binDir, "git"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "git %s\\n" "$*" >> "${RAY_TEST_LOG:?}"',
      'if [ "${1:-}" = "status" ]; then',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "branch" ] && [ "${2:-}" = "--show-current" ]; then',
      '  echo "main"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "fetch" ]; then',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "HEAD" ]; then',
      '  echo "abcdef1234567890"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "origin/main" ]; then',
      '  echo "abcdef1234567890"',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "-q" ]; then',
      "  exit 1",
      "fi",
      'if [ "${1:-}" = "ls-remote" ]; then',
      "  exit 2",
      "fi",
      'if [ "${1:-}" = "push" ] && [ "${2:-}" != "--atomic" ]; then',
      '  echo "release tag push must be atomic" >&2',
      "  exit 97",
      "fi",
      'if [ "${1:-}" = "tag" ] || [ "${1:-}" = "push" ]; then',
      "  exit 0",
      "fi",
      'echo "unexpected git invocation: $*" >&2',
      "exit 98",
      "",
    ].join("\n"),
  );

  await writeExecutable(
    path.join(binDir, "gh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "gh %s\\n" "$*" >> "${RAY_TEST_LOG:?}"',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then',
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "release" ] && [ "${2:-}" = "view" ]; then',
      options.ghReleaseViewScript,
      "fi",
      'if [ "${1:-}" = "release" ] && [ "${2:-}" = "create" ]; then',
      "  exit 0",
      "fi",
      'echo "unexpected gh invocation: $*" >&2',
      "exit 98",
      "",
    ].join("\n"),
  );

  return { binDir, logPath, scriptPath: fixtureScriptPath, tempDir };
}

async function runFixtureReleaseHelper(fixture: {
  binDir: string;
  logPath: string;
  scriptPath: string;
  tempDir: string;
}): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const { stderr, stdout } = await execFileAsync("bash", [fixture.scriptPath, "--yes"], {
      cwd: fixture.tempDir,
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        RAY_TEST_LOG: fixture.logPath,
      },
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    });

    return { code: 0, stderr, stdout };
  } catch (error) {
    const result = error as { code?: number | string; stderr?: string; stdout?: string };
    return {
      code: typeof result.code === "number" ? result.code : 1,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  }
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
  assert.match(
    contents,
    /run_required_bounded "checking GitHub CLI authentication" 60 gh auth status/,
  );
  assert.match(contents, /remote_tag_exists "\$tag"/);
  assert.match(contents, /github_release_exists "\$tag"/);
  assert.match(contents, /bun \.\/scripts\/release\/check-source\.mjs "\$VER"/);
});

test("gh release helper bounds network release operations", async () => {
  const contents = await readFile(scriptPath, "utf8");

  assert.match(contents, /run_bounded\(\) \{/);
  assert.match(contents, /run_required_bounded\(\) \{/);
  assert.match(contents, /timeout "\$\{seconds\}s" "\$@"/);
  assert.match(contents, /return 124/);
  assert.match(contents, /git fetch --tags origin refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(contents, /run_bounded 60 git ls-remote --exit-code --tags origin/);
  assert.match(contents, /fail "could not check remote tag \$tag \(exit \$status\)"/);
  assert.match(contents, /run_bounded 60 gh release view "\$tag"/);
  assert.match(contents, /fail "timed out checking GitHub release: \$tag"/);
  assert.match(
    contents,
    /fail "could not check GitHub release \$tag \(exit \$status\): \$message"/,
  );
  assert.match(
    contents,
    /run_required_bounded "checking GitHub CLI authentication" 60 gh auth status/,
  );
  assert.match(
    contents,
    /run_required_bounded "pushing release tags atomically" 120 git push --atomic origin/,
  );
  assert.match(contents, /"creating GitHub release \$TAG_CORE"/);
  assert.match(contents, /"creating GitHub release \$TAG_SDK"/);
});

test("gh release helper aborts ambiguous GitHub release probe failures before tagging", async (t) => {
  const fixture = await createReleaseHelperFixture(t, {
    ghReleaseViewScript: ['  echo "api rate limit exceeded" >&2', "  exit 1"].join("\n"),
  });

  const result = await runFixtureReleaseHelper(fixture);

  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /could not check GitHub release core-v1\.2\.3 \(exit 1\): api rate limit exceeded/,
  );

  const commandLog = await readFile(fixture.logPath, "utf8");
  assert.match(commandLog, /^gh auth status$/m);
  assert.match(commandLog, /^gh release view core-v1\.2\.3$/m);
  assert.doesNotMatch(commandLog, /^git tag /m);
  assert.doesNotMatch(commandLog, /^git push /m);
  assert.doesNotMatch(commandLog, /^gh release create /m);
});

test("gh release helper continues when GitHub reports releases are missing", async (t) => {
  const fixture = await createReleaseHelperFixture(t, {
    ghReleaseViewScript: ['  echo "release not found" >&2', "  exit 1"].join("\n"),
  });

  const result = await runFixtureReleaseHelper(fixture);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /Done\. Actions publish to npm when each release is in published state\./,
  );

  const commandLog = await readFile(fixture.logPath, "utf8");
  assert.match(commandLog, /^gh auth status$/m);
  assert.match(commandLog, /^git tag -a core-v1\.2\.3 /m);
  assert.match(commandLog, /^git tag -a sdk-v1\.2\.3 /m);
  assert.match(commandLog, /^git push --atomic origin core-v1\.2\.3 sdk-v1\.2\.3$/m);
  assert.match(
    commandLog,
    /^gh release create core-v1\.2\.3 --generate-notes --title core-v1\.2\.3$/m,
  );
  assert.match(
    commandLog,
    /^gh release create sdk-v1\.2\.3 --generate-notes --title sdk-v1\.2\.3$/m,
  );
});
