import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import {
  normalizeGatewayRuntimeBinaryPath,
  normalizeRepoConfigPath,
  parseCliArgs,
  parseEnvironmentFile,
  runCli,
} from "./cli.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("parseCliArgs accepts strict memory budget overrides", () => {
  const options = parseCliArgs([
    "doctor",
    "--cwd",
    "/srv/ray",
    "--config",
    "./ray.json",
    "--memory-mib",
    "4096",
  ]);

  assert.equal(options.command, "doctor");
  assert.equal(options.cwd, "/srv/ray");
  assert.equal(options.configPath, "./ray.json");
  assert.equal(options.memoryBudgetMiB, 4096);
});

test("parseCliArgs accepts deploy help", () => {
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.equal(parseCliArgs(["render", "-h"]).help, true);
  assert.equal(parseCliArgs(["help"]).help, true);
});

test("normalizeRepoConfigPath resolves repo-relative deploy config paths", () => {
  assert.deepEqual(normalizeRepoConfigPath("./examples/config/ray.sub1b.public.json"), {
    configPath: "./examples/config/ray.sub1b.public.json",
    configRel: "examples/config/ray.sub1b.public.json",
  });

  assert.deepEqual(normalizeRepoConfigPath("examples/config/../config/ray.1b.public.json"), {
    configPath: "./examples/config/ray.1b.public.json",
    configRel: "examples/config/ray.1b.public.json",
  });
});

test("normalizeRepoConfigPath rejects paths that cannot be synced to the VPS", () => {
  assert.throws(
    () => normalizeRepoConfigPath("/etc/ray/ray.json", "RAY_CONFIG_PATH"),
    /repo-relative, not absolute/,
  );
  assert.throws(
    () => normalizeRepoConfigPath("../ray.json", "RAY_CONFIG_PATH"),
    /inside the repository/,
  );
  assert.throws(
    () => normalizeRepoConfigPath("examples/../../ray.json", "RAY_CONFIG_PATH"),
    /inside the repository/,
  );
  assert.throws(
    () => normalizeRepoConfigPath(".ray-deploy-config.json", "RAY_CONFIG_PATH"),
    /reserved \.ray-deploy-\*/,
  );
  assert.throws(
    () => normalizeRepoConfigPath(".github/workflows/deploy-vps.yml", "RAY_CONFIG_PATH"),
    /excluded from VPS repository sync/,
  );
  assert.throws(
    () => normalizeRepoConfigPath("examples\\config\\ray.json", "RAY_CONFIG_PATH"),
    /forward slashes/,
  );
  assert.throws(
    () => normalizeRepoConfigPath(" examples/config/ray.json", "RAY_CONFIG_PATH"),
    /without leading or trailing whitespace/,
  );
});

test("normalizeGatewayRuntimeBinaryPath resolves deploy runtime paths", () => {
  assert.equal(
    normalizeGatewayRuntimeBinaryPath("/usr/local/bin/../bin/bun"),
    "/usr/local/bin/bun",
  );
  assert.equal(normalizeGatewayRuntimeBinaryPath("/opt/ray runtimes/bun"), "/opt/ray runtimes/bun");
});

test("normalizeGatewayRuntimeBinaryPath rejects paths hidden from systemd services", () => {
  assert.throws(
    () => normalizeGatewayRuntimeBinaryPath("bun", "RAY_GATEWAY_RUNTIME_BINARY"),
    /absolute path/,
  );
  assert.throws(
    () => normalizeGatewayRuntimeBinaryPath("/home/ray/.bun/bin/bun", "RAY_GATEWAY_RUNTIME_BINARY"),
    /outside \/home, \/root, and \/run\/user/,
  );
  assert.throws(
    () => normalizeGatewayRuntimeBinaryPath("/root/.bun/bin/bun", "RAY_GATEWAY_RUNTIME_BINARY"),
    /outside \/home, \/root, and \/run\/user/,
  );
  assert.throws(
    () => normalizeGatewayRuntimeBinaryPath(" /usr/local/bin/bun", "RAY_GATEWAY_RUNTIME_BINARY"),
    /without leading or trailing whitespace/,
  );
  assert.throws(
    () =>
      normalizeGatewayRuntimeBinaryPath(
        `/usr/local/bin/bun${"\n"}ExecStart=/bin/false`,
        "RAY_GATEWAY_RUNTIME_BINARY",
      ),
    /control characters/,
  );
});

