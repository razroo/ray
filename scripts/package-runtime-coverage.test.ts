import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectPackageJsonPaths,
  formatTextSummary,
  parseArgs,
  runPackageRuntimeCoverageCli,
  validatePackageRuntimeCoverage,
} from "./package-runtime-coverage.ts";

const repoRoot = process.cwd();

test("parseArgs accepts strict package runtime coverage options", () => {
  const args = parseArgs(["--cwd", "/srv/ray", "--json"]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed package runtime coverage argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["package.json"]), /Unexpected positional argument/);
});

test("validatePackageRuntimeCoverage accepts current Bun-first workspace manifests", async () => {
  const packageJsonPaths = await collectPackageJsonPaths(repoRoot);
  const summary = await validatePackageRuntimeCoverage({
    cwd: repoRoot,
    packageJsonPaths,
  });

  assert.equal(summary.ok, true);
  assert.ok(summary.packageCount >= 10);
  assert.ok(summary.workflowCount >= 1);
  assert.ok(summary.docCount >= 8);
  assert.equal(summary.runtimeScriptCount, 3);
  assert.ok(summary.scriptCount > 0);
  assert.equal(summary.forbiddenLockfiles.length, 0);
  assert.ok(
    summary.results.some(
      (result) => result.packagePath === path.join(repoRoot, "apps/control-panel/README.md"),
    ),
  );
  assert.ok(
    summary.results.some(
      (result) => result.packagePath === path.join(repoRoot, "packages/sdk/README.md"),
    ),
  );
  assert.ok(
    summary.results.some(
      (result) => result.packagePath === path.join(repoRoot, "docs/npm-publishing.md"),
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.packagePath === path.join(repoRoot, "package.json") &&
        result.packageManager?.startsWith("bun@"),
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.packagePath === path.join(repoRoot, "scripts", "deploy-storage-preflight.ts") &&
        result.kind === "script",
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.packagePath === path.join(repoRoot, "scripts", "model-stage.ts") &&
        result.kind === "script",
    ),
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.packagePath === path.join(repoRoot, "scripts", "swap-plan.ts") &&
        result.kind === "script",
    ),
  );
});

test("validatePackageRuntimeCoverage rejects repo-owned VPS deploy workflows", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-deploy-workflow-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  const deployWorkflowPath = path.join(workflowDir, "deploy-vps.yml");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(deployWorkflowPath, ["name: Deploy VPS", "jobs: {}", ""].join("\n"));

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "repo_owned_deploy_workflow_present" &&
        diagnostic.workflowPath === deployWorkflowPath,
    ),
  );
});

test("validatePackageRuntimeCoverage rejects excessive package inputs before scanning", async () => {
  await assert.rejects(
    () =>
      validatePackageRuntimeCoverage({
        cwd: repoRoot,
        packageJsonPaths: Array.from(
          { length: 129 },
          (_value, index) => `/tmp/ray-package-${index}/package.json`,
        ),
      }),
    /at most 128 package\.json files/,
  );
});

test("validatePackageRuntimeCoverage rejects malformed direct paths before scanning", async () => {
  await assert.rejects(
    () =>
      validatePackageRuntimeCoverage({
        cwd: " /srv/ray",
        packageJsonPaths: [path.join(repoRoot, "package.json")],
      }),
    /cwd must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () =>
      validatePackageRuntimeCoverage({
        cwd: repoRoot,
        packageJsonPaths: ["package.json\n"],
      }),
    /packageJsonPaths\[0\] must not contain control characters/,
  );
  await assert.rejects(
    () =>
      validatePackageRuntimeCoverage({
        cwd: `/${"a".repeat(4096)}`,
        packageJsonPaths: [path.join(repoRoot, "package.json")],
      }),
    /cwd must be at most 4096 bytes/,
  );

  await assert.rejects(
    () =>
      validatePackageRuntimeCoverage({
        cwd: repoRoot,
        packageJsonPaths: [`/${"a".repeat(4096)}`],
      }),
    /packageJsonPaths\[0\] must be at most 4096 bytes/,
  );
});

test("validatePackageRuntimeCoverage requires config and Bun cache storage preflight coverage", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-storage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "deploy:storage": "bun ./scripts/deploy-storage-preflight.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "scripts", "deploy-storage-preflight.ts"),
    [
      'const DEFAULT_STORAGE_PATHS = ["/srv/ray", "/srv/ray/.ray/bun-install-cache", "/var/lib/ray", "/tmp", "/var/tmp"] as const;',
      'const HELP = "--ray-env-file RAY_DEPLOY_MIN_FREE_STORAGE_MIB";',
      "async function loadDeployStoragePreflightArgs() {}",
      "async function readEnvironmentFileBounded() {}",
      'const ENV_FILE_STORAGE_PATH_KEYS = ["RAY_MODEL_PATH", "RAY_LLAMA_CPP_MODEL_PATH", "RAY_ASYNC_QUEUE_STORAGE_DIR"] as const;',
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.runtimeScriptCount, 1);
  assert.ok(codes.includes("deploy_storage_bun_cache_preflight_missing"));
});

