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
  assert.ok(summary.docCount >= 5);
  assert.ok(summary.scriptCount > 0);
  assert.equal(summary.forbiddenLockfiles.length, 0);
  assert.ok(
    summary.results.some(
      (result) =>
        result.packagePath === path.join(repoRoot, "package.json") &&
        result.packageManager?.startsWith("bun@"),
    ),
  );
});

test("validatePackageRuntimeCoverage catches non-Bun scripts and lockfiles", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-package-runtime-coverage-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const appDir = path.join(tempDir, "apps", "gateway");
  const workflowDir = path.join(tempDir, ".github", "workflows");
  const vpsDocDir = path.join(tempDir, "examples", "deploy", "vps");
  const integrationDocDir = path.join(tempDir, "docs", "integrations");
  await mkdir(appDir, { recursive: true });
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
    ["# Ray test", "", "```bash", "pnpm install", "```", ""].join("\n"),
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
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: printf secret | sudo tee /etc/ray/ray.env >/dev/null",
      "      - run: sudo apt-get install -y curl",
      "      - run: sudo chown -R ray:ray /var/lib/ray",
      "      - run: rsync -az --delete ./ ray@example:/srv/ray/",
      "      - run: ssh ray@example.com 'bash -s'",
      "      - run: /usr/local/bin/bun install --production --frozen-lockfile --ignore-scripts",
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
  assert.equal(codes.filter((code) => code === "non_bun_package_manager_script").length, 4);
  assert.equal(codes.filter((code) => code === "non_bun_workflow_package_manager").length, 2);
  assert.ok(codes.includes("workflow_bun_install_frozen_lockfile_missing"));
  assert.ok(codes.includes("unbounded_workflow_health_probe"));
  assert.ok(codes.includes("unbounded_workflow_curl_install"));
  assert.ok(codes.includes("workflow_curl_install_body_timeout_missing"));
  assert.ok(codes.includes("workflow_ssh_missing_keepalive"));
  assert.ok(codes.includes("workflow_public_caddy_auth_guard_missing"));
  assert.ok(codes.includes("workflow_public_caddy_domain_guard_missing"));
  assert.ok(codes.includes("workflow_secret_file_install_mode_missing"));
  assert.ok(codes.includes("workflow_recursive_state_chown"));
  assert.ok(codes.includes("workflow_root_command_timeout_missing"));
  assert.ok(codes.includes("workflow_apt_get_unbounded"));
  assert.ok(codes.includes("workflow_rsync_session_timeout_missing"));
  assert.ok(codes.includes("workflow_rsync_timeout_missing"));
  assert.ok(codes.includes("workflow_ssh_session_timeout_missing"));
  assert.ok(codes.includes("workflow_systemctl_timeout_missing"));
  assert.ok(codes.includes("workflow_journalctl_timeout_missing"));
  assert.ok(codes.includes("workflow_remote_bun_install_unbounded"));
  assert.ok(codes.includes("workflow_remote_bun_command_unbounded"));
  assert.ok(codes.includes("workflow_bun_version_probe_unbounded"));
  assert.ok(codes.includes("workflow_ray_env_read_unbounded"));
  assert.ok(codes.includes("vps_readme_curl_install_unbounded"));
  assert.ok(codes.includes("vps_readme_apt_get_unbounded"));
  assert.ok(codes.includes("vps_readme_command_timeout_missing"));
  assert.ok(codes.includes("vps_readme_bun_install_unbounded"));
  assert.ok(codes.includes("vps_readme_ray_service_suffix_missing"));
  assert.equal(codes.filter((code) => code === "non_bun_runtime_doc_command").length, 4);
  assert.ok(codes.includes("non_bun_lockfile_present"));
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
