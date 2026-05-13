import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRayConfig } from "../packages/config/src/index.ts";
import type { RayConfig } from "../packages/core/src/types.ts";
import { startGateway, stopGateway } from "../apps/gateway/src/index.ts";
import type { Logger } from "../packages/telemetry/src/index.ts";

const DEFAULT_CONFIG_PATH = "./examples/config/ray.tiny.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CLI_ARGS = 16;
const MAX_CLI_ARG_BYTES = 4_096;
const MAX_GATEWAY_SMOKE_PATH_BYTES = 4_096;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_TEXT_BYTES = 256 * 1024;
const PUBLIC_SAFETY_API_KEY = "ray-gateway-smoke";
const ASYNC_QUEUE_JOB_INPUT = "Async queue smoke.";

export interface GatewaySmokeArgs {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs: number;
  publicSafety: boolean;
  asyncQueue: boolean;
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

export interface GatewayAsyncQueueSummary {
  createStatus: number;
  jobId: string;
  location: string;
  finalStatus: string;
  pollCount: number;
  outputChars: number;
  observability: GatewayAsyncQueueObservabilitySummary;
  auth?: {
    missingStatus: number;
    invalidStatus: number;
  };
}

export interface GatewayAsyncQueueObservabilitySummary {
  healthStatus: number;
  metricsStatus: number;
  healthTotalJobs: number;
  metricsTotalJobs: number;
  callbackConcurrency: number;
  activeInferenceJobs: number;
  activeCallbackDeliveries: number;
  pendingAdmissions: number;
  effectiveAvailableStorageMiB: number;
  storageAdmissionLow: boolean;
}

export interface GatewaySmokeSummary {
  ok: boolean;
  mode: "basic" | "public-safety" | "async-queue" | "public-async-queue";
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
  asyncQueue?: GatewayAsyncQueueSummary;
}

interface JsonResponse {
  status: number;
  payload: unknown;
}

interface TextResponse {
  status: number;
  text: string;
}

interface AsyncQueueObservabilityRead extends GatewayAsyncQueueObservabilitySummary {
  healthEnabled: boolean;
  healthMaxJobs: number;
  healthJobsPressure: boolean;
  metricsEnabled: number;
  metricsMaxJobs: number;
  metricsJobsPressure: number;
  metricsActiveInferenceJobs: number;
  metricsActiveCallbackDeliveries: number;
  metricsCallbackConcurrency: number;
  metricsPendingAdmissions: number;
  metricsEffectiveAvailableStorageMiB: number;
  metricsStorageAdmissionLow: number;
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
  --async-queue        Enable the durable queue, then verify /v1/jobs submit and status flow.
                       Combine with --public-safety to verify authenticated async jobs.
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

function assertGatewaySmokePathValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }

  if (value.trim() !== value) {
    throw new Error(`${label} must be a path without surrounding whitespace`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_GATEWAY_SMOKE_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_GATEWAY_SMOKE_PATH_BYTES} bytes`);
  }
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
    asyncQueue: false,
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

    if (current === "--async-queue") {
      args.asyncQueue = true;
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

function enablePublicSafetyConfig(
  config: RayConfig,
  options: { maxRequests?: number } = {},
): RayConfig {
  const next = structuredClone(config) as RayConfig;
  next.auth.enabled = true;
  next.auth.apiKeyEnv = "RAY_API_KEYS";
  next.rateLimit.enabled = true;
  next.rateLimit.maxRequests = options.maxRequests ?? 1;
  next.rateLimit.windowMs = 60_000;
  next.rateLimit.keyStrategy = "api-key";
  next.rateLimit.trustProxyHeaders = false;
  return next;
}

function enableAsyncQueueConfig(config: RayConfig, storageDir: string): RayConfig {
  const next = structuredClone(config) as RayConfig;
  next.asyncQueue.enabled = true;
  next.asyncQueue.storageDir = storageDir;
  next.asyncQueue.maxJobs = 16;
  next.asyncQueue.minFreeStorageMiB = 1;
  next.asyncQueue.completedTtlMs = 60_000;
  next.asyncQueue.pollIntervalMs = 20;
  next.asyncQueue.dispatchConcurrency = 1;
  next.asyncQueue.maxAttempts = 2;
  next.asyncQueue.callbackTimeoutMs = 1_000;
  next.asyncQueue.maxCallbackAttempts = 2;
  next.asyncQueue.callbackAllowPrivateNetwork = false;
  next.asyncQueue.callbackAllowedHosts = [];
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

function requireStringField(payload: unknown, field: string, label: string): string {
  if (!isRecord(payload) || typeof payload[field] !== "string" || payload[field].length === 0) {
    throw new Error(`${label} returned a JSON payload without a non-empty ${field} string`);
  }

  return payload[field];
}

function requireRecordField(
  payload: unknown,
  field: string,
  label: string,
): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload[field])) {
    throw new Error(`${label} returned a JSON payload without a ${field} object`);
  }

  return payload[field];
}

function requireNumberField(payload: unknown, field: string, label: string): number {
  if (!isRecord(payload) || typeof payload[field] !== "number") {
    throw new Error(`${label} returned a JSON payload without a numeric ${field} field`);
  }

  return payload[field];
}

function requireBooleanField(payload: unknown, field: string, label: string): boolean {
  if (!isRecord(payload) || typeof payload[field] !== "boolean") {
    throw new Error(`${label} returned a JSON payload without a boolean ${field} field`);
  }

  return payload[field];
}

function requireAsyncJobAccepted(payload: unknown): {
  id: string;
  status: string;
  location: string;
} {
  const id = requireStringField(payload, "id", "/v1/jobs");
  const status = requireStringField(payload, "status", "/v1/jobs");
  const location = requireStringField(payload, "location", "/v1/jobs");

  if (!location.startsWith("/v1/jobs/")) {
    throw new Error(`/v1/jobs returned unexpected location: ${location}`);
  }

  return { id, status, location };
}

function requireAsyncJobSnapshot(payload: unknown): {
  status: string;
  output?: string;
} {
  const status = requireStringField(payload, "status", "async job status");
  const result = isRecord(payload) ? payload.result : undefined;
  const output = isRecord(result) && typeof result.output === "string" ? result.output : undefined;

  return {
    status,
    ...(output !== undefined ? { output } : {}),
  };
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

export async function fetchText(
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
      redirect: "manual",
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

type ProtectedEndpoint =
  | "/v1/infer"
  | "/v1/jobs"
  | "/v1/jobs/job_missing"
  | "/health"
  | "/metrics"
  | "/v1/config";

function protectedEndpointRequest(
  pathName: ProtectedEndpoint,
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

  if (pathName === "/v1/jobs") {
    headers["content-type"] = "application/json";
    return {
      path: pathName,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          input: "Public async auth smoke.",
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
  const protectedPaths: ProtectedEndpoint[] = [
    "/v1/infer",
    "/v1/jobs",
    "/v1/jobs/job_missing",
    "/health",
    "/metrics",
    "/v1/config",
  ];
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

async function smokeAsyncQueue(options: {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}): Promise<GatewayAsyncQueueSummary> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const pollHeaders: Record<string, string> = {};

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
    pollHeaders.authorization = `Bearer ${options.token}`;
  }

  const createResponse = await fetchJson(
    `${options.baseUrl}/v1/jobs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: ASYNC_QUEUE_JOB_INPUT,
        maxTokens: 16,
      }),
    },
    options.timeoutMs,
    "/v1/jobs",
  );

  if (createResponse.status !== 202) {
    throw new Error(`/v1/jobs returned HTTP ${createResponse.status}, expected HTTP 202`);
  }

  const accepted = requireAsyncJobAccepted(createResponse.payload);
  let pollCount = 0;
  let lastStatus = accepted.status;
  const startedAt = Date.now();

  while (Date.now() - startedAt < options.timeoutMs) {
    const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt));
    const statusResponse = await fetchJson(
      `${options.baseUrl}${accepted.location}`,
      {
        method: "GET",
        ...(Object.keys(pollHeaders).length > 0 ? { headers: pollHeaders } : {}),
      },
      Math.min(1_000, remainingMs),
      accepted.location,
    );

    if (statusResponse.status !== 200) {
      throw new Error(
        `${accepted.location} returned HTTP ${statusResponse.status}, expected HTTP 200`,
      );
    }

    pollCount += 1;
    const snapshot = requireAsyncJobSnapshot(statusResponse.payload);
    lastStatus = snapshot.status;

    if (snapshot.status === "succeeded") {
      if (!snapshot.output || snapshot.output.length === 0) {
        throw new Error("async queue smoke completed without a non-empty result output string");
      }
      const observability = await smokeAsyncQueueObservability({
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        token: options.token,
      });

      return {
        createStatus: createResponse.status,
        jobId: accepted.id,
        location: accepted.location,
        finalStatus: snapshot.status,
        pollCount,
        outputChars: snapshot.output.length,
        observability,
      };
    }

    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new Error(`async queue smoke finished with status ${snapshot.status}`);
    }

    await sleep(25);
  }

  throw new Error(
    `async queue smoke did not finish within ${options.timeoutMs}ms; last status was ${lastStatus}`,
  );
}