test("validatePackageRuntimeCoverage requires root filesystem deploy storage preflight coverage", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-storage-root-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "deploy:storage": "bun ./scripts/deploy-storage-preflight.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "scripts", "deploy-storage-preflight.ts"),
    [
      'const DEFAULT_STORAGE_PATHS = ["/var/cache/apt", "/var/lib/apt", "/etc/ray", "/etc/systemd/system", "/etc/caddy", "/srv/ray", "/srv/ray/.ray/bun-install-cache", "/var/lib/ray", "/tmp", "/var/tmp"] as const;',
      'const HELP = "--ray-env-file RAY_DEPLOY_MIN_FREE_STORAGE_MIB";',
      "async function loadDeployStoragePreflightArgs() {}",
      "async function readEnvironmentFileBounded() {}",
      'const ENV_FILE_STORAGE_PATH_KEYS = ["RAY_MODEL_PATH", "RAY_LLAMA_CPP_MODEL_PATH", "RAY_LLAMA_CPP_BINARY_PATH", "RAY_ASYNC_QUEUE_STORAGE_DIR"] as const;',
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.runtimeScriptCount, 1);
  assert.ok(codes.includes("deploy_storage_bun_cache_preflight_missing"));
});

test("validatePackageRuntimeCoverage requires VPS deploy trigger for storage preflight changes", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-workflow-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  const deployWorkflowPath = path.join(workflowDir, "deploy-vps.yml");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    deployWorkflowPath,
    [
      "name: Deploy VPS",
      "on:",
      "  push:",
      "    branches: [main]",
      "    paths:",
      "      - package.json",
      "      - scripts/model-stage.ts",
      "env:",
      "  RAY_DEPLOY_MIN_FREE_STORAGE_MIB: ${{ vars.RAY_DEPLOY_MIN_FREE_STORAGE_MIB }}",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: |",
      "          envOverrides.RAY_DEPLOY_MIN_FREE_STORAGE_MIB",
      "          process.env.RAY_DEPLOY_MIN_FREE_STORAGE_MIB",
      "          parseOptionalNonNegativeInteger",
      '          echo "deploy_min_free_storage_mib=$DEPLOY_MIN_FREE_STORAGE_MIB" >> "$GITHUB_OUTPUT"',
      '          DEPLOY_MIN_FREE_STORAGE_MIB=$(shell_quote "$DEPLOY_MIN_FREE_STORAGE_MIB")',
      '          DEPLOY_MIN_FREE_STORAGE_MIB=$(shell_quote "$DEPLOY_MIN_FREE_STORAGE_MIB")',
      "          timeout 30s df -Pm",
      "          timeout 60s $SUDO install -d -m 0755 /etc/caddy",
      '          check_free_storage /var/cache/apt "APT package cache"',
      '          check_free_storage /var/lib/apt "APT package state"',
      '          check_free_storage /etc/ray "Ray config directory"',
      '          check_free_storage /etc/systemd/system "systemd unit directory"',
      '          check_free_storage /etc/caddy "Caddy config directory"',
      '          check_free_storage /srv/ray "synced checkout"',
      '          check_free_storage /var/lib/ray "Ray state"',
      '          check_free_storage /tmp "temporary directory"',
      '          check_free_storage /var/tmp "persistent temporary directory"',
      '          BUN_INSTALL_CACHE_DIR="/srv/ray/.ray/bun-install-cache"',
      '          check_free_storage "$BUN_INSTALL_CACHE_DIR" "Bun install cache"',
      '          check_free_storage /srv/ray "Bun production install"',
      "          /srv/ray/scripts/deploy-storage-preflight.ts --ray-env-file /etc/ray/ray.env",
      "          Remote deploy preflight requires at least",
      "          rsync -az --delete ./ ray@example:/srv/ray/",
      "          /usr/local/bin/bun install --production --frozen-lockfile",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "workflow_remote_storage_preflight_missing" &&
        diagnostic.workflowPath === deployWorkflowPath,
    ),
  );
});

