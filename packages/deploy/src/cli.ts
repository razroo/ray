import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAndDiagnoseDeployment, renderDeploymentBundle } from "./index.js";

export type Command = "render" | "validate" | "doctor";

export interface CliOptions {
  command: Command;
  cwd: string;
  configPath: string;
  user: string;
  domain: string;
  envFile?: string;
  outputDir?: string;
  memoryBudgetMiB?: number;
  nodeBinary?: string;
}

interface RenderedDeploymentFiles {
  service: string;
  caddyfile: string;
  envFileExample: string;
  summary: string;
  llamaCppService?: string;
}

const MAX_DEPLOY_ENV_FILE_BYTES = 64 * 1024;
const MAX_DEPLOY_ENV_ENTRIES = 512;
const MAX_DEPLOY_ENV_KEY_CHARS = 128;
const MAX_DEPLOY_ENV_VALUE_CHARS = MAX_DEPLOY_ENV_FILE_BYTES;
const unsafeDeployEnvKeys = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPLOY_CLI_ARGS = 64;
const MAX_DEPLOY_CLI_ARG_BYTES = 4_096;

function assertCliArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_DEPLOY_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_DEPLOY_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_DEPLOY_CLI_ARG_BYTES} bytes`);
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parsePositiveIntegerFlag(value: string, label: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function decodeDoubleQuotedEnvValue(value: string): string {
  return value.replace(/\\(["\\nrt])/g, (_match, escaped: string) => {
    if (escaped === "n") {
      return "\n";
    }

    if (escaped === "r") {
      return "\r";
    }

    if (escaped === "t") {
      return "\t";
    }

    return escaped;
  });
}

export function parseEnvironmentFile(contents: string): NodeJS.ProcessEnv {
  if (typeof contents !== "string") {
    throw new Error("Env file contents must be a string");
  }

  if (Buffer.byteLength(contents, "utf8") > MAX_DEPLOY_ENV_FILE_BYTES) {
    throw new Error(`Env file contents must be at most ${MAX_DEPLOY_ENV_FILE_BYTES} bytes`);
  }

  const env = Object.create(null) as NodeJS.ProcessEnv;
  const lines = contents.split(/\r?\n/);
  let entries = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      throw new Error(`Invalid env file line ${index + 1}: expected KEY=value`);
    }

    const key = line.slice(0, separatorIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env file line ${index + 1}: invalid variable name`);
    }

    if (unsafeDeployEnvKeys.has(key)) {
      throw new Error(`Invalid env file line ${index + 1}: unsafe variable name`);
    }

    if (key.length > MAX_DEPLOY_ENV_KEY_CHARS) {
      throw new Error(
        `Invalid env file line ${index + 1}: variable name must be at most ${MAX_DEPLOY_ENV_KEY_CHARS} characters`,
      );
    }

    entries += 1;
    if (entries > MAX_DEPLOY_ENV_ENTRIES) {
      throw new Error(`Env file must contain at most ${MAX_DEPLOY_ENV_ENTRIES} variables`);
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    let value = rawValue;
    const startsDoubleQuote = rawValue.startsWith('"');
    const endsDoubleQuote = rawValue.endsWith('"');
    const startsSingleQuote = rawValue.startsWith("'");
    const endsSingleQuote = rawValue.endsWith("'");

    if (startsDoubleQuote !== endsDoubleQuote || startsSingleQuote !== endsSingleQuote) {
      throw new Error(`Invalid env file line ${index + 1}: unterminated quoted value`);
    }

    if (startsDoubleQuote || startsSingleQuote) {
      value = rawValue.slice(1, -1);
      if (startsDoubleQuote) {
        value = decodeDoubleQuotedEnvValue(value);
      }
    }

    if (Buffer.byteLength(value, "utf8") > MAX_DEPLOY_ENV_VALUE_CHARS) {
      throw new Error(
        `Invalid env file line ${index + 1}: value must be at most ${MAX_DEPLOY_ENV_VALUE_CHARS} bytes`,
      );
    }

    env[key] = value;
  }

  return env;
}

async function readEnvironmentFileBounded(envFile: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(envFile, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`Env file path must be a file: ${envFile}`);
    }

    if (stats.size > MAX_DEPLOY_ENV_FILE_BYTES) {
      throw new Error(`Env file must be at most ${MAX_DEPLOY_ENV_FILE_BYTES} bytes: ${envFile}`);
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function loadEnvironment(options: CliOptions): Promise<NodeJS.ProcessEnv> {
  if (!options.envFile) {
    return process.env;
  }

  let contents: string;
  try {
    contents = await readEnvironmentFileBounded(options.envFile);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      throw new Error(`Env file not found: ${options.envFile}`);
    }
    throw error;
  }

  return {
    ...process.env,
    ...parseEnvironmentFile(contents),
  };
}