async function smokeAsyncQueueObservability(options: {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}): Promise<GatewayAsyncQueueObservabilitySummary> {
  const startedAt = Date.now();
  let lastObservation: AsyncQueueObservabilityRead | undefined;

  while (Date.now() - startedAt < options.timeoutMs) {
    const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt));
    const observation = await readAsyncQueueObservability({
      ...options,
      timeoutMs: Math.min(1_000, remainingMs),
    });
    lastObservation = observation;

    if (!observation.healthEnabled) {
      throw new Error("/health asyncQueue.enabled was false during async queue smoke");
    }

    if (observation.healthTotalJobs < 1) {
      throw new Error(
        `/health asyncQueue.totalJobs was ${observation.healthTotalJobs}, expected at least 1`,
      );
    }

    if (observation.healthMaxJobs !== 16) {
      throw new Error(`/health asyncQueue.maxJobs was ${observation.healthMaxJobs}, expected 16`);
    }

    if (observation.healthJobsPressure) {
      throw new Error("/health asyncQueue.jobsPressure was true after a single smoke job");
    }

    if (observation.metricsEnabled !== 1) {
      throw new Error(`/metrics async_queue.enabled was ${observation.metricsEnabled}, expected 1`);
    }

    if (observation.metricsTotalJobs !== observation.healthTotalJobs) {
      throw new Error(
        `/metrics async_queue.total_jobs (${observation.metricsTotalJobs}) did not match /health totalJobs (${observation.healthTotalJobs})`,
      );
    }

    if (observation.metricsMaxJobs !== observation.healthMaxJobs) {
      throw new Error(
        `/metrics async_queue.max_jobs (${observation.metricsMaxJobs}) did not match /health maxJobs (${observation.healthMaxJobs})`,
      );
    }

    if (observation.metricsJobsPressure !== 0) {
      throw new Error(
        `/metrics async_queue.jobs_pressure was ${observation.metricsJobsPressure}, expected 0`,
      );
    }

    if (observation.callbackConcurrency !== 1) {
      throw new Error(
        `/health asyncQueue.callbackConcurrency was ${observation.callbackConcurrency}, expected 1`,
      );
    }

    if (observation.metricsCallbackConcurrency !== observation.callbackConcurrency) {
      throw new Error("/metrics async callback concurrency did not match /health asyncQueue");
    }

    if (observation.metricsPendingAdmissions !== observation.pendingAdmissions) {
      throw new Error("/metrics async pending admissions did not match /health asyncQueue");
    }

    if (
      observation.metricsEffectiveAvailableStorageMiB !== observation.effectiveAvailableStorageMiB
    ) {
      throw new Error("/metrics async effective storage headroom did not match /health asyncQueue");
    }

    if (observation.metricsStorageAdmissionLow !== (observation.storageAdmissionLow ? 1 : 0)) {
      throw new Error("/metrics async admission storage pressure did not match /health asyncQueue");
    }

    if (
      observation.activeInferenceJobs === 0 &&
      observation.activeCallbackDeliveries === 0 &&
      observation.metricsActiveInferenceJobs === 0 &&
      observation.metricsActiveCallbackDeliveries === 0
    ) {
      return {
        healthStatus: observation.healthStatus,
        metricsStatus: observation.metricsStatus,
        healthTotalJobs: observation.healthTotalJobs,
        metricsTotalJobs: observation.metricsTotalJobs,
        callbackConcurrency: observation.callbackConcurrency,
        activeInferenceJobs: observation.activeInferenceJobs,
        activeCallbackDeliveries: observation.activeCallbackDeliveries,
        pendingAdmissions: observation.pendingAdmissions,
        effectiveAvailableStorageMiB: observation.effectiveAvailableStorageMiB,
        storageAdmissionLow: observation.storageAdmissionLow,
      };
    }

    await sleep(25);
  }

  throw new Error(
    `/health asyncQueue active work did not drain: activeInferenceJobs=${
      lastObservation?.activeInferenceJobs ?? "unknown"
    }, activeCallbackDeliveries=${
      lastObservation?.activeCallbackDeliveries ?? "unknown"
    }, metricsActiveInferenceJobs=${
      lastObservation?.metricsActiveInferenceJobs ?? "unknown"
    }, metricsActiveCallbackDeliveries=${
      lastObservation?.metricsActiveCallbackDeliveries ?? "unknown"
    }`,
  );
}