test("validatePackageRuntimeCoverage requires guarded Bun installer copy cleanup", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-bun-copy-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  const deployWorkflowPath = path.join(workflowDir, "deploy-vps.yml");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    deployWorkflowPath,
    [
      "name: Deploy VPS",
      "env:",
      "  RAY_GATEWAY_RUNTIME_BINARY: ${{ vars.RAY_GATEWAY_RUNTIME_BINARY }}",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: |",
      "          basename \"${GATEWAY_RUNTIME_BINARY:-}\" | tr '[:upper:]' '[:lower:]'",
      '          [ "${GATEWAY_RUNTIME_BINARY:-}" != "/usr/local/bin/bun" ]',
      '          install -D -m 0755 /usr/local/bin/bun "$GATEWAY_RUNTIME_BINARY"',
      '          bun_install_dir="$(timeout 30s mktemp -d "${TMPDIR:-/tmp}/ray-bun-install.XXXXXX")"',
      '          export BUN_INSTALL="$bun_install_dir"',
      "          https://bun.sh/install | timeout 300s bash -s",
      '          [ ! -x "$bun_install_dir/bin/bun" ]',
      '          bun_runtime_version "$bun_install_dir/bin/bun"',
      '          timeout 60s $SUDO install -m 0755 "$bun_install_dir/bin/bun" /usr/local/bin/bun',
      '          timeout 60s rm -rf "$bun_install_dir"',
      "          unset BUN_INSTALL",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "workflow_gateway_runtime_bun_install_missing" &&
        diagnostic.workflowPath === deployWorkflowPath,
    ),
  );
});

test("validatePackageRuntimeCoverage requires bounded Bun installer temp setup in VPS docs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-bun-temp-doc-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  await mkdir(vpsDocDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(vpsDocDir, "README.md"),
    [
      "# VPS deploy",
      "",
      "```bash",
      'BUN_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/ray-bun-install.XXXXXX")"',
      "export BUN_INSTALL",
      'if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 120 https://bun.sh/install | timeout 300s bash -s "bun-v1.3.9"; then',
      '  timeout 60s rm -rf "$BUN_INSTALL"',
      "  unset BUN_INSTALL",
      "  exit 1",
      "fi",
      'timeout 60s rm -rf "$BUN_INSTALL"',
      "unset BUN_INSTALL",
      "```",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) => diagnostic.code === "vps_readme_bun_installer_temp_timeout_missing",
    ),
  );
});

test("validatePackageRuntimeCoverage requires bounded render temp cleanup", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-render-temp-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  const deployWorkflowPath = path.join(workflowDir, "deploy-vps.yml");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    deployWorkflowPath,
    [
      "name: Deploy VPS",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: |",
      '          RENDER_DIR="$(mktemp -d)"',
      '          CADDY_TMP=""',
      "          cleanup_render_dir() {",
      '            rm -rf "$RENDER_DIR"',
      '            rm -f "$CADDY_TMP"',
      "          }",
      "          trap cleanup_render_dir EXIT",
      '          /usr/local/bin/bun /srv/ray/packages/deploy/dist/cli.js render --output-dir "$RENDER_DIR"',
      '          CADDY_TMP="$(mktemp)"',
      '          "$CADDY_RUNTIME" validate --config "$CADDY_TMP"',
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "workflow_render_temp_cleanup_missing" &&
        diagnostic.workflowPath === deployWorkflowPath,
    ),
  );
});

test("validatePackageRuntimeCoverage requires deploy storage docs to mention binary path", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-storage-doc-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "docs"), { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "deploy:storage": "bun ./scripts/deploy-storage-preflight.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "docs", "portable-1b.md"),
    [
      "# Portable 1B",
      "",
      "```bash",
      "timeout 60s sudo /usr/local/bin/bun run deploy:storage -- --ray-env-file /etc/ray/ray.env",
      "```",
      "",
      "When the env file sets a custom `RAY_MODEL_PATH`, `RAY_LLAMA_CPP_MODEL_PATH`, or",
      "`RAY_ASYNC_QUEUE_STORAGE_DIR`, the preflight checks those volumes too.",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.ok(codes.includes("runtime_doc_deploy_storage_binary_path_missing"));
});

test("validatePackageRuntimeCoverage requires model staging headroom guards", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-model-stage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "model:stage": "bun ./scripts/model-stage.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "scripts", "model-stage.ts"),
    [
      "interface ModelStageStorageHeadroom {}",
      "const MIN_BINARY_STAGE_FREE_AFTER_COPY_MIB = 64;",
      "const MIN_MODEL_STAGE_FREE_AFTER_COPY_MIB = 256;",
      "function evaluateModelStageStorageHeadroom() {}",
      "function evaluateModelStageMemoryFit() {}",
      "function assertGgufMagicHeader() {}",
      "function assertLlamaCppBinarySupportsLaunchFlags() {}",
      "function copyFileAtomicUnlessSame() {}",
      "function assertModelStageStorageHeadroom() {}",
      "function assertBinaryStageStorageHeadroom() {}",
      'const HELP = "--ray-env-file RAY_DEPLOY_MEMORY_MIB";',
      "function readEnvironmentFileBounded() {}",
      'const commands = ["df -Pm", "RAY_DEPLOY_MIN_FREE_STORAGE_MIB", ".ray-stage-"];',
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.runtimeScriptCount, 1);
  assert.ok(codes.includes("model_stage_headroom_guard_missing"));
});