test("parseCliArgs rejects malformed memory budget overrides", () => {
  assert.throws(
    () => parseCliArgs(["doctor", "--memory-mib", "4096MiB"]),
    /--memory-mib must be a positive integer/,
  );

  assert.throws(
    () => parseCliArgs(["doctor", "--memory-mib", "1.5"]),
    /--memory-mib must be a positive integer/,
  );
});

test("parseCliArgs rejects malformed direct argv values", () => {
  assert.throws(() => parseCliArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseCliArgs(["doctor", 4096] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(
    () => parseCliArgs(Array.from({ length: 65 }, () => "--config")),
    /argv must contain at most 64 entries/,
  );
  assert.throws(
    () => parseCliArgs(["doctor", "--config", `ray${"\0"}.json`]),
    /argv\[2\] must not contain NUL bytes/,
  );
  assert.throws(
    () => parseCliArgs(["doctor", "--config", "x".repeat(4_097)]),
    /argv\[2\] must be at most 4096 bytes/,
  );
});

test("parseCliArgs rejects missing flag values", () => {
  assert.throws(() => parseCliArgs(["render", "--config"]), /--config requires a value/);
  assert.throws(
    () => parseCliArgs(["doctor", "--config", "--memory-mib", "4096"]),
    /--config requires a value/,
  );
});

test("parseCliArgs rejects unknown commands and options", () => {
  assert.throws(() => parseCliArgs(["docter", "--memory-mib", "4096"]), /Unknown command: docter/);
  assert.throws(() => parseCliArgs(["doctor", "--memory", "4096"]), /Unknown option: --memory/);
});

test("parseCliArgs tolerates a separator before known options", () => {
  const options = parseCliArgs(["doctor", "--", "--env-file", "/etc/ray/ray.env"]);

  assert.equal(options.command, "doctor");
  assert.equal(options.envFile, "/etc/ray/ray.env");
});

test("parseCliArgs accepts the Ray-specific env-file alias", () => {
  const options = parseCliArgs(["doctor", "--ray-env-file", "/etc/ray/ray.env"]);

  assert.equal(options.command, "doctor");
  assert.equal(options.envFile, "/etc/ray/ray.env");
});

test("parseCliArgs accepts render-only systemd env-file paths", () => {
  const options = parseCliArgs(["render", "--systemd-env-file", "/etc/ray/ray.env"]);

  assert.equal(options.command, "render");
  assert.equal(options.systemdEnvFile, "/etc/ray/ray.env");
});

test("parseCliArgs accepts render output directories", () => {
  const options = parseCliArgs(["render", "--output-dir", "/tmp/ray-render"]);

  assert.equal(options.command, "render");
  assert.equal(options.outputDir, "/tmp/ray-render");
});

test("parseCliArgs accepts explicit deploy domains", () => {
  const options = parseCliArgs(["render", "--domain", "ray.example.com"]);

  assert.equal(options.command, "render");
  assert.equal(options.domain, "ray.example.com");
});

test("parseCliArgs accepts explicit service users", () => {
  const options = parseCliArgs(["render", "--user", "ray_gpu"]);

  assert.equal(options.command, "render");
  assert.equal(options.user, "ray_gpu");
});

test("parseCliArgs rejects malformed service users", () => {
  assert.throws(
    () => parseCliArgs(["render", "--user", "ray deploy"]),
    /--user must be a system account name/,
  );
  assert.throws(
    () => parseCliArgs(["render", "--user", "%i"]),
    /--user must be a system account name/,
  );
  assert.throws(
    () => parseCliArgs(["render", "--user", "ray;root"]),
    /--user must be a system account name/,
  );
});

test("parseCliArgs accepts strict filesystem checks", () => {
  const options = parseCliArgs(["render", "--strict-filesystem"]);

  assert.equal(options.command, "render");
  assert.equal(options.strictFilesystem, true);
});

test("parseCliArgs accepts explicit gateway runtime binaries", () => {
  const options = parseCliArgs(["render", "--gateway-runtime-binary", "/usr/local/bin/bun"]);

  assert.equal(options.command, "render");
  assert.equal(options.runtimeBinary, "/usr/local/bin/bun");
});

test("parseCliArgs rejects relative gateway runtime binaries", () => {
  assert.throws(
    () => parseCliArgs(["render", "--gateway-runtime-binary", "bun"]),
    /--gateway-runtime-binary must be an absolute path/,
  );
});

test("parseCliArgs keeps --node-binary as a compatibility alias", () => {
  const options = parseCliArgs(["render", "--node-binary", "/opt/node 22/bin/node"]);

  assert.equal(options.command, "render");
  assert.equal(options.nodeBinary, "/opt/node 22/bin/node");
});

test("parseEnvironmentFile parses dotenv-style deployment overrides", () => {
  const env = parseEnvironmentFile(`
    # deployment overrides
    RAY_MODEL_ID=local-1b
    RAY_MODEL_PATH="/var/lib/ray/models/local 1b.gguf"
    RAY_MODEL_FAMILY='llama-compatible'
    RAY_MODEL_REF=local-1b
  `);

  assert.equal(env.RAY_MODEL_ID, "local-1b");
  assert.equal(env.RAY_MODEL_PATH, "/var/lib/ray/models/local 1b.gguf");
  assert.equal(env.RAY_MODEL_FAMILY, "llama-compatible");
  assert.equal(env.RAY_MODEL_REF, "local-1b");
});

test("parseEnvironmentFile rejects malformed deployment env lines", () => {
  assert.throws(
    () => parseEnvironmentFile(null as unknown as string),
    /Env file contents must be a string/,
  );
  assert.throws(() => parseEnvironmentFile("RAY_MODEL_ID\n"), /expected KEY=value/);
  assert.throws(() => parseEnvironmentFile("1MODEL=bad\n"), /invalid variable name/);
  assert.throws(() => parseEnvironmentFile('RAY_MODEL_ID="unterminated\n'), /unterminated/);
  assert.throws(
    () => parseEnvironmentFile(`${"_".repeat(129)}=bad\n`),
    /variable name must be at most 128 characters/,
  );
  assert.throws(() => parseEnvironmentFile("__proto__=polluted\n"), /unsafe variable name/);
  assert.throws(() => parseEnvironmentFile("constructor=polluted\n"), /unsafe variable name/);
  assert.throws(
    () =>
      parseEnvironmentFile(
        Array.from({ length: 513 }, (_value, index) => `RAY_VALUE_${index}=x`).join("\n"),
      ),
    /Env file must contain at most 512 variables/,
  );
  assert.throws(
    () => parseEnvironmentFile(`RAY_API_KEYS=${"x".repeat(64 * 1024)}\n`),
    /Env file contents must be at most 65536 bytes/,
  );
});

test("runCli rejects missing explicit env files", async () => {
  await assert.rejects(
    () => runCli(["render", "--ray-env-file", "missing.ray.env"]),
    /Env file not found:/,
  );
});

test("runCli rejects systemd env-file paths outside render", async () => {
  await assert.rejects(
    () => runCli(["doctor", "--systemd-env-file", "/etc/ray/ray.env"]),
    /--systemd-env-file is only supported by render/,
  );
});

test("runCli prints deploy help without loading config or env files", async (t) => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli(["render", "--help", "--ray-env-file", "missing.ray.env"]);

  const help = output.join("\n");
  assert.match(help, /Usage:/);
  assert.match(help, /render \[options\]/);
  assert.match(help, /--ray-env-file <path>/);
  assert.match(help, /--systemd-env-file <path>/);
  assert.match(help, /RAY_DEPLOY_MEMORY_MIB/);
});

test("runCli rejects oversized explicit env files before parsing", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-env-limit-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(envFile, `RAY_API_KEYS=${"x".repeat(64 * 1024)}\n`, "utf8");

  await assert.rejects(
    () =>
      runCli([
        "render",
        "--cwd",
        process.cwd(),
        "--config",
        "./examples/config/ray.1b.generic.public.json",
        "--ray-env-file",
        envFile,
      ]),
    /Env file must be at most 65536 bytes/,
  );
});

