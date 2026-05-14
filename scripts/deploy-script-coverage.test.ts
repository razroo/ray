import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectDeployScriptConfigPaths,
  formatTextSummary,
  parseArgs,
  runDeployScriptCoverageCli,
  validateDeployScriptCoverage,
} from "./deploy-script-coverage.ts";

async function loadPackageScripts(): Promise<Record<string, string>> {
  const parsed = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  return parsed.scripts;
}

test("parseArgs accepts strict deploy script coverage options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config-dir",
    "examples/config",
    "--package-json",
    "package.json",
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configDir, "examples/config");
  assert.equal(args.packageJson, "package.json");
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed deploy script coverage argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(
    () => parseArgs(["--cwd", " /srv/ray"]),
    /--cwd must be a path without surrounding whitespace/,
  );
  assert.throws(
    () => parseArgs(["--config-dir", "examples/config\n"]),
    /--config-dir must not contain control characters/,
  );
  assert.throws(
    () => parseArgs(["--package-json", " package.json"]),
    /--package-json must be a path without surrounding whitespace/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("validateDeployScriptCoverage accepts every checked-in public deploy profile", async () => {
  const cwd = process.cwd();
  const configPaths = await collectDeployScriptConfigPaths(cwd, "examples/config");
  const summary = validateDeployScriptCoverage({
    cwd,
    configPaths,
    scripts: await loadPackageScripts(),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.configCount, 9);
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.hetzner-cx23-qwen0.6b.public.json") &&
        result.renderScript === "render:service:hetzner-email-ai" &&
        result.validateScript === "validate:config:hetzner:public" &&
        result.doctorScript === "doctor:hetzner-email-ai" &&
        result.modelStageScript === "model:stage:hetzner-email-ai",
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.vps.json") &&
        result.renderScript === "render:service:vps" &&
        result.validateScript === "validate:config:vps" &&
        result.doctorScript === "doctor:vps" &&
        result.modelStageScript === undefined,
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.balanced.json") &&
        result.renderScript === "render:service:balanced" &&
        result.validateScript === "validate:config:balanced" &&
        result.doctorScript === "doctor:balanced" &&
        result.modelStageScript === undefined,
    ),
  );
  assert.match(formatTextSummary(cwd, summary), /Summary: errors=0/);
});

test("validateDeployScriptCoverage rejects excessive config inputs before matching scripts", async () => {
  assert.throws(
    () =>
      validateDeployScriptCoverage({
        cwd: process.cwd(),
        configPaths: Array.from(
          { length: 131 },
          (_value, index) => `/tmp/ray-deploy-script-${index}.json`,
        ),
        scripts: {},
      }),
    /at most 130 config files/,
  );
});

test("validateDeployScriptCoverage rejects malformed direct paths before matching scripts", () => {
  assert.throws(
    () =>
      validateDeployScriptCoverage({
        cwd: " /srv/ray",
        configPaths: [],
        scripts: {},
      }),
    /cwd must be a path without surrounding whitespace/,
  );
  assert.throws(
    () =>
      validateDeployScriptCoverage({
        cwd: process.cwd(),
        configPaths: ["examples/config/ray.sub1b.public.json\n"],
        scripts: {},
      }),
    /configPaths\[0\] must not contain control characters/,
  );
  assert.throws(
    () =>
      validateDeployScriptCoverage({
        cwd: process.cwd(),
        configPaths: [`/${"a".repeat(4096)}`],
        scripts: {},
      }),
    /configPaths\[0\] must be at most 4096 bytes/,
  );
});

test("validateDeployScriptCoverage catches missing and mistargeted package aliases", async () => {
  const cwd = process.cwd();
  const configPaths = await collectDeployScriptConfigPaths(cwd, "examples/config");
  const scripts = await loadPackageScripts();
  delete scripts["doctor:1b:generic"];
  delete scripts["doctor:vps"];
  scripts["validate:config:1b:8gb:generic:public"] =
    "bun ./packages/deploy/dist/cli.js validate --cwd . --config ./examples/config/ray.1b.public.json";
  scripts["model:stage:hetzner-email-ai"] =
    "bun ./scripts/model-stage.ts --config ./examples/config/ray.sub1b.public.json";

  const summary = validateDeployScriptCoverage({ cwd, configPaths, scripts });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "script_missing"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "script_wrong_config"));
});

test("runDeployScriptCoverageCli prints JSON output", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runDeployScriptCoverageCli(["--json"], {
    stdout: { write: (chunk: string) => (stdout += chunk) } as NodeJS.WriteStream,
    stderr: { write: (chunk: string) => (stderr += chunk) } as NodeJS.WriteStream,
  });

  assert.equal(code, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { ok: boolean; configCount: number };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.configCount, 9);
});

test("runDeployScriptCoverageCli rejects oversized package manifests", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-deploy-script-coverage-size-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const packageJsonPath = path.join(tempDir, "package.json");
  await writeFile(packageJsonPath, "x".repeat(512 * 1024 + 1));

  let stdout = "";
  let stderr = "";
  const code = await runDeployScriptCoverageCli(["--package-json", packageJsonPath], {
    stdout: { write: (chunk: string) => (stdout += chunk) } as NodeJS.WriteStream,
    stderr: { write: (chunk: string) => (stderr += chunk) } as NodeJS.WriteStream,
  });

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /package\.json must be at most 524288 bytes/);
});