test("validatePackageRuntimeCoverage requires staged swap activation guards", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-swap-plan-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  await mkdir(path.join(tempDir, "scripts"), { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "swap:plan": "bun ./scripts/swap-plan.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "scripts", "swap-plan.ts"),
    [
      "function buildDiskHeadroomCommand() {}",
      "function createSwapPlan() {",
      '  return ["fallocate -l 1024M /swapfile", "mkswap /swapfile", "swapon /swapfile"];',
      "}",
      'const HELP = "--sysctl-only vm.swappiness";',
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.equal(summary.runtimeScriptCount, 1);
  assert.ok(codes.includes("swap_plan_temp_activation_guard_missing"));
});

test("validatePackageRuntimeCoverage catches non-Bun scripts and lockfiles", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const appDir = path.join(tempDir, "apps", "gateway");
  const packageDocDir = path.join(tempDir, "packages", "sdk");
  const workflowDir = path.join(tempDir, ".github", "workflows");
  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  const integrationDocDir = path.join(tempDir, "docs", "integrations");
  await mkdir(appDir, { recursive: true });
  await mkdir(packageDocDir, { recursive: true });
  await mkdir(workflowDir, { recursive: true });
  await mkdir(vpsDocDir, { recursive: true });
  await mkdir(integrationDocDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  const appPackageJson = path.join(appDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "pnpm@10.0.0",
        engines: {},
        scripts: {
          test: "pnpm test",
          build: "npm run compile",
          dev: "yarn dev",
          docs: "bun ./scripts/docs.ts",
          "release:gate": "bun run lint && bun run validate:config:all",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    appPackageJson,
    JSON.stringify(
      {
        name: "@ray/test-gateway",
        scripts: {
          start: "npx tsx src/index.ts",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(tempDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    path.join(tempDir, "README.md"),
    ["# Ray test", "", "```bash", "pnpm install", "bun run deploy:smoke", "```", ""].join("\n"),
  );
  await writeFile(
    path.join(workflowDir, "quality.yml"),
    [
      "name: Quality",
      "jobs:",
      "  quality:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: npm run build",
      "      - run: yarn test",
      "      - run: bun install",
      "      - run: npm publish ./pkg.tgz --access public",
      "      - run: curl -fsS http://127.0.0.1:${HEALTH_PORT}/readyz",
      "      - run: curl -fsSL https://bun.sh/install | bash -s bun-v1.3.9",
      "      - run: ssh -o ConnectTimeout=15 ray.example.com uptime",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workflowDir, "deploy-vps.yml"),
    [
      "name: Deploy VPS",
      "env:",
      "  RAY_DEPLOY_INSTALL_CADDY: ${{ vars.RAY_DEPLOY_INSTALL_CADDY }}",
      "  RAY_DEPLOY_DOMAIN: ${{ vars.RAY_DEPLOY_DOMAIN }}",
      "  RAY_DEPLOY_MEMORY_MIB: ${{ vars.RAY_DEPLOY_MEMORY_MIB }}",
      "  RAY_DEPLOY_READY_TIMEOUT_SECONDS: ${{ vars.RAY_DEPLOY_READY_TIMEOUT_SECONDS }}",
      "  RAY_DEPLOY_SERVICE_USER: ${{ vars.RAY_DEPLOY_SERVICE_USER }}",
      "  RAY_GATEWAY_RUNTIME_BINARY: ${{ vars.RAY_GATEWAY_RUNTIME_BINARY }}",
      "jobs:",
      "  deploy:",
      "    steps:",
      '      - run: echo "service_user=$SERVICE_USER" >> "$GITHUB_OUTPUT"',
      "      - run: printf secret | sudo tee /etc/ray/ray.env >/dev/null",
      "      - run: sudo useradd ray",
      "      - run: sudo apt-get install -y curl",
      "      - run: sudo chown -R ray:ray /var/lib/ray",
      "      - run: sudo chown -R ray:ray /srv/ray",
      "      - run: rsync -az --delete ./ ray@example:/srv/ray/",
      "      - run: ssh ray@example.com 'bash -s'",
      "      - run: timeout 120s rm -rf node_modules",
      "      - run: /usr/local/bin/bun install --production --frozen-lockfile --ignore-scripts",
      "      - run: timeout 120s sudo chmod -R a+rX /srv/ray",
      "      - run: $SUDO /usr/local/bin/bun /srv/ray/packages/deploy/dist/cli.js doctor",
      '      - run: "$binary" --version | head -n 1',
      '      - run: bun --eval \'import { readFileSync } from "node:fs"; readFileSync("/etc/ray/ray.env", "utf8")\'',
      "      - run: sudo systemctl reload caddy",
      "      - run: sudo journalctl -n 120 -u ray-gateway.service",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(vpsDocDir, "README.md"),
    [
      "# VPS deploy",
      "",
      "```bash",
      "curl -fsSL https://bun.sh/install | bash -s bun-v1.3.9",
      "sudo apt-get install -y curl",
      "git clone https://github.com/razroo/ray.git /srv/ray",
      "bun install",
      "bun run doctor",
      "npm run build",
      "sudo install -m 0644 Caddyfile /etc/caddy/Caddyfile",
      "sudo systemctl reload caddy",
      "timeout 60s sudo systemctl restart ray-gateway",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(integrationDocDir, "razroo-email-ai.md"),
    ["# Integration", "", "```bash", "yarn test", "```", ""].join("\n"),
  );
  await writeFile(
    path.join(tempDir, "docs", "release-checklist.md"),
    ["# Release checklist", "", "```bash", "npm run test", "```", ""].join("\n"),
  );
  await writeFile(
    path.join(tempDir, "docs", "npm-publishing.md"),
    [
      "# Publishing",
      "",
      "```bash",
      "npm install @razroo/ray-sdk",
      "npm publish ./pkg.tgz --provenance",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(packageDocDir, "README.md"),
    ["# SDK", "", "```bash", "npm install @razroo/ray-sdk", "```", ""].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson, appPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.ok(codes.includes("root_package_manager_not_bun"));
  assert.ok(codes.includes("root_bun_engine_missing"));
  assert.ok(codes.includes("release_gate_public_auth_validate_missing"));
  assert.ok(codes.includes("release_gate_tiny_gateway_smoke_missing"));
  assert.ok(codes.includes("release_gate_tiny_public_smoke_missing"));
  assert.ok(codes.includes("release_gate_tiny_async_smoke_missing"));
  assert.ok(codes.includes("release_gate_tiny_public_async_smoke_missing"));
  assert.equal(codes.filter((code) => code === "non_bun_package_manager_script").length, 4);
  assert.equal(codes.filter((code) => code === "non_bun_workflow_package_manager").length, 2);
  assert.ok(codes.includes("workflow_bun_install_frozen_lockfile_missing"));
  assert.ok(codes.includes("unbounded_workflow_health_probe"));
  assert.ok(codes.includes("unbounded_workflow_curl_install"));
  assert.ok(codes.includes("workflow_curl_install_body_timeout_missing"));
  assert.ok(codes.includes("workflow_ssh_missing_keepalive"));
  assert.ok(codes.includes("workflow_public_caddy_auth_guard_missing"));
  assert.ok(codes.includes("workflow_public_caddy_domain_guard_missing"));
  assert.ok(codes.includes("workflow_caddy_env_override_missing"));
  assert.ok(codes.includes("workflow_memory_env_override_missing"));
  assert.ok(codes.includes("workflow_remote_storage_preflight_missing"));
  assert.ok(codes.includes("workflow_ready_timeout_env_override_missing"));
  assert.ok(codes.includes("workflow_readyz_snapshot_logging_missing"));
  assert.ok(codes.includes("workflow_resolved_env_persistence_missing"));
  assert.ok(codes.includes("workflow_caddy_binary_guard_missing"));
  assert.ok(codes.includes("workflow_service_user_parser_missing"));
  assert.ok(codes.includes("workflow_numeric_service_user_guard_missing"));
  assert.ok(codes.includes("workflow_secret_file_install_mode_missing"));
  assert.ok(codes.includes("workflow_recursive_state_chown"));
  assert.ok(codes.includes("workflow_recursive_checkout_chown"));
  assert.ok(codes.includes("workflow_root_command_timeout_missing"));
  assert.ok(codes.includes("workflow_apt_get_unbounded"));
  assert.ok(codes.includes("workflow_apt_cache_cleanup_missing"));
  assert.ok(codes.includes("workflow_rsync_session_timeout_missing"));
  assert.ok(codes.includes("workflow_rsync_timeout_missing"));
  assert.ok(codes.includes("workflow_rsync_checkout_chmod_missing"));
  assert.ok(codes.includes("workflow_recursive_checkout_chmod"));
  assert.ok(codes.includes("workflow_ssh_session_timeout_missing"));
  assert.ok(codes.includes("workflow_systemctl_timeout_missing"));
  assert.ok(codes.includes("workflow_journalctl_timeout_missing"));
  assert.ok(codes.includes("workflow_remote_bun_install_unbounded"));
  assert.ok(codes.includes("workflow_remote_bun_install_prune_missing"));
  assert.ok(codes.includes("workflow_remote_bun_install_umask_missing"));
  assert.ok(codes.includes("workflow_remote_bun_command_unbounded"));
  assert.ok(codes.includes("workflow_bun_version_probe_unbounded"));
  assert.ok(codes.includes("workflow_gateway_runtime_bun_install_missing"));
  assert.ok(codes.includes("workflow_gateway_runtime_env_override_missing"));
  assert.ok(codes.includes("workflow_ray_env_read_unbounded"));
  assert.ok(codes.includes("vps_readme_curl_install_unbounded"));
  assert.ok(codes.includes("vps_readme_apt_get_unbounded"));
  assert.ok(codes.includes("vps_readme_apt_cache_cleanup_missing"));
  assert.ok(codes.includes("vps_readme_command_timeout_missing"));
  assert.ok(codes.includes("vps_readme_git_clone_shallow_missing"));
  assert.ok(codes.includes("vps_readme_bun_install_unbounded"));
  assert.ok(codes.includes("vps_readme_ray_service_suffix_missing"));
  assert.ok(codes.includes("vps_readme_ray_helper_timeout_missing"));
  assert.ok(codes.includes("runtime_doc_bun_script_missing"));
  assert.equal(codes.filter((code) => code === "non_bun_runtime_doc_command").length, 6);
  assert.ok(codes.includes("non_bun_lockfile_present"));
});

test("validatePackageRuntimeCoverage matches release gate smoke steps exactly", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "release:gate": [
            "bun run smoke:tiny:public-async",
            "RAY_API_KEYS=smoke bun run validate:config:public",
          ].join(" && "),
        },
      },
      null,
      2,
    ),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.ok(codes.includes("release_gate_tiny_gateway_smoke_missing"));
  assert.ok(codes.includes("release_gate_tiny_public_smoke_missing"));
  assert.ok(codes.includes("release_gate_tiny_async_smoke_missing"));
  assert.ok(!codes.includes("release_gate_tiny_public_async_smoke_missing"));
  assert.ok(!codes.includes("release_gate_public_auth_validate_missing"));
});

test("validatePackageRuntimeCoverage requires release docs to list every tiny smoke", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-doc-smokes-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.9",
        engines: {
          bun: ">=1.3.0",
        },
        scripts: {
          "release:gate": [
            "RAY_API_KEYS=smoke bun run validate:config:public",
            "bun run smoke:tiny",
            "bun run smoke:tiny:public",
            "bun run smoke:tiny:async",
            "bun run smoke:tiny:public-async",
          ].join(" && "),
          "smoke:tiny": "bun ./scripts/gateway-smoke.ts",
          "smoke:tiny:public": "bun ./scripts/gateway-smoke.ts --public-safety",
          "smoke:tiny:async": "bun ./scripts/gateway-smoke.ts --async-queue",
          "smoke:tiny:public-async": "bun ./scripts/gateway-smoke.ts --public-safety --async-queue",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(tempDir, "README.md"),
    [
      "# Ray test",
      "",
      "`release:gate` runs `bun run smoke:tiny`, `bun run smoke:tiny:public`, and `bun run smoke:tiny:async`.",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "runtime_doc_release_gate_smoke_missing" &&
        diagnostic.message.includes("smoke:tiny:public-async"),
    ),
  );
});

test("validatePackageRuntimeCoverage requires timeouts for VPS Ray helper aliases", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-vps-timeout-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  const integrationDocDir = path.join(tempDir, "docs", "integrations");
  await mkdir(vpsDocDir, { recursive: true });
  await mkdir(integrationDocDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.0",
        engines: { bun: ">=1.3" },
        scripts: {
          "benchmark:assert:cx23:1b": "bun ./scripts/benchmark.ts",
          "deploy:storage": "bun ./scripts/deploy-storage-preflight.ts",
          "deploy:smoke": "bun ./scripts/deploy-smoke.ts",
          "doctor:1b:generic": "bun packages/deploy/dist/cli.js doctor",
          "doctor:hetzner-email-ai": "bun packages/deploy/dist/cli.js doctor",
          "model:stage:1b:generic": "bun packages/deploy/dist/cli.js model-stage",
          "validate:config:all": "bun ./scripts/validate-configs.ts --all",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(vpsDocDir, "README.md"),
    [
      "# VPS deploy",
      "",
      "```bash",
      "bun run doctor:1b:generic",
      "bun run deploy:storage",
      "timeout 300s bun run model:stage:1b:generic",
      "RAY_API_KEYS=smoke bun run validate:config:all",
      "timeout 1800s bun run benchmark:assert:cx23:1b",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(integrationDocDir, "razroo-email-ai.md"),
    ["# Integration", "", "```bash", "bun run doctor:hetzner-email-ai", "```", ""].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);
  const timeoutDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "vps_readme_ray_helper_timeout_missing",
  );

  assert.equal(summary.ok, false);
  assert.deepEqual(
    timeoutDiagnostics
      .map((diagnostic) => [
        diagnostic.docPath ? path.relative(tempDir, diagnostic.docPath) : "",
        diagnostic.line,
      ])
      .sort(),
    [
      ["docs/integrations/razroo-email-ai.md", 4],
      ["examples/deploy/vps/README.md", 4],
      ["examples/deploy/vps/README.md", 5],
      ["examples/deploy/vps/README.md", 7],
    ],
  );
});

test("validatePackageRuntimeCoverage requires privileges for root env-file helpers", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-vps-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  await mkdir(vpsDocDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify(
      {
        name: "ray-test",
        packageManager: "bun@1.3.0",
        engines: { bun: ">=1.3" },
        scripts: {
          "deploy:storage": "bun ./scripts/deploy-storage-preflight.ts",
          "doctor:1b:generic":
            "bun packages/deploy/dist/cli.js doctor --ray-env-file /etc/ray/ray.env",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(vpsDocDir, "README.md"),
    [
      "# VPS deploy",
      "",
      "```bash",
      "timeout 300s bun run doctor:1b:generic",
      "timeout 60s bun run deploy:storage -- --ray-env-file /etc/ray/ray.env",
      "timeout 120s bun packages/deploy/dist/cli.js render \\",
      "  --ray-env-file /etc/ray/ray.env",
      "timeout 300s sudo /usr/local/bin/bun run doctor:1b:generic",
      "timeout 60s sudo /usr/local/bin/bun run deploy:storage -- --ray-env-file /etc/ray/ray.env",
      "timeout 120s sudo /usr/local/bin/bun packages/deploy/dist/cli.js render \\",
      "  --ray-env-file /etc/ray/ray.env",
      "```",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);
  const privilegeDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "vps_readme_ray_env_helper_privileges_missing",
  );

  assert.equal(summary.ok, false);
  assert.deepEqual(
    privilegeDiagnostics.map((diagnostic) => diagnostic.line),
    [4, 5, 7],
  );
});

test("validatePackageRuntimeCoverage requires bounded curl probes in runtime docs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-vps-curl-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const integrationDocDir = path.join(tempDir, "docs", "integrations");
  await mkdir(integrationDocDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify({
      name: "ray-test",
      packageManager: "bun@1.3.0",
      engines: { bun: ">=1.3" },
    }),
  );
  await writeFile(
    path.join(integrationDocDir, "razroo-email-ai.md"),
    [
      "# Integration",
      "",
      "```bash",
      "curl -sS http://127.0.0.1:3000/v1/infer",
      "curl -fsS --connect-timeout 2 --max-time 30 http://127.0.0.1:3000/readyz",
      "curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 https://bun.sh/install | timeout 300s bash",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(tempDir, "README.md"),
    [
      "# Readme",
      "",
      "```bash",
      "curl -sS http://127.0.0.1:3000/v1/jobs",
      "curl -fsS --connect-timeout 2 --max-time 30 http://127.0.0.1:3000/livez",
      "```",
      "",
    ].join("\n"),
  );
  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);
  const vpsTimeoutDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "vps_readme_curl_timeout_missing",
  );
  const runtimeTimeoutDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "runtime_doc_curl_timeout_missing",
  );

  assert.equal(summary.ok, false);
  assert.deepEqual(
    vpsTimeoutDiagnostics.map((diagnostic) => diagnostic.line),
    [4],
  );
  assert.deepEqual(
    runtimeTimeoutDiagnostics.map((diagnostic) => diagnostic.line),
    [4],
  );
});

test("validatePackageRuntimeCoverage rejects documentation-domain callback URLs in executable docs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-callback-url-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify({
      name: "ray-test",
      packageManager: "bun@1.3.0",
      engines: { bun: ">=1.3" },
    }),
  );
  await writeFile(
    path.join(tempDir, "README.md"),
    [
      "# Readme",
      "",
      "```bash",
      "curl -fsS --connect-timeout 2 --max-time 30 http://127.0.0.1:3000/v1/jobs \\",
      "  -H 'content-type: application/json' \\",
      '  -d \'{"input":"Draft","callbackUrl":"https://example.com/ray-callback"}\'',
      "```",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(tempDir, "packages", "sdk"), { recursive: true });
  await writeFile(
    path.join(tempDir, "packages", "sdk", "README.md"),
    [
      "# SDK",
      "",
      "```typescript",
      "await client.createJob({",
      '  input: "Draft",',
      '  callbackUrl: "https://example.org/ray-callback",',
      "});",
      "```",
      "",
    ].join("\n"),
  );

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  const callbackDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "runtime_doc_example_callback_url",
  );
  assert.deepEqual(
    callbackDiagnostics.map((diagnostic) => path.relative(tempDir, diagnostic.docPath ?? "")),
    ["README.md", path.join("packages", "sdk", "README.md")],
  );
});

test("validatePackageRuntimeCoverage rejects oversized runtime coverage inputs", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-size-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  await mkdir(workflowDir, { recursive: true });
  await mkdir(vpsDocDir, { recursive: true });

  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(rootPackageJson, "x".repeat(512 * 1024 + 1));
  await writeFile(path.join(workflowDir, "quality.yml"), "x".repeat(512 * 1024 + 1));
  await writeFile(path.join(vpsDocDir, "README.md"), "x".repeat(512 * 1024 + 1));

  const summary = await validatePackageRuntimeCoverage({
    cwd: tempDir,
    packageJsonPaths: [rootPackageJson],
  });
  const diagnostics = summary.results.flatMap((result) => result.diagnostics);

  assert.equal(summary.ok, false);
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "package_json_invalid" &&
        /package\.json must be at most 524288 bytes/.test(diagnostic.message),
    ),
  );
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "workflow_invalid" &&
        /GitHub workflow must be at most 524288 bytes/.test(diagnostic.message),
    ),
  );
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "runtime_doc_invalid" &&
        /Runtime doc must be at most 524288 bytes/.test(diagnostic.message),
    ),
  );
});

