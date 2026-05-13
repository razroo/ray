import assert from "node:assert/strict";
import test from "node:test";
import { collectPublicConfigPaths } from "./deploy-smoke.ts";
import {
  formatTextSummary,
  parseArgs,
  runModelStageSmokeCli,
  smokeModelStages,
} from "./model-stage-smoke.ts";

test("parseArgs accepts strict model stage smoke options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config-dir",
    "examples/config",
    "--user",
    "ray",
    "--group",
    "rayops",
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configDir, "examples/config");
  assert.equal(args.serviceUser, "ray");
  assert.equal(args.serviceGroup, "rayops");
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed model stage smoke argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--config-dir", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--config-dir"]), /--config-dir requires a value/);
  assert.throws(() => parseArgs(["--user", "ray user"]), /system account name/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("smokeModelStages rejects excessive config inputs before rendering", async () => {
  await assert.rejects(
    () =>
      smokeModelStages({
        cwd: process.cwd(),
        configPaths: Array.from(
          { length: 129 },
          (_value, index) => `/tmp/ray-${index}.public.json`,
        ),
        serviceUser: "ray",
      }),
    /at most 128 config files/,
  );
});

test("smokeModelStages renders every checked-in public staging plan", async () => {
  const cwd = process.cwd();
  const configPaths = await collectPublicConfigPaths(cwd, "examples/config");
  const summary = await smokeModelStages({
    cwd,
    configPaths,
    serviceUser: "ray",
    serviceGroup: "ray",
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.configCount >= 7);
  assert.equal(summary.stagedCount, summary.configCount);
  assert.ok(
    summary.results.every(
      (result) =>
        result.errorCount === 0 &&
        result.commandCount >= 8 &&
        result.modelPath?.startsWith("/var/lib/ray/models/") &&
        result.binaryPath === "/usr/local/bin/llama-server" &&
        result.memoryBudgetMiB !== undefined &&
        result.safeMemoryBudgetMiB !== undefined &&
        result.nonModelWorkingSetMiB !== undefined,
    ),
  );
  assert.ok(
    summary.results.every((result) =>
      result.configPath.includes("8gb")
        ? result.memoryBudgetMiB === 8_192
        : result.memoryBudgetMiB === 4_096,
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.sub1b.cax11.public.json") &&
        result.profile === "sub1b-cax11" &&
        result.modelId === "qwen2.5-0.5b-instruct-q4_k_m",
    ),
  );
  const text = formatTextSummary(cwd, summary);
  assert.match(text, /memory=4096MiB safe=\d+MiB nonModel=\d+MiB/);
  assert.match(text, /memory=8192MiB safe=\d+MiB nonModel=\d+MiB/);
  assert.match(text, /Summary: staged=\d+ errors=0/);
});

test("runModelStageSmokeCli prints JSON summary", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runModelStageSmokeCli(["--cwd", process.cwd(), "--json"], {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as {
    ok: boolean;
    stagedCount: number;
    errorCount: number;
    results: Array<{ memoryBudgetMiB?: number; safeMemoryBudgetMiB?: number }>;
  };
  assert.equal(parsed.ok, true);
  assert.ok(parsed.stagedCount >= 7);
  assert.equal(parsed.errorCount, 0);
  assert.ok(
    parsed.results.every(
      (result) => result.memoryBudgetMiB !== undefined && result.safeMemoryBudgetMiB !== undefined,
    ),
  );
});
