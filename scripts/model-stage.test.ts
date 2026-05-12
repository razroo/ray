import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModelStagePlan,
  formatCommandPlan,
  formatTextPlan,
  parseArgs,
  runModelStageCli,
} from "./model-stage.ts";

const repoRoot = process.cwd();

test("parseArgs accepts strict model staging options", () => {
  const digest = "a".repeat(64);
  const binaryDigest = "c".repeat(64);
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config",
    "/etc/ray/ray.json",
    "--ray-env-file",
    "/etc/ray/ray.env",
    "--user",
    "ray",
    "--group",
    "rayops",
    "--binary-source",
    "./bin/llama-server",
    "--binary-sha256",
    binaryDigest,
    "--source",
    "./models/local.gguf",
    "--sha256",
    digest,
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configPath, "/etc/ray/ray.json");
  assert.equal(args.envFile, "/etc/ray/ray.env");
  assert.equal(args.serviceUser, "ray");
  assert.equal(args.serviceGroup, "rayops");
  assert.equal(args.binarySourcePath, "./bin/llama-server");
  assert.equal(args.binarySha256, binaryDigest);
  assert.equal(args.sourcePath, "./models/local.gguf");
  assert.equal(args.sha256, digest);
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed model staging argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--config", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--source"]), /--source requires a value/);
  assert.throws(() => parseArgs(["--binary-source"]), /--binary-source requires a value/);
  assert.throws(() => parseArgs(["--user", "ray user"]), /system account name/);
  assert.throws(() => parseArgs(["--sha256", "bad"]), /64-character hexadecimal/);
  assert.throws(
    () => parseArgs(["--binary-sha256", "bad"]),
    /--binary-sha256 must be a 64-character hexadecimal/,
  );
  assert.throws(
    () => parseArgs(["--json", "--commands-only"]),
    /--json and --commands-only cannot be used together/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["model.gguf"]), /Unexpected positional argument/);
});

test("createModelStagePlan resolves config, env overrides, and install commands", async () => {
  const digest = "b".repeat(64);
  const binaryDigest = "c".repeat(64);
  const plan = await createModelStagePlan({
    cwd: repoRoot,
    configPath: "./examples/config/ray.1b.generic.public.json",
    env: {
      RAY_DEPLOY_SERVICE_USER: "rayops",
      RAY_MODEL_ID: "portable-1b",
      RAY_MODEL_REF: "portable-1b",
      RAY_MODEL_PATH: "/var/lib/ray/models/portable-1b.gguf",
      RAY_LLAMA_CPP_ALIAS: "portable-1b",
      RAY_LLAMA_CPP_BINARY_PATH: "/usr/local/bin/llama-server",
    },
    serviceGroup: "rayops",
    binarySourcePath: "./bin/llama-server",
    binarySha256: binaryDigest,
    sourcePath: "./models/portable-1b.gguf",
    sha256: digest,
  });

  assert.equal(plan.profile, "1b");
  assert.equal(plan.modelId, "portable-1b");
  assert.equal(plan.modelRef, "portable-1b");
  assert.equal(plan.alias, "portable-1b");
  assert.equal(plan.serviceUser, "rayops");
  assert.equal(plan.serviceGroup, "rayops");
  assert.equal(plan.binaryPath, "/usr/local/bin/llama-server");
  assert.equal(plan.binaryDirectory, "/usr/local/bin");
  assert.equal(plan.modelPath, "/var/lib/ray/models/portable-1b.gguf");
  assert.deepEqual(plan.commands, [
    "sudo install -d -m 0755 '/usr/local/bin'",
    "sudo install -D -m 0755 -- './bin/llama-server' '/usr/local/bin/llama-server'",
    "printf '%s  %s\\n' 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' '/usr/local/bin/llama-server' | sha256sum -c -",
    "sudo -u 'rayops' test -x '/usr/local/bin/llama-server'",
    "sudo install -d -m 0755 '/var/lib/ray/models'",
    "sudo install -D -m 0640 -- './models/portable-1b.gguf' '/var/lib/ray/models/portable-1b.gguf'",
    "sudo chown 'rayops:rayops' '/var/lib/ray/models/portable-1b.gguf'",
    "printf '%s  %s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' '/var/lib/ray/models/portable-1b.gguf' | sha256sum -c -",
    "sudo -u 'rayops' test -r '/var/lib/ray/models/portable-1b.gguf'",
  ]);
});