test("runCli render applies env-file overrides to generated llama.cpp service", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-cli-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    [
      "RAY_API_KEYS=test-key",
      "RAY_MODEL_ID=env-local-1b",
      "RAY_MODEL_REF=env-local-1b",
      "RAY_MODEL_PATH=/var/lib/ray/models/env-local-1b.gguf",
      "RAY_MODEL_FAMILY=llama-compatible",
      "RAY_MODEL_QUANTIZATION=q4_k_m",
      "RAY_GATEWAY_RUNTIME_BINARY=/opt/ray/bin/bun",
      "",
    ].join("\n"),
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
  ]);

  const rendered = output.join("\n");
  const llamaSection = rendered.split("# llama.cpp systemd service").at(1) ?? "";
  assert.match(rendered, /EnvironmentFile=.*ray\.env/);
  assert.match(rendered, /ExecStart=\/opt\/ray\/bin\/bun/);
  assert.match(rendered, /LLAMA_ARG_MODEL=\/var\/lib\/ray\/models\/env-local-1b\.gguf/);
  assert.match(rendered, /LLAMA_ARG_ALIAS=env-local-1b/);
  assert.doesNotMatch(llamaSection, /EnvironmentFile=.*ray\.env/);
});

test("runCli explicit gateway runtime flag overrides env-file runtime", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-runtime-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_GATEWAY_RUNTIME_BINARY=/opt/ray/bin/bun", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
    "--gateway-runtime-binary",
    "/usr/local/bin/bun",
  ]);

  const rendered = output.join("\n");
  assert.match(rendered, /ExecStart=\/usr\/local\/bin\/bun/);
  assert.doesNotMatch(rendered, /ExecStart=\/opt\/ray\/bin\/bun/);
});