test("collectPackageJsonPaths rejects excessive package manifests while streaming", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-many-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  for (let index = 0; index < 129; index += 1) {
    const packageDir = path.join(tempDir, `package-${String(index).padStart(3, "0")}`);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), "{}\n");
  }

  await assert.rejects(
    () => collectPackageJsonPaths(tempDir),
    /Repository must contain at most 128 package\.json files/,
  );
});

test("collectPackageJsonPaths rejects oversized direct roots before discovery", async () => {
  await assert.rejects(
    () => collectPackageJsonPaths(`/${"a".repeat(4096)}`),
    /cwd must be at most 4096 bytes/,
  );
});

test("validatePackageRuntimeCoverage rejects excessive workflow manifests while streaming", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-workflows-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const workflowDir = path.join(tempDir, ".github", "workflows");
  await mkdir(workflowDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify({ name: "ray-test", packageManager: "bun@1.3.0", engines: { bun: ">=1.3" } }),
  );

  for (let index = 0; index < 65; index += 1) {
    await writeFile(path.join(workflowDir, `quality-${String(index).padStart(3, "0")}.yml`), "");
  }

  await assert.rejects(
    () => validatePackageRuntimeCoverage({ cwd: tempDir, packageJsonPaths: [rootPackageJson] }),
    /Repository must contain at most 64 GitHub workflow files/,
  );
});