test("createModelStagePlan reads staging sources and checksums from env", async () => {
  const plan = await createModelStagePlan({
    cwd: repoRoot,
    configPath: "./examples/config/ray.1b.generic.public.json",
    env: {
      RAY_LLAMA_CPP_BINARY_SOURCE_PATH: "/tmp/ray-artifacts/llama-server",
      RAY_LLAMA_CPP_BINARY_SHA256: "C".repeat(64),
      RAY_MODEL_SOURCE_PATH: "/tmp/ray-artifacts/local-1b-q4.gguf",
      RAY_MODEL_SHA256: "B".repeat(64),
    },
  });

  assert.equal(plan.binarySourcePath, "/tmp/ray-artifacts/llama-server");
  assert.equal(plan.binarySha256, "c".repeat(64));
  assert.equal(plan.sourcePath, "/tmp/ray-artifacts/local-1b-q4.gguf");
  assert.equal(plan.sha256, "b".repeat(64));
  assert.match(
    plan.commands.join("\n"),
    /sudo install -D -m 0755 -- '\/tmp\/ray-artifacts\/llama-server' '\/usr\/local\/bin\/llama-server'/,
  );
  assert.match(
    plan.commands.join("\n"),
    /sudo install -D -m 0640 -- '\/tmp\/ray-artifacts\/local-1b-q4\.gguf' '\/var\/lib\/ray\/models\/local-1b-q4\.gguf'/,
  );
});

test("formatTextPlan prints an operator-ready staging plan", async () => {
  const plan = await createModelStagePlan({
    cwd: repoRoot,
    configPath: "./examples/config/ray.sub1b.public.json",
    env: {},
  });
  const text = formatTextPlan(repoRoot, plan);

  assert.match(text, /Ray llama\.cpp artifact staging plan:/);
  assert.match(text, /binary source: pass --binary-source \/path\/to\/llama-server/);
  assert.match(text, /sudo install -D -m 0755 -- '\/path\/to\/llama-server'/);
  assert.match(text, /target GGUF: \/var\/lib\/ray\/models\/qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/);
  assert.match(text, /sudo install -D -m 0640 -- '\/path\/to\/model\.gguf'/);
  assert.match(text, /Then run doctor on the VPS/);
});

test("formatCommandPlan prints shell commands only", async () => {
  const plan = await createModelStagePlan({
    cwd: repoRoot,
    configPath: "./examples/config/ray.sub1b.public.json",
    env: {},
    binarySourcePath: "./llama-server",
    sourcePath: "./model.gguf",
  });
  const text = formatCommandPlan(plan);

  assert.equal(text, plan.commands.join("\n"));
  assert.doesNotMatch(text, /Ray llama\.cpp artifact staging plan/);
  assert.match(text, /^sudo install -d -m 0755/);
  assert.match(text, /sudo -u 'ray' test -r/);
});

test("runModelStageCli loads ray env file overrides", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const envFile = path.join(tempDir, "ray.env");
  await writeFile(
    envFile,
    [
      "RAY_DEPLOY_SERVICE_USER=rayenv",
      "RAY_MODEL_ID=env-1b",
      "RAY_MODEL_REF=env-1b",
      "RAY_MODEL_PATH=/var/lib/ray/models/env-1b.gguf",
      "",
    ].join("\n"),
    "utf8",
  );

  let stdout = "";
  let stderr = "";
  const exitCode = await runModelStageCli(
    [
      "--cwd",
      repoRoot,
      "--config",
      "./examples/config/ray.1b.generic.public.json",
      "--env-file",
      envFile,
      "--json",
    ],
    {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    {},
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { modelId: string; modelPath: string; serviceUser: string };
  assert.equal(parsed.modelId, "env-1b");
  assert.equal(parsed.modelPath, "/var/lib/ray/models/env-1b.gguf");
  assert.equal(parsed.serviceUser, "rayenv");
});

test("runModelStageCli can print commands only", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runModelStageCli(
    [
      "--cwd",
      repoRoot,
      "--config",
      "./examples/config/ray.1b.generic.public.json",
      "--binary-source",
      "./llama-server",
      "--source",
      "./local-1b-q4.gguf",
      "--commands-only",
    ],
    {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    {},
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /Ray llama\.cpp artifact staging plan/);
  assert.match(stdout, /^sudo install -d -m 0755/);
  assert.match(stdout, /sudo install -D -m 0640 -- '\.\/local-1b-q4\.gguf'/);
});