test("runCli rejects malformed env-file gateway runtime paths", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-runtime-invalid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_GATEWAY_RUNTIME_BINARY=./bun", ""].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      runCli([
        "render",
        "--cwd",
        ".",
        "--config",
        "./examples/config/ray.1b.generic.public.json",
        "--ray-env-file",
        envFile,
        "--memory-mib",
        "4096",
      ]),
    /RAY_GATEWAY_RUNTIME_BINARY must be an absolute path/,
  );
});

test("runCli render applies env-file deploy domain to generated Caddyfile", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-domain-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_DOMAIN=ray.example.com", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
  ]);

  const rendered = output.join("\n");
  assert.match(rendered, /^ray\.example\.com \{/m);
});

test("runCli explicit deploy domain overrides env-file domain", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-domain-flag-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_DOMAIN=env.example.com", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
    "--domain",
    "cli.example.com",
  ]);

  const rendered = output.join("\n");
  assert.match(rendered, /^cli\.example\.com \{/m);
  assert.doesNotMatch(rendered, /^env\.example\.com \{/m);
});

test("runCli render applies env-file service user to generated systemd units", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-user-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_SERVICE_USER=ray_gpu", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
  ]);

  const rendered = output.join("\n");
  assert.match(rendered, /^User=ray_gpu$/m);
  assert.doesNotMatch(rendered, /^User=ray$/m);
});

test("runCli explicit service user overrides env-file service user", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-user-flag-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_SERVICE_USER=env_ray", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
    "--user",
    "cli_ray",
  ]);

  const rendered = output.join("\n");
  assert.match(rendered, /^User=cli_ray$/m);
  assert.doesNotMatch(rendered, /^User=env_ray$/m);
});

test("runCli explicit service user ignores malformed env-file service user", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-user-flag-invalid-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_SERVICE_USER=ray;root", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
    "--user",
    "cli_ray",
  ]);

  assert.match(output.join("\n"), /^User=cli_ray$/m);
});

