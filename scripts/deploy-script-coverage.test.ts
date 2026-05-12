import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectPublicConfigPaths } from "./deploy-smoke.ts";
import {
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
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("validateDeployScriptCoverage accepts every checked-in public deploy profile", async () => {
  const cwd = process.cwd();
  const configPaths = await collectPublicConfigPaths(cwd, "examples/config");
  const summary = validateDeployScriptCoverage({
    cwd,
    configPaths,
    scripts: await loadPackageScripts(),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.configCount, 7);
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
  assert.match(formatTextSummary(cwd, summary), /Summary: errors=0/);
});

test("validateDeployScriptCoverage catches missing and mistargeted package aliases", async () => {
  const cwd = process.cwd();
  const configPaths = await collectPublicConfigPaths(cwd, "examples/config");
  const scripts = await loadPackageScripts();
  delete scripts["doctor:1b:generic"];
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
  assert.equal(parsed.configCount, 7);
});
