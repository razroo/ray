import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkModelStageSources,
  applyModelStagePlan,
  createModelStagePlan,
  evaluateModelStageStorageHeadroom,
  formatApplyResult,
  formatCommandPlan,
  formatTextPlan,
  parseArgs,
  resolveModelStageAvailableStorageMiB,
  runModelStageCli,
} from "./model-stage.ts";

const repoRoot = process.cwd();
const MiB = 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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
    "--check-sources",
    "--apply",
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
  assert.equal(args.checkSources, true);
  assert.equal(args.apply, true);
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
  assert.throws(
    () => parseArgs(["--apply", "--commands-only"]),
    /--apply and --commands-only cannot be used together/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["model.gguf"]), /Unexpected positional argument/);
});

test("evaluateModelStageStorageHeadroom keeps a post-copy reserve", () => {
  assert.deepEqual(evaluateModelStageStorageHeadroom(1 * MiB + 1, 258), {
    sourceMiB: 2,
    reserveMiB: 256,
    requiredMiB: 258,
    availableMiB: 258,
    ok: true,
  });
  assert.equal(evaluateModelStageStorageHeadroom(1 * MiB + 1, 257).ok, false);
  assert.throws(() => evaluateModelStageStorageHeadroom(-1, 258), /sourceBytes/);
  assert.throws(() => evaluateModelStageStorageHeadroom(1, -1), /availableMiB/);
});

test("resolveModelStageAvailableStorageMiB handles Bun statfs zero block size", () => {
  assert.equal(
    resolveModelStageAvailableStorageMiB({
      bavail: 999_999,
      bsize: 0,
      blocks: 4096,
      ffree: 32_512,
    }),
    127,
  );
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
    "sudo -u 'rayops' timeout 5s '/usr/local/bin/llama-server' --help >/dev/null",
    "sudo install -d -m 0755 '/var/lib/ray/models'",
    `required_mib="$(du -m './models/portable-1b.gguf' | awk 'NR==1 {print $1 + 256}')"; available_mib="$(df -Pm '/var/lib/ray/models' | awk 'NR==2 {print $4}')"; test "\${available_mib:-0}" -ge "\${required_mib:-0}" || { printf '%s\\n' 'Not enough free space in /var/lib/ray/models: keep at least 256 MiB free after copying the GGUF.' >&2; exit 1; }`,
    `test "$(head -c 4 -- './models/portable-1b.gguf')" = 'GGUF' || { printf '%s\\n' 'GGUF source does not start with the GGUF header: ./models/portable-1b.gguf' >&2; exit 1; }`,
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
  assert.match(plan.commands.join("\n"), /df -Pm '\/var\/lib\/ray\/models'/);
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
  assert.match(
    text,
    /sudo -u 'ray' timeout 5s '\/usr\/local\/bin\/llama-server' --help >\/dev\/null/,
  );
  assert.match(text, /target GGUF: \/var\/lib\/ray\/models\/qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/);
  assert.match(text, /keep at least 256 MiB free after copying the GGUF/);
  assert.match(text, /head -c 4/);
  assert.match(text, /GGUF source does not start with the GGUF header/);
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
  assert.match(
    text,
    /sudo -u 'ray' timeout 5s '\/usr\/local\/bin\/llama-server' --help >\/dev\/null/,
  );
  assert.match(text, /head -c 4 -- '\.\/model\.gguf'/);
  assert.match(text, /sudo -u 'ray' test -r/);
});

test("checkModelStageSources verifies concrete artifact inputs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-sources-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  const binaryContents = "#!/bin/sh\nexit 0\n";
  const modelContents = "GGUF";
  await writeFile(binaryPath, binaryContents, "utf8");
  await writeFile(modelPath, modelContents, "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {},
    binarySourcePath: "./llama-server",
    binarySha256: sha256(binaryContents),
    sourcePath: "./model.gguf",
    sha256: sha256(modelContents),
  });

  await assert.doesNotReject(checkModelStageSources(tempDir, plan));
});

test("checkModelStageSources rejects source binaries that fail the startup probe", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-source-probe-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  await writeFile(binaryPath, "#!/bin/sh\necho 'wrong architecture' >&2\nexit 126\n", "utf8");
  await writeFile(modelPath, "GGUF", "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {},
    binarySourcePath: "./llama-server",
    sourcePath: "./model.gguf",
  });

  await assert.rejects(
    checkModelStageSources(tempDir, plan),
    /llama-server source failed startup probe.*wrong architecture/s,
  );
});

test("checkModelStageSources rejects model sources without a GGUF header", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-bad-gguf-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(modelPath, "NOPE", "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {},
    binarySourcePath: "./llama-server",
    sourcePath: "./model.gguf",
  });

  await assert.rejects(
    checkModelStageSources(tempDir, plan),
    /GGUF source is not a valid GGUF artifact.*expected GGUF magic header/s,
  );
});

test("checkModelStageSources rejects checksum mismatches", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-bad-sha-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(modelPath, "GGUF", "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {},
    binarySourcePath: "./llama-server",
    binarySha256: "c".repeat(64),
    sourcePath: "./model.gguf",
  });

  await assert.rejects(
    checkModelStageSources(tempDir, plan),
    /llama-server source SHA-256 mismatch/,
  );
});

test("checkModelStageSources rejects missing concrete artifact inputs", async () => {
  const plan = await createModelStagePlan({
    cwd: repoRoot,
    configPath: "./examples/config/ray.sub1b.public.json",
    env: {},
  });

  await assert.rejects(checkModelStageSources(repoRoot, plan), /--binary-source/);
});