test("runCli rejects malformed env-file service users", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-user-invalid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_SERVICE_USER=ray;root", ""].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      runCli([
        "validate",
        "--cwd",
        ".",
        "--config",
        "./examples/config/ray.sub1b.public.json",
        "--ray-env-file",
        envFile,
      ]),
    /RAY_DEPLOY_SERVICE_USER must be a system account name/,
  );
});

test("runCli render writes deployment files when output-dir is provided", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-files-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const outputDir = join(tempDir, "rendered");
  const envFile = join(tempDir, "ray.env");
  await writeFile(envFile, "RAY_API_KEYS=test-key\n", "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    tempDir,
    "--config",
    join(process.cwd(), "examples/config/ray.1b.generic.public.json"),
    "--env-file",
    "ray.env",
    "--memory-mib",
    "4096",
    "--gateway-runtime-binary",
    "/usr/local/bin/bun",
    "--output-dir",
    "rendered",
  ]);

  const service = await readFile(join(outputDir, "ray-gateway.service"), "utf8");
  const llamaService = await readFile(join(outputDir, "ray-llama-cpp.service"), "utf8");
  const caddyfile = await readFile(join(outputDir, "Caddyfile"), "utf8");
  const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"));
  const rendered = output.join("\n");

  assert.match(service, /Description=Ray Gateway/);
  assert.match(service, new RegExp(`WorkingDirectory=${escapeRegExp(tempDir)}`));
  assert.match(service, new RegExp(`EnvironmentFile=${escapeRegExp(envFile)}`));
  assert.match(service, /ExecStart=\/usr\/local\/bin\/bun/);
  assert.match(service, /Wants=ray-llama-cpp\.service/);
  assert.match(llamaService, /Description=llama\.cpp Server for Ray/);
  assert.doesNotMatch(llamaService, /EnvironmentFile=/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.equal(summary.profile, "1b");
  assert.equal(summary.preflight.memoryBudgetMiB, 4096);
  assert.equal(summary.preflight.memoryBudgetSource, "override");
  assert.equal(typeof summary.preflight.hostCpuCount, "number");
  assert.ok(summary.preflight.hostCpuCount >= 1);
  assert.deepEqual(summary.systemd.gateway, {
    memoryHighMiB: 640,
    memoryMaxMiB: 896,
    cpuWeight: 200,
  });
  assert.deepEqual(summary.systemd.llamaCpp, {
    memoryHighMiB: 2775,
    memoryMaxMiB: 3084,
    cpuWeight: 80,
  });
  assert.match(rendered, /ray-gateway\.service/);
  assert.doesNotMatch(rendered, /# Ray systemd service/);
});

test("runCli render can separate loaded env files from rendered systemd paths", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-systemd-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const outputDir = join(tempDir, "rendered");
  const loadedEnvFile = join(tempDir, "loaded.env");
  const systemdEnvFile = join(tempDir, "missing-systemd.env");
  await writeFile(loadedEnvFile, "RAY_API_KEYS=test-key\n", "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    tempDir,
    "--config",
    join(process.cwd(), "examples/config/ray.1b.generic.public.json"),
    "--env-file",
    loadedEnvFile,
    "--systemd-env-file",
    systemdEnvFile,
    "--memory-mib",
    "4096",
    "--gateway-runtime-binary",
    "/usr/local/bin/bun",
    "--output-dir",
    "rendered",
  ]);

  const service = await readFile(join(outputDir, "ray-gateway.service"), "utf8");
  const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"));
  const diagnosticCodes = summary.diagnostics.map(
    (diagnostic: { code: string }) => diagnostic.code,
  );

  assert.match(service, new RegExp(`EnvironmentFile=${escapeRegExp(systemdEnvFile)}`));
  assert.doesNotMatch(service, new RegExp(escapeRegExp(loadedEnvFile)));
  assert.equal(summary.preflight.envFilePath, systemdEnvFile);
  assert.equal(summary.preflight.envFileStatus, "missing");
  assert.ok(!diagnosticCodes.includes("env_file_missing"));
  assert.deepEqual(
    summary.diagnostics
      .filter((diagnostic: { level: string }) => diagnostic.level === "error")
      .map((diagnostic: { code: string }) => diagnostic.code),
    [],
  );
  assert.match(output.join("\n"), /ray-gateway\.service/);
});

