import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectConfigPaths,
  formatTextSummary,
  parseArgs,
  validateConfigFiles,
} from "./validate-configs.ts";

test("parseArgs accepts strict config validation options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config-dir",
    "examples/config",
    "--fail-on-warn",
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configDir, "examples/config");
  assert.equal(args.failOnWarn, true);
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed config validation argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--config-dir"]), /--config-dir requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("collectConfigPaths returns sorted JSON config paths only", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-config-collector-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configDir = path.join(tempDir, "configs");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "b.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "notes.txt"), "ignored", "utf8");
  await writeFile(path.join(configDir, "a.json"), "{}", "utf8");

  assert.deepEqual(await collectConfigPaths(tempDir, "configs"), [
    path.join(configDir, "a.json"),
    path.join(configDir, "b.json"),
  ]);
});

test("validateConfigFiles accepts every checked-in example config", async () => {
  const cwd = process.cwd();
  const configPaths = await collectConfigPaths(cwd, "examples/config");
  const summary = await validateConfigFiles({
    cwd,
    configPaths,
    env: { ...process.env, RAY_API_KEYS: "smoke" },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.configCount >= 19);
  assert.ok(summary.warningCount > 0);
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.sub1b.cax11.public.json") &&
        result.profile === "sub1b-cax11",
    ),
  );
  assert.match(formatTextSummary(cwd, summary), /Summary: warnings=\d+ errors=0/);
});
