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
const PUBLIC_SAFETY_API_KEY = "ray-gateway-smoke";

export interface GatewaySmokeArgs {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs: number;
  publicSafety: boolean;
  json: boolean;
  help: boolean;
}

export interface GatewayPublicSafetySummary {
  livezUnauthStatus: number;
  readyzUnauthStatus: number;
  protectedMissingStatuses: Record<string, number>;
  protectedInvalidStatuses: Record<string, number>;
  protectedValidStatuses: Record<string, number>;
  rateLimitStatus: number;
}

export interface GatewaySmokeSummary {
  ok: boolean;
  mode: "basic" | "public-safety";
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
  publicSafety?: GatewayPublicSafetySummary;
}

interface JsonResponse {
  status: number;
  payload: unknown;
}

interface TextResponse {
  status: number;
  text: string;
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
  --public-safety      Enable auth and rate limiting, then verify public-facing route guards.
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
    publicSafety: false,
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

    if (current === "--public-safety") {
      args.publicSafety = true;
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

function enablePublicSafetyConfig(config: RayConfig): RayConfig {
  const next = structuredClone(config) as RayConfig;
  next.auth.enabled = true;
  next.auth.apiKeyEnv = "RAY_API_KEYS";
  next.rateLimit.enabled = true;
  next.rateLimit.maxRequests = 1;
  next.rateLimit.windowMs = 60_000;
  next.rateLimit.keyStrategy = "api-key";
  next.rateLimit.trustProxyHeaders = false;
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
  const response = await fetchText(url, init, timeoutMs, label);

  try {
    return {
      status: response.status,
      payload: response.text.length > 0 ? JSON.parse(response.text) : undefined,
    };
  } catch (error) {
    throw new Error(
      `${label} returned non-JSON response body: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function fetchText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<TextResponse> {
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

    return {
      status: response.status,
      text,
    };
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

function assertTextStatus(result: TextResponse, label: string, expected: number): void {
  if (result.status !== expected) {
    throw new Error(`${label} returned HTTP ${result.status}, expected HTTP ${expected}`);
  }
}

function protectedEndpointRequest(
  pathName: string,
  token?: string,
): { path: string; init: RequestInit } {
  const headers: Record<string, string> = {};

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (pathName === "/v1/infer") {
    headers["content-type"] = "application/json";
    return {
      path: pathName,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: "Public safety smoke.",
          maxTokens: 16,
        }),
      },
    };
  }

  return {
    path: pathName,
    init: {
      method: "GET",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  };
}

async function smokePublicSafety(options: { baseUrl: string; timeoutMs: number }): Promise<{
  summary: GatewayPublicSafetySummary;
  inferStatus: number;
  outputChars: number;
}> {
  const protectedPaths = ["/v1/infer", "/health", "/metrics", "/v1/config"];
  const protectedMissingStatuses: Record<string, number> = {};
  const protectedInvalidStatuses: Record<string, number> = {};
  const protectedValidStatuses: Record<string, number> = {};
  const livez = await fetchJson(
    `${options.baseUrl}/livez`,
    { method: "GET" },
    options.timeoutMs,
    "/livez public safety",
  );
  assertStatusOk(livez, "/livez public safety");
  const readyz = await waitForStatusOk(
    `${options.baseUrl}/readyz`,
    { method: "GET" },
    options.timeoutMs,
    "/readyz public safety",
  );

  for (const pathName of protectedPaths) {
    const missing = protectedEndpointRequest(pathName);
    const missingResponse = await fetchText(
      `${options.baseUrl}${missing.path}`,
      missing.init,
      options.timeoutMs,
      `${pathName} missing auth`,
    );
    assertTextStatus(missingResponse, `${pathName} missing auth`, 401);
    protectedMissingStatuses[pathName] = missingResponse.status;

    const invalid = protectedEndpointRequest(pathName, "wrong-token");
    const invalidResponse = await fetchText(
      `${options.baseUrl}${invalid.path}`,
      invalid.init,
      options.timeoutMs,
      `${pathName} invalid auth`,
    );
    assertTextStatus(invalidResponse, `${pathName} invalid auth`, 401);
    protectedInvalidStatuses[pathName] = invalidResponse.status;
  }

  for (const pathName of ["/health", "/metrics", "/v1/config"]) {
    const valid = protectedEndpointRequest(pathName, PUBLIC_SAFETY_API_KEY);
    const validResponse = await fetchText(
      `${options.baseUrl}${valid.path}`,
      valid.init,
      options.timeoutMs,
      `${pathName} valid auth`,
    );
    assertTextStatus(validResponse, `${pathName} valid auth`, 200);
    protectedValidStatuses[pathName] = validResponse.status;
  }

  const infer = protectedEndpointRequest("/v1/infer", PUBLIC_SAFETY_API_KEY);
  const inferResponse = await fetchJson(
    `${options.baseUrl}${infer.path}`,
    infer.init,
    options.timeoutMs,
    "/v1/infer valid auth",
  );
  assertStatusOk(inferResponse, "/v1/infer valid auth");
  protectedValidStatuses["/v1/infer"] = inferResponse.status;
  const output = requireInferenceOutput(inferResponse.payload);

  const rateLimited = protectedEndpointRequest("/v1/infer", PUBLIC_SAFETY_API_KEY);
  const rateLimitedResponse = await fetchText(
    `${options.baseUrl}${rateLimited.path}`,
    rateLimited.init,
    options.timeoutMs,
    "/v1/infer rate limited",
  );
  assertTextStatus(rateLimitedResponse, "/v1/infer rate limited", 429);

  return {
    summary: {
      livezUnauthStatus: livez.status,
      readyzUnauthStatus: readyz.status,
      protectedMissingStatuses,
      protectedInvalidStatuses,
      protectedValidStatuses,
      rateLimitStatus: rateLimitedResponse.status,
    },
    inferStatus: inferResponse.status,
    outputChars: output.length,
  };
}

export async function smokeGateway(options: {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs?: number;
  publicSafety?: boolean;
}): Promise<GatewaySmokeSummary> {
  const cwd = path.resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configEnv = Object.create(null) as NodeJS.ProcessEnv;
  const loaded = await loadRayConfig({
    cwd,
    configPath: options.configPath,
    env: configEnv,
  });
  const port = options.port ?? (await reserveTcpPort(options.host));
  const baseConfig = cloneConfigForSmoke(loaded.config, options.host, port);
  const config = options.publicSafety ? enablePublicSafetyConfig(baseConfig) : baseConfig;
  const baseUrl = `http://${formatHostForUrl(options.host)}:${port}`;
  const gateway = await startGateway({
    config,
    configPath: loaded.configPath,
    logger: silentLogger,
    env: options.publicSafety ? { RAY_API_KEYS: PUBLIC_SAFETY_API_KEY } : configEnv,
    warmupRetry: {
      initialDelayMs: 100,
      maxDelayMs: 250,
    },
  });

  try {
    if (options.publicSafety) {
      const publicSafety = await smokePublicSafety({
        baseUrl,
        timeoutMs,
      });

      return {
        ok: true,
        mode: "public-safety",
        configPath: loaded.configPath ?? path.resolve(cwd, options.configPath),
        profile: config.profile,
        modelId: config.model.id,
        host: options.host,
        port,
        baseUrl,
        livezStatus: publicSafety.summary.livezUnauthStatus,
        readyzStatus: publicSafety.summary.readyzUnauthStatus,
        inferStatus: publicSafety.inferStatus,
        outputChars: publicSafety.outputChars,
        publicSafety: publicSafety.summary,
      };
    }

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
      mode: "basic",
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
  const lines = [
    "Ran Ray tiny gateway smoke:",
    `- config: ${displayPath(cwd, summary.configPath)}`,
    `- listen: ${summary.baseUrl}`,
    `- mode: ${summary.mode}`,
    `- profile: ${summary.profile}`,
    `- model: ${summary.modelId}`,
    `- livez: HTTP ${summary.livezStatus}`,
    `- readyz: HTTP ${summary.readyzStatus}`,
    `- infer: HTTP ${summary.inferStatus}, outputChars=${summary.outputChars}`,
  ];

  if (summary.publicSafety) {
    lines.push(
      `- protected missing auth: ${Object.values(summary.publicSafety.protectedMissingStatuses).join(", ")}`,
      `- protected invalid auth: ${Object.values(summary.publicSafety.protectedInvalidStatuses).join(", ")}`,
      `- protected valid auth: ${Object.values(summary.publicSafety.protectedValidStatuses).join(", ")}`,
      `- rate limit: HTTP ${summary.publicSafety.rateLimitStatus}`,
    );
  }

  lines.push(`Summary: ${summary.ok ? "ok" : "failed"}`);

  return lines.join("\n");
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
      publicSafety: args.publicSafety,
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