test("runCli render allows systemd env-file paths before secrets exist locally", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-systemd-env-only-"));
  const originalApiKeys = process.env.RAY_API_KEYS;
  const originalAuthApiKeyEnv = process.env.RAY_AUTH_API_KEY_ENV;
  delete process.env.RAY_API_KEYS;
  delete process.env.RAY_AUTH_API_KEY_ENV;
  t.after(async () => {
    if (originalApiKeys === undefined) {
      delete process.env.RAY_API_KEYS;
    } else {
      process.env.RAY_API_KEYS = originalApiKeys;
    }

    if (originalAuthApiKeyEnv === undefined) {
      delete process.env.RAY_AUTH_API_KEY_ENV;
    } else {
      process.env.RAY_AUTH_API_KEY_ENV = originalAuthApiKeyEnv;
    }

    await rm(tempDir, { recursive: true, force: true });
  });
  const outputDir = join(tempDir, "rendered");
  const systemdEnvFile = join(tempDir, "missing-systemd.env");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    tempDir,
    "--config",
    join(process.cwd(), "examples/config/ray.sub1b.public.json"),
    "--systemd-env-file",
    systemdEnvFile,
    "--gateway-runtime-binary",
    "/usr/local/bin/bun",
    "--output-dir",
    "rendered",
  ]);

  const service = await readFile(join(outputDir, "ray-gateway.service"), "utf8");
  const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"));
  const diagnosticCodes = summary.diagnostics.map(
    (diagnostic: { code: string }) => diagnostic.code,
  );

  assert.match(service, new RegExp(`EnvironmentFile=${escapeRegExp(systemdEnvFile)}`));
  assert.ok(diagnosticCodes.includes("auth_keys_unverified"));
  assert.ok(!diagnosticCodes.includes("auth_keys_missing"));
  assert.deepEqual(
    summary.diagnostics
      .filter((diagnostic: { level: string }) => diagnostic.level === "error")
      .map((diagnostic: { code: string }) => diagnostic.code),
    [],
  );
  assert.match(output.join("\n"), /ray-gateway\.service/);
});

test("runCli render refuses to write deployment files when diagnostics contain errors", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-render-errors-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.json");
  const envFile = join(tempDir, "ray.env");
  const outputDir = join(tempDir, "rendered");
  const config = mergeConfig(createDefaultConfig("1b"), {
    server: {
      host: "0.0.0.0",
    },
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(envFile, "RAY_API_KEYS=test-key\n", "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await assert.rejects(
    () =>
      runCli([
        "render",
        "--cwd",
        tempDir,
        "--config",
        configPath,
        "--ray-env-file",
        envFile,
        "--output-dir",
        outputDir,
      ]),
    /Refusing to render deployment with 1 error diagnostic\(s\): gateway_bind_host_public/,
  );

  await assert.rejects(
    () => readFile(join(outputDir, "ray-gateway.service"), "utf8"),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
  );
  assert.deepEqual(output, []);
});

test("runCli render strict-filesystem refuses to write when host checks fail", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-render-strict-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.json");
  const outputDir = join(tempDir, "rendered");
  await writeFile(configPath, `${JSON.stringify(createDefaultConfig("tiny"), null, 2)}\n`, "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await assert.rejects(
    () =>
      runCli([
        "render",
        "--cwd",
        tempDir,
        "--config",
        configPath,
        "--user",
        "ray_missing_strict_user",
        "--gateway-runtime-binary",
        process.execPath,
        "--strict-filesystem",
        "--output-dir",
        outputDir,
      ]),
    /service_user_missing/,
  );

  await assert.rejects(
    () => readFile(join(outputDir, "ray-gateway.service"), "utf8"),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
  );
  assert.deepEqual(output, []);
});