async function readAsyncQueueObservability(options: {
  baseUrl: string;
  timeoutMs: number;
  token?: string;
}): Promise<AsyncQueueObservabilityRead> {
  const headers: Record<string, string> = {};

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const init = {
    method: "GET",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  const healthResponse = await fetchJson(
    `${options.baseUrl}/health`,
    init,
    options.timeoutMs,
    "/health async queue observability",
  );
  assertStatusOk(healthResponse, "/health async queue observability");

  const metricsResponse = await fetchJson(
    `${options.baseUrl}/metrics`,
    init,
    options.timeoutMs,
    "/metrics async queue observability",
  );
  assertStatusOk(metricsResponse, "/metrics async queue observability");

  const healthAsyncQueue = requireRecordField(
    healthResponse.payload,
    "asyncQueue",
    "/health async queue observability",
  );
  const metricsGauges = requireRecordField(
    metricsResponse.payload,
    "gauges",
    "/metrics async queue observability",
  );
  const healthEnabled = requireBooleanField(healthAsyncQueue, "enabled", "/health asyncQueue");
  const healthTotalJobs = requireNumberField(healthAsyncQueue, "totalJobs", "/health asyncQueue");
  const healthMaxJobs = requireNumberField(healthAsyncQueue, "maxJobs", "/health asyncQueue");
  const healthJobsPressure = requireBooleanField(
    healthAsyncQueue,
    "jobsPressure",
    "/health asyncQueue",
  );
  const healthActiveInferenceJobs = requireNumberField(
    healthAsyncQueue,
    "activeInferenceJobs",
    "/health asyncQueue",
  );
  const healthActiveCallbackDeliveries = requireNumberField(
    healthAsyncQueue,
    "activeCallbackDeliveries",
    "/health asyncQueue",
  );
  const healthCallbackConcurrency = requireNumberField(
    healthAsyncQueue,
    "callbackConcurrency",
    "/health asyncQueue",
  );
  const healthPendingAdmissions = requireNumberField(
    healthAsyncQueue,
    "pendingAdmissions",
    "/health asyncQueue",
  );
  const healthEffectiveAvailableStorageMiB = requireNumberField(
    healthAsyncQueue,
    "effectiveAvailableStorageMiB",
    "/health asyncQueue",
  );
  const healthStorageAdmissionLow = requireBooleanField(
    healthAsyncQueue,
    "storageAdmissionLow",
    "/health asyncQueue",
  );

  const metricsEnabled = requireNumberField(
    metricsGauges,
    "async_queue.enabled",
    "/metrics gauges",
  );
  const metricsTotalJobs = requireNumberField(
    metricsGauges,
    "async_queue.total_jobs",
    "/metrics gauges",
  );
  const metricsMaxJobs = requireNumberField(
    metricsGauges,
    "async_queue.max_jobs",
    "/metrics gauges",
  );
  const metricsJobsPressure = requireNumberField(
    metricsGauges,
    "async_queue.jobs_pressure",
    "/metrics gauges",
  );
  const metricsActiveInferenceJobs = requireNumberField(
    metricsGauges,
    "async_queue.active_inference_jobs",
    "/metrics gauges",
  );
  const metricsActiveCallbackDeliveries = requireNumberField(
    metricsGauges,
    "async_queue.active_callback_deliveries",
    "/metrics gauges",
  );
  const metricsCallbackConcurrency = requireNumberField(
    metricsGauges,
    "async_queue.callback_concurrency",
    "/metrics gauges",
  );
  const metricsPendingAdmissions = requireNumberField(
    metricsGauges,
    "async_queue.pending_admissions",
    "/metrics gauges",
  );
  const metricsEffectiveAvailableStorageMiB = requireNumberField(
    metricsGauges,
    "async_queue.effective_available_storage_mib",
    "/metrics gauges",
  );
  const metricsStorageAdmissionLow = requireNumberField(
    metricsGauges,
    "async_queue.storage_admission_low",
    "/metrics gauges",
  );

  return {
    healthStatus: healthResponse.status,
    metricsStatus: metricsResponse.status,
    healthEnabled,
    healthTotalJobs,
    healthMaxJobs,
    healthJobsPressure,
    metricsTotalJobs,
    metricsEnabled,
    metricsMaxJobs,
    metricsJobsPressure,
    callbackConcurrency: healthCallbackConcurrency,
    activeInferenceJobs: healthActiveInferenceJobs,
    activeCallbackDeliveries: healthActiveCallbackDeliveries,
    metricsActiveInferenceJobs,
    metricsActiveCallbackDeliveries,
    metricsCallbackConcurrency,
    pendingAdmissions: healthPendingAdmissions,
    effectiveAvailableStorageMiB: healthEffectiveAvailableStorageMiB,
    storageAdmissionLow: healthStorageAdmissionLow,
    metricsPendingAdmissions,
    metricsEffectiveAvailableStorageMiB,
    metricsStorageAdmissionLow,
  };
}

export async function smokeGateway(options: {
  cwd: string;
  configPath: string;
  host: string;
  port?: number;
  timeoutMs?: number;
  publicSafety?: boolean;
  asyncQueue?: boolean;
}): Promise<GatewaySmokeSummary> {
  assertGatewaySmokePathValue(options.cwd, "cwd");
  assertGatewaySmokePathValue(options.configPath, "configPath");
  const cwd = path.resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configEnv = Object.create(null) as NodeJS.ProcessEnv;
  let asyncStorageDir: string | undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const loaded = await loadRayConfig({
    cwd,
    configPath: options.configPath,
    env: configEnv,
  });
  const port = options.port ?? (await reserveTcpPort(options.host));
  const baseConfig = cloneConfigForSmoke(loaded.config, options.host, port);
  if (options.asyncQueue) {
    asyncStorageDir = await mkdtemp(path.join(tmpdir(), "ray-gateway-smoke-async-"));
  }
  let config = baseConfig;
  if (options.publicSafety) {
    config = enablePublicSafetyConfig(config, {
      maxRequests: options.asyncQueue ? 64 : undefined,
    });
  }
  if (options.asyncQueue && asyncStorageDir) {
    config = enableAsyncQueueConfig(config, asyncStorageDir);
  }
  const baseUrl = `http://${formatHostForUrl(options.host)}:${port}`;

  try {
    gateway = await startGateway({
      config,
      configPath: loaded.configPath,
      logger: silentLogger,
      env: options.publicSafety ? { RAY_API_KEYS: PUBLIC_SAFETY_API_KEY } : configEnv,
      warmupRetry: {
        initialDelayMs: 100,
        maxDelayMs: 250,
      },
    });

    if (options.publicSafety && options.asyncQueue) {
      const livez = await fetchJson(
        `${baseUrl}/livez`,
        { method: "GET" },
        timeoutMs,
        "/livez public async queue",
      );
      assertStatusOk(livez, "/livez public async queue");
      const readyz = await waitForStatusOk(
        `${baseUrl}/readyz`,
        { method: "GET" },
        timeoutMs,
        "/readyz public async queue",
      );

      const missing = protectedEndpointRequest("/v1/jobs");
      const missingResponse = await fetchText(
        `${baseUrl}${missing.path}`,
        missing.init,
        timeoutMs,
        "/v1/jobs public async missing auth",
      );
      assertTextStatus(missingResponse, "/v1/jobs public async missing auth", 401);

      const invalid = protectedEndpointRequest("/v1/jobs", "wrong-token");
      const invalidResponse = await fetchText(
        `${baseUrl}${invalid.path}`,
        invalid.init,
        timeoutMs,
        "/v1/jobs public async invalid auth",
      );
      assertTextStatus(invalidResponse, "/v1/jobs public async invalid auth", 401);

      const asyncQueue = await smokeAsyncQueue({
        baseUrl,
        timeoutMs,
        token: PUBLIC_SAFETY_API_KEY,
      });

      return {
        ok: true,
        mode: "public-async-queue",
        configPath: loaded.configPath ?? path.resolve(cwd, options.configPath),
        profile: config.profile,
        modelId: config.model.id,
        host: options.host,
        port,
        baseUrl,
        livezStatus: livez.status,
        readyzStatus: readyz.status,
        inferStatus: asyncQueue.createStatus,
        outputChars: asyncQueue.outputChars,
        asyncQueue: {
          ...asyncQueue,
          auth: {
            missingStatus: missingResponse.status,
            invalidStatus: invalidResponse.status,
          },
        },
      };
    }

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

    if (options.asyncQueue) {
      const livez = await fetchJson(
        `${baseUrl}/livez`,
        { method: "GET" },
        timeoutMs,
        "/livez async queue",
      );
      assertStatusOk(livez, "/livez async queue");
      const readyz = await waitForStatusOk(
        `${baseUrl}/readyz`,
        { method: "GET" },
        timeoutMs,
        "/readyz async queue",
      );
      const asyncQueue = await smokeAsyncQueue({
        baseUrl,
        timeoutMs,
      });

      return {
        ok: true,
        mode: "async-queue",
        configPath: loaded.configPath ?? path.resolve(cwd, options.configPath),
        profile: config.profile,
        modelId: config.model.id,
        host: options.host,
        port,
        baseUrl,
        livezStatus: livez.status,
        readyzStatus: readyz.status,
        inferStatus: asyncQueue.createStatus,
        outputChars: asyncQueue.outputChars,
        asyncQueue,
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
    if (gateway) {
      await stopGateway(gateway, { timeoutMs: 1_000 });
    }
    if (asyncStorageDir) {
      await rm(asyncStorageDir, { recursive: true, force: true });
    }
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
  ];

  if (summary.asyncQueue) {
    lines.push(
      `- async job: HTTP ${summary.asyncQueue.createStatus}, polls=${summary.asyncQueue.pollCount}, status=${summary.asyncQueue.finalStatus}, outputChars=${summary.asyncQueue.outputChars}`,
      `- async observability: health=${summary.asyncQueue.observability.healthStatus}, metrics=${summary.asyncQueue.observability.metricsStatus}, totalJobs=${summary.asyncQueue.observability.healthTotalJobs}, callbackConcurrency=${summary.asyncQueue.observability.callbackConcurrency}, effectiveStorageMiB=${summary.asyncQueue.observability.effectiveAvailableStorageMiB}`,
    );
    if (summary.asyncQueue.auth) {
      lines.push(
        `- async job auth: missing=${summary.asyncQueue.auth.missingStatus}, invalid=${summary.asyncQueue.auth.invalidStatus}`,
      );
    }
  } else {
    lines.push(`- infer: HTTP ${summary.inferStatus}, outputChars=${summary.outputChars}`);
  }

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
      asyncQueue: args.asyncQueue,
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
