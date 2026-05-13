import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRayConfig } from "../packages/config/src/index.ts";
import type { RayConfig } from "../packages/core/src/types.ts";
import { startGateway, stopGateway } from "../apps/gateway/src/index.ts";
import type { Logger } from "../packages/telemetry/src/index.ts";

const DEFAULT_CONFIG_PATH = "./examples/config/ray.tiny.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CLI_ARGS = 14;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_TEXT_BYTES = 256 * 1024;

export interface GatewaySmokeArgs {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs: number;
  json: boolean;
  help: boolean;
}

export interface GatewaySmokeSummary {
  ok: boolean;
  configPath: string;
  profile: string;
  modelId: string;
  host: string;
  port: number;
  baseUrl: string;
  livezStatus: number;
  readyzStatus: number;
  inferStatus: number;
  outputChars: number;
}

interface JsonResponse {
  status: number;
  payload: unknown;
}

const HELP = `Run a loopback Ray gateway smoke using the tiny mock-provider profile.

Usage:
  bun ./scripts/gateway-smoke.ts [options]

Options:
  --cwd <path>         Repository root. Default: current directory.
  --config <path>      Ray config to load. Default: ${DEFAULT_CONFIG_PATH}
  --host <host>        Loopback host to bind and probe. Default: ${DEFAULT_HOST}
  --port <port>        TCP port to bind. Default: reserve an ephemeral port.
  --timeout-ms <ms>    Per-check timeout budget. Default: ${DEFAULT_TIMEOUT_MS}
  --json               Print machine-readable summary JSON.
  -h, --help           Show this help.
`;

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

function assertArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_CLI_ARG_BYTES} bytes`);
    }
  }
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parsePositiveInteger(value: string, label: string, maximum: number): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (
    !/^\d+$/.test(normalized) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > maximum
  ) {
    throw new Error(`${label} must be a positive integer less than or equal to ${maximum}`);
  }

  return parsed;
}

export function parseArgs(argv: string[]): GatewaySmokeArgs {
  assertArgv(argv);

  const args: GatewaySmokeArgs = {
    cwd: process.cwd(),
    configPath: DEFAULT_CONFIG_PATH,
    host: DEFAULT_HOST,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--cwd") {
      args.cwd = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--config") {
      args.configPath = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--host") {
      args.host = requireFlagValue(current, argv[index + 1]);
      index += 1;
      continue;
    }

    if (current === "--port") {
      args.port = parsePositiveInteger(requireFlagValue(current, argv[index + 1]), current, 65_535);
      index += 1;
      continue;
    }

    if (current === "--timeout-ms") {
      args.timeoutMs = parsePositiveInteger(
        requireFlagValue(current, argv[index + 1]),
        current,
        MAX_TIMEOUT_MS,
      );
      index += 1;
      continue;
    }

    if (current === "--json") {
      args.json = true;
      continue;
    }

    if (current === "-h" || current === "--help") {
      args.help = true;
      continue;
    }

    if (current?.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current ?? ""}`);
  }

  return args;
}

function reserveTcpPort(host: string): Promise<number> {
  const server = createTcpServer();

  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => undefined);
        reject(new Error("Expected a TCP server address while reserving a smoke-test port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function cloneConfigForSmoke(config: RayConfig, host: string, port: number): RayConfig {
  const next = structuredClone(config) as RayConfig;
  next.server.host = host;
  next.server.port = port;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInferenceOutput(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.output !== "string" || payload.output.length === 0) {
    throw new Error("inference smoke returned a JSON payload without a non-empty output string");
  }

  return payload.output;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();

    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_TEXT_BYTES) {
      throw new Error(`${label} returned more than ${MAX_RESPONSE_TEXT_BYTES} bytes`);
    }

    try {
      return {
        status: response.status,
        payload: text.length > 0 ? JSON.parse(text) : undefined,
      };
    } catch (error) {
      throw new Error(
        `${label} returned non-JSON response body: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForStatusOk(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<JsonResponse> {
  const startedAt = Date.now();
  let lastStatus: number | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const result = await fetchJson(url, init, Math.min(1_000, remainingMs), label);
    lastStatus = result.status;

    if (result.status === 200) {
      return result;
    }

    await sleep(50);
  }

  throw new Error(
    `${label} did not return HTTP 200 within ${timeoutMs}ms${
      lastStatus === undefined ? "" : `; last status was ${lastStatus}`
    }`,
  );
}

function assertStatusOk(result: JsonResponse, label: string): void {
  if (result.status !== 200) {
    throw new Error(`${label} returned HTTP ${result.status}, expected HTTP 200`);
  }
}

export async function smokeGateway(options: {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs?: number;
}): Promise<GatewaySmokeSummary> {
  const cwd = path.resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loaded = await loadRayConfig({
    cwd,
    configPath: options.configPath,
  });
  const port = options.port ?? (await reserveTcpPort(options.host));
  const config = cloneConfigForSmoke(loaded.config, options.host, port);
  const baseUrl = `http://${formatHostForUrl(options.host)}:${port}`;
  const gateway = await startGateway({
    config,
    configPath: loaded.configPath,
    logger: silentLogger,
    warmupRetry: {
      initialDelayMs: 100,
      maxDelayMs: 250,
    },
  });

  try {
    const livez = await fetchJson(`${baseUrl}/livez`, { method: "GET" }, timeoutMs, "/livez");
    assertStatusOk(livez, "/livez");

    const readyz = await waitForStatusOk(
      `${baseUrl}/readyz`,
      { method: "GET" },
      timeoutMs,
      "/readyz",
    );
    const infer = await fetchJson(
      `${baseUrl}/v1/infer`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: "Smoke test.",
          maxTokens: 16,
        }),
      },
      timeoutMs,
      "/v1/infer",
    );
    assertStatusOk(infer, "/v1/infer");
    const output = requireInferenceOutput(infer.payload);

    return {
      ok: true,
      configPath: loaded.configPath ?? path.resolve(cwd, options.configPath),
      profile: config.profile,
      modelId: config.model.id,
      host: options.host,
      port,
      baseUrl,
      livezStatus: livez.status,
      readyzStatus: readyz.status,
      inferStatus: infer.status,
      outputChars: output.length,
    };
  } finally {
    await stopGateway(gateway, { timeoutMs: 1_000 });
  }
}

function displayPath(cwd: string, filePath: string): string {
  const relativePath = path.relative(cwd, filePath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

export function formatTextSummary(cwd: string, summary: GatewaySmokeSummary): string {
  return [
    "Ran Ray tiny gateway smoke:",
    `- config: ${displayPath(cwd, summary.configPath)}`,
    `- listen: ${summary.baseUrl}`,
    `- profile: ${summary.profile}`,
    `- model: ${summary.modelId}`,
    `- livez: HTTP ${summary.livezStatus}`,
    `- readyz: HTTP ${summary.readyzStatus}`,
    `- infer: HTTP ${summary.inferStatus}, outputChars=${summary.outputChars}`,
    `Summary: ${summary.ok ? "ok" : "failed"}`,
  ].join("\n");
}

export async function runGatewaySmokeCli(
  argv = process.argv.slice(2),
  io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      io.stdout.write(HELP);
      return 0;
    }

    const cwd = path.resolve(args.cwd);
    const summary = await smokeGateway({
      cwd,
      configPath: args.configPath,
      host: args.host,
      ...(args.port ? { port: args.port } : {}),
      timeoutMs: args.timeoutMs,
    });

    io.stdout.write(
      args.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatTextSummary(cwd, summary)}\n`,
    );
    return summary.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runGatewaySmokeCli();
}