test("applyModelStagePlan installs verified artifacts into the resolved target paths", async (t) => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-apply-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "sources", "llama-server");
  const modelPath = path.join(tempDir, "sources", "model.gguf");
  const binaryTarget = path.join(tempDir, "target", "bin", "llama-server");
  const modelTarget = path.join(tempDir, "target", "models", "model.gguf");
  const binaryContents = "#!/bin/sh\nexit 0\n";
  const modelContents = "GGUF";
  await mkdir(path.join(tempDir, "sources"), { recursive: true });
  await writeFile(binaryPath, binaryContents, "utf8");
  await writeFile(modelPath, modelContents, "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {
      RAY_LLAMA_CPP_BINARY_PATH: binaryTarget,
      RAY_MODEL_PATH: modelTarget,
    },
    serviceUser: String(uid),
    serviceGroup: String(gid),
    binarySourcePath: "./sources/llama-server",
    binarySha256: sha256(binaryContents),
    sourcePath: "./sources/model.gguf",
    sha256: sha256(modelContents),
  });

  const result = await applyModelStagePlan(tempDir, plan);
  assert.deepEqual(result, {
    applied: true,
    binaryPath: binaryTarget,
    binaryProbeStatus: "ok",
    modelPath: modelTarget,
    modelReadStatus: "ok",
    serviceUser: String(uid),
    serviceGroup: String(gid),
  });
  assert.equal(await readFile(binaryTarget, "utf8"), binaryContents);
  assert.equal(await readFile(modelTarget, "utf8"), modelContents);

  const binaryStats = await stat(binaryTarget);
  const modelStats = await stat(modelTarget);
  assert.equal(binaryStats.mode & 0o777, 0o755);
  assert.equal(modelStats.mode & 0o777, 0o640);
  assert.equal(modelStats.uid, uid);
  assert.equal(modelStats.gid, gid);
});

test("applyModelStagePlan rejects source binaries that fail the startup probe", async (t) => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-apply-probe-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "sources", "llama-server");
  const modelPath = path.join(tempDir, "sources", "model.gguf");
  const binaryTarget = path.join(tempDir, "target", "bin", "llama-server");
  const modelTarget = path.join(tempDir, "target", "models", "model.gguf");
  await mkdir(path.join(tempDir, "sources"), { recursive: true });
  await writeFile(binaryPath, "#!/bin/sh\necho 'missing shared library' >&2\nexit 127\n", "utf8");
  await writeFile(modelPath, "GGUF", "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  const plan = await createModelStagePlan({
    cwd: tempDir,
    configPath: path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
    env: {
      RAY_LLAMA_CPP_BINARY_PATH: binaryTarget,
      RAY_MODEL_PATH: modelTarget,
    },
    serviceUser: String(uid),
    serviceGroup: String(gid),
    binarySourcePath: "./sources/llama-server",
    sourcePath: "./sources/model.gguf",
  });

  await assert.rejects(
    applyModelStagePlan(tempDir, plan),
    /llama-server source failed startup probe.*missing shared library/s,
  );
});

test("formatApplyResult prints the staged artifact summary", () => {
  const text = formatApplyResult({
    applied: true,
    binaryPath: "/usr/local/bin/llama-server",
    binaryProbeStatus: "ok",
    modelPath: "/var/lib/ray/models/local.gguf",
    modelReadStatus: "ok",
    serviceUser: "ray",
    serviceGroup: "ray",
  });

  assert.match(text, /Staged Ray llama\.cpp artifacts:/);
  assert.match(text, /binary: \/usr\/local\/bin\/llama-server/);
  assert.match(text, /binary startup probe: ok/);
  assert.match(text, /GGUF: \/var\/lib\/ray\/models\/local\.gguf/);
  assert.match(text, /GGUF service-user read: ok/);
  assert.match(text, /Run doctor before restarting ray-llama-cpp\.service/);
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

test("runModelStageCli can apply verified artifacts", async (t) => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-cli-apply-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "sources"), { recursive: true });
  await writeFile(path.join(tempDir, "sources", "llama-server"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(path.join(tempDir, "sources", "model.gguf"), "GGUF", "utf8");
  await chmod(path.join(tempDir, "sources", "llama-server"), 0o755);

  let stdout = "";
  let stderr = "";
  const exitCode = await runModelStageCli(
    [
      "--cwd",
      tempDir,
      "--config",
      path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
      "--user",
      String(uid),
      "--group",
      String(gid),
      "--binary-source",
      "./sources/llama-server",
      "--source",
      "./sources/model.gguf",
      "--apply",
      "--json",
    ],
    {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    {
      RAY_LLAMA_CPP_BINARY_PATH: path.join(tempDir, "target", "bin", "llama-server"),
      RAY_MODEL_PATH: path.join(tempDir, "target", "models", "model.gguf"),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as {
    applied: true;
    binaryProbeStatus: "ok";
    modelReadStatus: "ok";
    plan: { binaryPath: string };
  };
  assert.equal(parsed.applied, true);
  assert.equal(parsed.binaryProbeStatus, "ok");
  assert.equal(parsed.modelReadStatus, "ok");
  assert.equal(parsed.plan.binaryPath, path.join(tempDir, "target", "bin", "llama-server"));
  assert.equal(
    await readFile(path.join(tempDir, "target", "models", "model.gguf"), "utf8"),
    "GGUF",
  );
});

test("runModelStageCli checks source artifacts before printing", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-model-stage-cli-sources-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(modelPath, "GGUF", "utf8");
  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o644);

  let stdout = "";
  let stderr = "";
  const exitCode = await runModelStageCli(
    [
      "--cwd",
      tempDir,
      "--config",
      path.join(repoRoot, "examples/config/ray.sub1b.public.json"),
      "--binary-source",
      "./llama-server",
      "--source",
      "./model.gguf",
      "--check-sources",
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
  assert.match(stdout, /sudo install -D -m 0755 -- '\.\/llama-server'/);
});
