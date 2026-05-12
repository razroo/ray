import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectPublicConfigPaths,
  formatTextSummary,
  parseArgs,
  smokeDeployConfigs,
} from "./deploy-smoke.ts";

test("parseArgs accepts strict deploy smoke options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config-dir",
    "examples/config",
    "--domain",
    "ray.example.com",
    "--gateway-runtime",
    "/opt/ray/bin/bun",
    "--user",
    "ray",
    "--systemd-env-file",
    "/etc/ray/ray.env",
    "--json",
    "--verbose",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configDir, "examples/config");
  assert.equal(args.domain, "ray.example.com");
  assert.equal(args.runtimeBinary, "/opt/ray/bin/bun");
  assert.equal(args.serviceUser, "ray");
  assert.equal(args.systemdEnvFile, "/etc/ray/ray.env");
  assert.equal(args.json, true);
  assert.equal(args.verbose, true);
});

test("parseArgs rejects malformed deploy smoke argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--domain", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--domain"]), /--domain requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("collectPublicConfigPaths returns sorted public JSON config paths only", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-deploy-smoke-collector-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configDir = path.join(tempDir, "configs");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "b.public.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "private.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "a.public.json"), "{}", "utf8");

  assert.deepEqual(await collectPublicConfigPaths(tempDir, "configs"), [
    path.join(configDir, "a.public.json"),
    path.join(configDir, "b.public.json"),
  ]);
});

test("smokeDeployConfigs renders every checked-in public deploy profile", async () => {
  const cwd = process.cwd();
  const configPaths = await collectPublicConfigPaths(cwd, "examples/config");
  const summary = await smokeDeployConfigs({
    cwd,
    configPaths,
    domain: "ray.example.com",
    runtimeBinary: "/usr/local/bin/bun",
    serviceUser: "ray",
    systemdEnvFile: "/etc/ray/ray.env",
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.configCount >= 7);
  assert.ok(summary.warningCount > 0);
  assert.ok(summary.results.every((result) => result.gatewayMemorySwapMaxMiB === 128));
  assert.ok(
    summary.results.some(
      (result) => result.hasLlamaCppService && result.llamaCppMemorySwapMaxMiB !== undefined,
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.sub1b.cax11.public.json") &&
        result.profile === "sub1b-cax11" &&
        result.hasLlamaCppService,
    ),
  );
  const compactSummary = formatTextSummary(cwd, summary);
  assert.match(compactSummary, /gatewaySwapMax=128MiB/);
  assert.match(compactSummary, /llamaSwapMax=\d+MiB/);
  assert.match(compactSummary, /Run with --verbose to print warning diagnostics/);
  assert.doesNotMatch(compactSummary, /warn auth_keys_unverified:/);

  const verboseSummary = formatTextSummary(cwd, summary, { verbose: true });
  assert.match(verboseSummary, /warn auth_keys_unverified:/);
  assert.match(verboseSummary, /Summary: warnings=\d+ errors=0/);
});