test("runCli render allows non-strict host storage warnings", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-render-storage-warning-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.json");
  const outputDir = join(tempDir, "rendered");
  const config = mergeConfig(createDefaultConfig("vps"), {
    asyncQueue: {
      enabled: true,
      storageDir: join(tempDir, "async-queue"),
      minFreeStorageMiB: 1_048_576,
    },
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    tempDir,
    "--config",
    configPath,
    "--gateway-runtime-binary",
    process.execPath,
    "--output-dir",
    outputDir,
  ]);

  const summary = JSON.parse(await readFile(join(outputDir, "summary.json"), "utf8"));
  const storageDiagnostic = summary.diagnostics.find(
    (diagnostic: { code?: unknown }) => diagnostic.code === "async_queue_storage_low",
  );
  assert.ok(storageDiagnostic);
  assert.equal(storageDiagnostic.level, "warn");
  assert.match(output.join("\n"), /ray-gateway\.service/);
});

test("runCli validate prints deployment preflight details", async (t) => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "validate",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.generic.public.json",
    "--memory-mib",
    "4096",
  ]);

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.profile, "1b");
  assert.equal(parsed.preflight.memoryBudgetMiB, 4096);
  assert.equal(parsed.preflight.memoryBudgetSource, "override");
  assert.ok(Array.isArray(parsed.diagnostics));
});

test("runCli validate applies env-file memory budget", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-memory-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_MEMORY_MIB=8192", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "validate",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.8gb.generic.public.json",
    "--ray-env-file",
    envFile,
  ]);

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.preflight.memoryBudgetMiB, 8192);
  assert.equal(parsed.preflight.memoryBudgetSource, "override");
});

test("runCli explicit memory flag overrides env-file memory budget", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-memory-flag-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_MEMORY_MIB=8192", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "validate",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.8gb.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
  ]);

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.preflight.memoryBudgetMiB, 4096);
  assert.equal(parsed.preflight.memoryBudgetSource, "override");
});

test("runCli explicit memory flag ignores malformed env-file memory budget", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-memory-flag-invalid-env-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const envFile = join(tempDir, "ray.env");
  await writeFile(
    envFile,
    ["RAY_API_KEYS=test-key", "RAY_DEPLOY_MEMORY_MIB=8192MiB", ""].join("\n"),
    "utf8",
  );

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "validate",
    "--cwd",
    ".",
    "--config",
    "./examples/config/ray.1b.8gb.generic.public.json",
    "--ray-env-file",
    envFile,
    "--memory-mib",
    "4096",
  ]);

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.preflight.memoryBudgetMiB, 4096);
  assert.equal(parsed.preflight.memoryBudgetSource, "override");
});

test("runCli validate strict-filesystem prints host check diagnostics", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-validate-strict-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configPath = join(tempDir, "ray.json");
  await writeFile(configPath, `${JSON.stringify(createDefaultConfig("tiny"), null, 2)}\n`, "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "validate",
    "--cwd",
    tempDir,
    "--config",
    configPath,
    "--user",
    "ray_missing_strict_user",
    "--gateway-runtime-binary",
    process.execPath,
    "--strict-filesystem",
  ]);

  const parsed = JSON.parse(output.join("\n"));
  assert.equal(parsed.preflight.serviceUserStatus, "missing");
  assert.ok(
    parsed.diagnostics.some(
      (diagnostic: { code?: unknown }) => diagnostic.code === "service_user_missing",
    ),
  );
});

test("runCli render removes stale llama.cpp service files from reused output directories", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "ray-deploy-stale-files-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const outputDir = join(tempDir, "rendered");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "ray-llama-cpp.service"), "stale generated unit\n", "utf8");

  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output.push(values.map((value) => String(value)).join(" "));
  };
  t.after(() => {
    console.log = originalLog;
  });

  await runCli([
    "render",
    "--cwd",
    process.cwd(),
    "--config",
    "./examples/config/ray.vps.json",
    "--output-dir",
    outputDir,
  ]);

  await assert.rejects(
    () => readFile(join(outputDir, "ray-llama-cpp.service"), "utf8"),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
  );
  const service = await readFile(join(outputDir, "ray-gateway.service"), "utf8");
  assert.match(service, /Description=Ray Gateway/);
  assert.doesNotMatch(output.join("\n"), /ray-llama-cpp\.service/);
});
