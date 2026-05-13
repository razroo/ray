import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectDeploySmokeConfigPaths,
  collectPublicConfigPaths,
  formatTextSummary,
  parseArgs,
  smokeDeployConfigs,
  validateStaticVpsExamples,
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

test("collectPublicConfigPaths rejects excessive public configs while streaming", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-deploy-smoke-config-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configDir = path.join(tempDir, "configs");
  await mkdir(configDir);
  await Promise.all(
    Array.from({ length: 129 }, (_value, index) =>
      writeFile(path.join(configDir, `${index.toString().padStart(3, "0")}.public.json`), "{}"),
    ),
  );

  await assert.rejects(
    () => collectPublicConfigPaths(tempDir, "configs"),
    /Config directory must contain at most 128 public JSON files/,
  );
});

test("smokeDeployConfigs renders every checked-in deploy smoke profile", async () => {
  const cwd = process.cwd();
  const configPaths = await collectDeploySmokeConfigPaths(cwd, "examples/config");
  const summary = await smokeDeployConfigs({
    cwd,
    configPaths,
    domain: "ray.example.com",
    runtimeBinary: "/usr/local/bin/bun",
    serviceUser: "ray",
    systemdEnvFile: "/etc/ray/ray.env",
    env: {
      ...process.env,
      RAY_API_KEYS: "host-key-should-not-hide-smoke-warning",
      RAY_LLAMA_CPP_CTX_SIZE: "not-a-number",
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.configCount >= 9);
  assert.ok(summary.warningCount > 0);
  assert.equal(
    summary.results
      .filter((result) => result.configPath.endsWith(".public.json"))
      .every((result) =>
        result.diagnostics.some((diagnostic) => diagnostic.code === "auth_keys_unverified"),
      ),
    true,
  );
  assert.equal(
    summary.results
      .flatMap((result) => result.diagnostics)
      .some((diagnostic) =>
        [
          "async_queue_storage_low",
          "async_queue_storage_ok",
          "async_queue_storage_not_directory",
          "async_queue_storage_unreadable",
          "async_queue_storage_service_user_inaccessible",
          "async_queue_retained_jobs_exceed_storage_reserve",
        ].includes(diagnostic.code),
      ),
    false,
  );
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
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.vps.json") &&
        result.profile === "vps" &&
        !result.hasLlamaCppService,
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.balanced.json") &&
        result.profile === "balanced" &&
        !result.hasLlamaCppService,
    ),
  );
  const compactSummary = formatTextSummary(cwd, summary);
  assert.match(compactSummary, /Rendered \d+ Ray deploy profiles/);
  assert.match(compactSummary, /gatewaySwapMax=128MiB/);
  assert.match(compactSummary, /llamaSwapMax=\d+MiB/);
  assert.match(compactSummary, /Run with --verbose to print warning diagnostics/);
  assert.doesNotMatch(compactSummary, /warn auth_keys_unverified:/);

  const verboseSummary = formatTextSummary(cwd, summary, { verbose: true });
  assert.match(verboseSummary, /warn auth_keys_unverified:/);
  assert.doesNotMatch(verboseSummary, /async_queue_storage_(?:low|ok|not_directory|unreadable)/);
  assert.match(verboseSummary, /Summary: warnings=\d+ errors=0/);
});

test("validateStaticVpsExamples keeps checked-in VPS examples aligned with render output", async () => {
  const result = await validateStaticVpsExamples({ cwd: process.cwd() });

  assert.equal(result.errorCount, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("validateStaticVpsExamples reports drifted checked-in VPS examples", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-deploy-static-drift-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const servicePath = path.join(tempDir, "ray-gateway.service");
  await writeFile(servicePath, "[Unit]\nDescription=stale\n", "utf8");

  const result = await validateStaticVpsExamples({
    cwd: process.cwd(),
    servicePath,
  });

  assert.equal(result.errorCount, 1);
  assert.equal(result.diagnostics[0]?.code, "static_vps_gateway_service_drift");
});