async function writeDeploymentBundleFiles(
  outputDir: string,
  bundle: Awaited<ReturnType<typeof renderDeploymentBundle>>,
): Promise<RenderedDeploymentFiles> {
  await mkdir(outputDir, { recursive: true });

  const files: RenderedDeploymentFiles = {
    service: path.join(outputDir, "ray-gateway.service"),
    caddyfile: path.join(outputDir, "Caddyfile"),
    envFileExample: path.join(outputDir, "ray.env.example"),
    summary: path.join(outputDir, "summary.json"),
  };

  await writeFile(files.service, bundle.service, "utf8");
  await writeFile(files.caddyfile, bundle.caddyfile, "utf8");
  await writeFile(files.envFileExample, bundle.envFileExample, "utf8");
  await writeFile(files.summary, `${JSON.stringify(bundle.summary, null, 2)}\n`, "utf8");

  if (bundle.llamaCppService) {
    files.llamaCppService = path.join(outputDir, "ray-llama-cpp.service");
    await writeFile(files.llamaCppService, bundle.llamaCppService, "utf8");
  } else {
    await rm(path.join(outputDir, "ray-llama-cpp.service"), { force: true });
  }

  return files;
}

export function parseCliArgs(argv: string[]): CliOptions {
  assertCliArgv(argv);

  let command: Command = "render";
  let index = 0;

  if (argv[0] === "render" || argv[0] === "validate" || argv[0] === "doctor") {
    command = argv[0];
    index = 1;
  } else if (argv[0] && !argv[0].startsWith("--")) {
    throw new Error(`Unknown command: ${argv[0]}`);
  }

  const options: CliOptions = {
    command,
    cwd: process.cwd(),
    configPath: "./examples/config/ray.sub1b.public.json",
    user: "ray",
    domain: "ray.local",
  };

  for (; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--") {
      continue;
    }

    if (current === "--cwd") {
      options.cwd = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--config") {
      options.configPath = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--user") {
      options.user = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--domain") {
      options.domain = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--env-file" || current === "--ray-env-file") {
      options.envFile = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--node-binary") {
      options.nodeBinary = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--output-dir") {
      options.outputDir = requireFlagValue(current, next);
      index += 1;
      continue;
    }

    if (current === "--memory-mib") {
      options.memoryBudgetMiB = parsePositiveIntegerFlag(
        requireFlagValue(current, next),
        "--memory-mib",
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${current}`);
  }

  return options;
}

export async function runCli(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const cwd = path.resolve(options.cwd);
  const resolvedOptions: CliOptions = {
    ...options,
    cwd,
    ...(options.envFile ? { envFile: path.resolve(cwd, options.envFile) } : {}),
  };
  const env = await loadEnvironment(resolvedOptions);

  if (resolvedOptions.command === "render") {
    const bundle = await renderDeploymentBundle({
      ...resolvedOptions,
      env,
    });

    if (resolvedOptions.outputDir) {
      const files = await writeDeploymentBundleFiles(resolvedOptions.outputDir, bundle);
      console.log(JSON.stringify({ files }, null, 2));
      return;
    }

    console.log("# Ray systemd service\n");
    console.log(bundle.service);
    if (bundle.llamaCppService) {
      console.log("\n# llama.cpp systemd service\n");
      console.log(bundle.llamaCppService);
    }
    console.log("\n# Caddyfile\n");
    console.log(bundle.caddyfile);
    console.log("\n# Environment File Example\n");
    console.log(bundle.envFileExample);
    console.log("\n# Summary\n");
    console.log(JSON.stringify(bundle.summary, null, 2));
  } else {
    const inspected = await loadAndDiagnoseDeployment({
      ...resolvedOptions,
      env,
      strictFilesystem: resolvedOptions.command === "doctor",
    });
    const hasErrors = inspected.diagnostics.some((diagnostic) => diagnostic.level === "error");

    console.log(
      JSON.stringify(
        {
          configPath: inspected.configPath,
          profile: inspected.config.profile,
          diagnostics: inspected.diagnostics,
        },
        null,
        2,
      ),
    );

    if (resolvedOptions.command === "doctor" && hasErrors) {
      process.exit(1);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