test("validatePackageRuntimeCoverage rejects excessive workspace README discovery", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-readmes-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const packagesDir = path.join(tempDir, "packages");
  await mkdir(packagesDir, { recursive: true });
  const rootPackageJson = path.join(tempDir, "package.json");
  await writeFile(
    rootPackageJson,
    JSON.stringify({ name: "ray-test", packageManager: "bun@1.3.0", engines: { bun: ">=1.3" } }),
  );

  for (let index = 0; index < 513; index += 1) {
    await mkdir(path.join(packagesDir, `package-${String(index).padStart(3, "0")}`));
  }

  await assert.rejects(
    () => validatePackageRuntimeCoverage({ cwd: tempDir, packageJsonPaths: [rootPackageJson] }),
    /Workspace runtime doc discovery visited more than 512 entries in packages/,
  );
});

test("formatTextSummary prints operator-readable runtime coverage results", async () => {
  const summary = await validatePackageRuntimeCoverage({
    cwd: repoRoot,
    packageJsonPaths: [path.join(repoRoot, "package.json")],
  });
  const text = formatTextSummary(repoRoot, summary);

  assert.match(text, /Checked 1 package manifest/);
  assert.match(text, /GitHub workflow/);
  assert.match(text, /runtime doc/);
  assert.match(text, /package\.json/);
  assert.match(text, /packageManager=bun@/);
  assert.match(text, /Summary: packages=1/);
});

test("runPackageRuntimeCoverageCli prints JSON coverage", async () => {
  let output = "";
  let errorOutput = "";
  const code = await runPackageRuntimeCoverageCli(["--cwd", repoRoot, "--json"], {
    stdout: { write: (chunk: string) => void (output += chunk) },
    stderr: { write: (chunk: string) => void (errorOutput += chunk) },
  } as Pick<NodeJS.Process, "stdout" | "stderr">);

  assert.equal(code, 0);
  assert.equal(errorOutput, "");
  const parsed = JSON.parse(output) as {
    ok?: boolean;
    packageCount?: number;
    workflowCount?: number;
    docCount?: number;
  };
  assert.equal(parsed.ok, true);
  assert.ok((parsed.packageCount ?? 0) >= 10);
  assert.ok((parsed.workflowCount ?? 0) >= 1);
  assert.ok((parsed.docCount ?? 0) >= 5);
});
