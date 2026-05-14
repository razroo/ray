import { promises as fs } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { normalizeInferenceRequest, type RayRuntime } from "@ray/runtime";
import { Logger } from "@ray/telemetry";
import {
  RayError,
  createRequestId,
  isNonEmptyString,
  toErrorMessage,
  type AsyncQueueConfig,
  type AsyncQueueSnapshot,
  type CreateInferenceJobRequest,
  type InferenceJobAcceptedResponse,
  type InferenceJobCallbackState,
  type InferenceJobError,
  type InferenceJobRecord,
  type InferenceRequest,
} from "@razroo/ray-core";

const RETRYABLE_JOB_ERROR_CODES = new Set([
  "queue_full",
  "request_timeout",
  "request_aborted",
  "provider_timeout",
  "provider_upstream_error",
  "provider_request_failed",
  "gateway_error",
]);
const ATOMIC_WRITE_TEMP_PREFIX = ".tmp-";
const ASYNC_QUEUE_DIRECTORY_MODE = 0o700;
const PERSISTED_JOB_FILE_MODE = 0o600;
const STOP_TIMEOUT_BUFFER_MS = 1_000;
const PERSISTED_JOB_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const CALLBACK_DNS_LOOKUP_TIMEOUT_MS = 1_000;
const MAX_JOB_ID_CHARS = 128;
const MAX_CALLBACK_URL_CHARS = 2_048;
const MAX_JOB_ERROR_MESSAGE_CHARS = 8_192;
const MAX_JOB_ERROR_DETAIL_DEPTH = 5;
const MAX_JOB_ERROR_DETAIL_KEYS = 32;
const MAX_JOB_ERROR_DETAIL_KEY_CHARS = 128;
const MAX_JOB_ERROR_DETAIL_ARRAY_ITEMS = 32;
const MAX_JOB_ERROR_DETAIL_STRING_CHARS = 4_096;
const MAX_JOB_ERROR_DETAIL_TOTAL_CHARS = 64 * 1024;
const MAX_JOB_ERROR_DETAIL_NODES = 512;
const MAX_ASYNC_QUEUE_JOBS = 2_000;
const ASYNC_QUEUE_JOB_PRESSURE_RATIO = 0.9;
const ASYNC_QUEUE_CALLBACK_CONCURRENCY = 1;
const ASYNC_QUEUE_PRUNE_CONCURRENCY = 16;
const MAX_ASYNC_QUEUE_RECOVERY_ENTRIES = 4_096;
const MAX_ASYNC_QUEUE_RECOVERY_TEMP_REMOVALS = 2_048;
const MAX_ASYNC_DISPATCH_CONCURRENCY = 8;
const MAX_ASYNC_COMPLETED_TTL_MS = 604_800_000;
const MAX_ASYNC_POLL_INTERVAL_MS = 60_000;
const MAX_CALLBACK_TIMEOUT_MS = 30_000;
const MAX_CALLBACK_ALLOWED_HOSTS = 64;
const MAX_CALLBACK_ALLOWED_HOST_CHARS = 253;
const MAX_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB = 1_048_576;
const MAX_ASYNC_ATTEMPTS = 100;
const MAX_ASYNC_QUEUE_STORAGE_PATH_BYTES = 4_096;
const MAX_ASYNC_QUEUE_STOP_TIMEOUT_MS = 121_000;
const BYTES_PER_MIB = 1024 * 1024;
const PERSISTED_JOB_FILE_LIMIT_MIB = Math.ceil(PERSISTED_JOB_FILE_LIMIT_BYTES / BYTES_PER_MIB);
const DNS_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CallbackAddressLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string }>>;

export interface StorageStats {
  bavail: number | bigint;
  bsize: number | bigint;
  blocks?: number | bigint;
  ffree?: number | bigint;
}

export type StorageStatsReader = (filePath: string) => Promise<StorageStats>;
export type RemoveFile = (filePath: string) => Promise<void>;

export interface CreateDurableInferenceQueueOptions {
  config: AsyncQueueConfig;
  runtime: RayRuntime;
  logger: Logger;
  fetchImpl?: typeof fetch;
  lookupImpl?: CallbackAddressLookup;
  statfsImpl?: StorageStatsReader;
  removeFileImpl?: RemoveFile;
}

export interface StopDurableInferenceQueueOptions {
  timeoutMs?: number;
}

interface ActiveTaskContext {
  kind: "inference" | "callback";
  jobId: string;
}

interface ScheduledRetry {
  kind: "job" | "callback";
  jobId: string;
}

interface RecoveryRetentionResult {
  retained: boolean;
  displaced?: InferenceJobRecord;
}

interface JobErrorDetailBudget {
  chars: number;
  nodes: number;
}

const JOB_STATUSES = new Set<InferenceJobRecord["status"]>([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
const CALLBACK_STATUSES = new Set<InferenceJobCallbackState["status"]>([
  "pending",
  "delivered",
  "failed",
]);

class PersistedJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedJobValidationError";
  }
}

async function readPersistedJobFile(filePath: string): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    fileHandle = await fs.open(filePath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new PersistedJobValidationError("persisted async job path must be a file");
    }

    if (stats.size > PERSISTED_JOB_FILE_LIMIT_BYTES) {
      throw new PersistedJobValidationError(
        `persisted async job file exceeds ${PERSISTED_JOB_FILE_LIMIT_BYTES} bytes`,
      );
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function isTerminalJobStatus(status: InferenceJobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed";
}

function hasPendingWork(job: InferenceJobRecord): boolean {
  return !isTerminalJobStatus(job.status) || job.callback?.status === "pending";
}

function compareRecoveryRetention(left: InferenceJobRecord, right: InferenceJobRecord): number {
  const leftPriority = hasPendingWork(left) ? 0 : 1;
  const rightPriority = hasPendingWork(right) ? 0 : 1;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function retainRecoveredJob(
  recoveredJobs: InferenceJobRecord[],
  job: InferenceJobRecord,
  maxJobs: number,
): RecoveryRetentionResult {
  if (recoveredJobs.length < maxJobs) {
    recoveredJobs.push(job);
    return { retained: true };
  }

  let worstIndex = -1;

  for (let index = 0; index < recoveredJobs.length; index += 1) {
    const existing = recoveredJobs[index];
    if (!existing) {
      continue;
    }

    if (worstIndex === -1 || compareRecoveryRetention(existing, recoveredJobs[worstIndex]!) > 0) {
      worstIndex = index;
    }
  }

  if (worstIndex === -1 || compareRecoveryRetention(job, recoveredJobs[worstIndex]!) >= 0) {
    return { retained: false };
  }

  const displaced = recoveredJobs[worstIndex]!;
  recoveredJobs[worstIndex] = job;
  return { retained: true, displaced };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeJobId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_JOB_ID_CHARS && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function jobIdFromPersistedFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(".json")) {
    return undefined;
  }

  const jobId = fileName.slice(0, -".json".length);
  return isSafeJobId(jobId) ? jobId : undefined;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasUnencodedWhitespaceOrControl(value: string): boolean {
  return /[\0-\x20\x7f]/u.test(value);
}

function isNonNegativeSafeIntegerAtMost(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isPositiveSafeIntegerAtMost(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function resolveAsyncQueueStopTimeoutMs(
  value: number | undefined,
  fallbackTimeoutMs: number,
): number {
  if (value === undefined) {
    return fallbackTimeoutMs;
  }

  assertPositiveSafeIntegerAtMost(
    value,
    "async queue stop timeoutMs",
    MAX_ASYNC_QUEUE_STOP_TIMEOUT_MS,
  );
  return value;
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
}

function assertAsyncQueueStringArray(
  value: string[],
  label: string,
  maxEntries: number,
  maxEntryChars: number,
): void {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }

  if (value.length > maxEntries) {
    throw new RangeError(`${label} must contain at most ${maxEntries} entries`);
  }

  for (const entry of value) {
    if (entry.length > maxEntryChars) {
      throw new RangeError(`${label} entries must be at most ${maxEntryChars} characters`);
    }
  }
}

function isValidDnsHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CALLBACK_ALLOWED_HOST_CHARS) {
    return false;
  }

  return value.split(".").every((label) => DNS_HOST_LABEL_PATTERN.test(label));
}

function isValidCallbackAllowedHostPattern(value: string): boolean {
  if (value.trim() !== value) {
    return false;
  }

  const normalized = value.toLowerCase().replace(/\.$/, "");

  if (normalized.length === 0 || normalized.includes("://") || /[/?#@]/.test(normalized)) {
    return false;
  }

  if (normalized.startsWith("[") || normalized.endsWith("]")) {
    if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
      return false;
    }

    return isIP(normalized.slice(1, -1)) === 6;
  }

  if (normalized.startsWith("*.")) {
    return isValidDnsHostname(normalized.slice(2));
  }

  if (normalized.includes("*")) {
    return false;
  }

  return isIP(normalized) > 0 || isValidDnsHostname(normalized);
}

function assertCallbackAllowedHosts(value: string[], label: string): void {
  assertAsyncQueueStringArray(
    value,
    label,
    MAX_CALLBACK_ALLOWED_HOSTS,
    MAX_CALLBACK_ALLOWED_HOST_CHARS,
  );

  for (const entry of value) {
    if (!isValidCallbackAllowedHostPattern(entry)) {
      throw new TypeError(
        `${label} entries must be exact host/IP literals or wildcard DNS patterns like *.example.com`,
      );
    }
  }
}

function assertAsyncQueueStorageDir(value: unknown): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new TypeError("asyncQueue.storageDir must be a non-empty string");
  }

  if (/[\0\r\n]/.test(value)) {
    throw new TypeError("asyncQueue.storageDir must not contain control characters");
  }

  if (value.trim() !== value) {
    throw new TypeError("asyncQueue.storageDir must be a path without surrounding whitespace");
  }

  if (Buffer.byteLength(value, "utf8") > MAX_ASYNC_QUEUE_STORAGE_PATH_BYTES) {
    throw new TypeError(
      `asyncQueue.storageDir must be at most ${MAX_ASYNC_QUEUE_STORAGE_PATH_BYTES} bytes`,
    );
  }
}

function snapshotAsyncQueueConfig(config: AsyncQueueConfig): AsyncQueueConfig {
  assertBoolean(config.enabled, "asyncQueue.enabled");
  assertBoolean(config.callbackAllowPrivateNetwork, "asyncQueue.callbackAllowPrivateNetwork");
  assertAsyncQueueStorageDir(config.storageDir);

  assertPositiveSafeIntegerAtMost(config.maxJobs, "asyncQueue.maxJobs", MAX_ASYNC_QUEUE_JOBS);
  assertPositiveSafeIntegerAtMost(
    config.minFreeStorageMiB,
    "asyncQueue.minFreeStorageMiB",
    MAX_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB,
  );
  assertPositiveSafeIntegerAtMost(
    config.completedTtlMs,
    "asyncQueue.completedTtlMs",
    MAX_ASYNC_COMPLETED_TTL_MS,
  );
  assertPositiveSafeIntegerAtMost(
    config.pollIntervalMs,
    "asyncQueue.pollIntervalMs",
    MAX_ASYNC_POLL_INTERVAL_MS,
  );
  assertPositiveSafeIntegerAtMost(
    config.dispatchConcurrency,
    "asyncQueue.dispatchConcurrency",
    MAX_ASYNC_DISPATCH_CONCURRENCY,
  );
  assertPositiveSafeIntegerAtMost(config.maxAttempts, "asyncQueue.maxAttempts", MAX_ASYNC_ATTEMPTS);
  assertPositiveSafeIntegerAtMost(
    config.callbackTimeoutMs,
    "asyncQueue.callbackTimeoutMs",
    MAX_CALLBACK_TIMEOUT_MS,
  );
  assertPositiveSafeIntegerAtMost(
    config.maxCallbackAttempts,
    "asyncQueue.maxCallbackAttempts",
    MAX_ASYNC_ATTEMPTS,
  );
  assertCallbackAllowedHosts(config.callbackAllowedHosts, "asyncQueue.callbackAllowedHosts");

  return {
    enabled: config.enabled,
    storageDir: config.storageDir,
    maxJobs: config.maxJobs,
    minFreeStorageMiB: config.minFreeStorageMiB,
    completedTtlMs: config.completedTtlMs,
    pollIntervalMs: config.pollIntervalMs,
    dispatchConcurrency: config.dispatchConcurrency,
    maxAttempts: config.maxAttempts,
    callbackTimeoutMs: config.callbackTimeoutMs,
    maxCallbackAttempts: config.maxCallbackAttempts,
    callbackAllowPrivateNetwork: config.callbackAllowPrivateNetwork,
    callbackAllowedHosts: [...config.callbackAllowedHosts],
  };
}

function isJobStatus(value: unknown): value is InferenceJobRecord["status"] {
  return typeof value === "string" && JOB_STATUSES.has(value as InferenceJobRecord["status"]);
}

function isCallbackStatus(value: unknown): value is InferenceJobCallbackState["status"] {
  return (
    typeof value === "string" && CALLBACK_STATUSES.has(value as InferenceJobCallbackState["status"])
  );
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined && !isValidTimestamp(value)) {
    throw new PersistedJobValidationError(`${label} must be a valid timestamp when present`);
  }
}

function assertPersistedCallbackState(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (!isObjectRecord(value)) {
    throw new PersistedJobValidationError("callback must be an object when present");
  }

  if (!isNonEmptyString(value.url)) {
    throw new PersistedJobValidationError("callback.url must be a non-empty string");
  }

  if (value.url.length > MAX_CALLBACK_URL_CHARS) {
    throw new PersistedJobValidationError(
      `callback.url must be at most ${MAX_CALLBACK_URL_CHARS} characters`,
    );
  }

  if (hasUnencodedWhitespaceOrControl(value.url)) {
    throw new PersistedJobValidationError(
      "callback.url must not contain unencoded whitespace or control characters",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new PersistedJobValidationError("callback.url must be a valid absolute URL");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new PersistedJobValidationError("callback.url must use http or https");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new PersistedJobValidationError("callback.url must not include credentials");
  }

  if (parsedUrl.hash) {
    throw new PersistedJobValidationError("callback.url must not include a fragment");
  }

  if (!isCallbackStatus(value.status)) {
    throw new PersistedJobValidationError("callback.status is invalid");
  }

  if (!isNonNegativeSafeIntegerAtMost(value.attempts, MAX_ASYNC_ATTEMPTS)) {
    throw new PersistedJobValidationError(
      `callback.attempts must be a non-negative safe integer no greater than ${MAX_ASYNC_ATTEMPTS}`,
    );
  }

  assertOptionalTimestamp(value.lastAttemptAt, "callback.lastAttemptAt");
  assertOptionalTimestamp(value.deliveredAt, "callback.deliveredAt");

  if (value.lastError !== undefined && typeof value.lastError !== "string") {
    throw new PersistedJobValidationError("callback.lastError must be a string when present");
  }
}

function validatePersistedJobRecord(value: unknown, expectedJobId?: string): InferenceJobRecord {
  if (!isObjectRecord(value)) {
    throw new PersistedJobValidationError("persisted async job must be an object");
  }

  if (!isSafeJobId(value.id)) {
    throw new PersistedJobValidationError("persisted async job id is invalid");
  }

  if (expectedJobId !== undefined && value.id !== expectedJobId) {
    throw new PersistedJobValidationError("persisted async job id does not match its file name");
  }

  if (!isJobStatus(value.status)) {
    throw new PersistedJobValidationError("persisted async job status is invalid");
  }

  if (!isObjectRecord(value.request)) {
    throw new PersistedJobValidationError("persisted async job request must be an object");
  }

  if (!isValidTimestamp(value.createdAt)) {
    throw new PersistedJobValidationError("persisted async job createdAt is invalid");
  }

  if (!isValidTimestamp(value.updatedAt)) {
    throw new PersistedJobValidationError("persisted async job updatedAt is invalid");
  }

  if (!isNonNegativeSafeIntegerAtMost(value.attempts, MAX_ASYNC_ATTEMPTS)) {
    throw new PersistedJobValidationError(
      `persisted async job attempts must be a non-negative safe integer no greater than ${MAX_ASYNC_ATTEMPTS}`,
    );
  }

  if (!isPositiveSafeIntegerAtMost(value.maxAttempts, MAX_ASYNC_ATTEMPTS)) {
    throw new PersistedJobValidationError(
      `persisted async job maxAttempts must be a positive safe integer no greater than ${MAX_ASYNC_ATTEMPTS}`,
    );
  }

  assertOptionalTimestamp(value.startedAt, "persisted async job startedAt");
  assertOptionalTimestamp(value.completedAt, "persisted async job completedAt");
  assertPersistedCallbackState(value.callback);

  return value as unknown as InferenceJobRecord;
}

function cloneJobRecord(job: InferenceJobRecord): InferenceJobRecord {
  return structuredClone(job);
}

function cloneRequest(request: CreateInferenceJobRequest): InferenceRequest {
  const next = structuredClone(request) as CreateInferenceJobRequest;
  delete next.callbackUrl;
  return next;
}

function truncateJobErrorString(value: string, maxChars = MAX_JOB_ERROR_MESSAGE_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function truncateJobErrorDetailKey(value: string): string {
  if (value.length <= MAX_JOB_ERROR_DETAIL_KEY_CHARS) {
    return value;
  }

  let headChars = MAX_JOB_ERROR_DETAIL_KEY_CHARS;

  for (;;) {
    const omittedChars = value.length - headChars;
    const suffix = `...[truncated ${omittedChars} chars]`;
    const nextHeadChars = MAX_JOB_ERROR_DETAIL_KEY_CHARS - suffix.length;

    if (nextHeadChars <= 0) {
      return suffix.slice(0, MAX_JOB_ERROR_DETAIL_KEY_CHARS);
    }

    if (nextHeadChars === headChars) {
      return `${value.slice(0, headChars)}${suffix}`;
    }

    headChars = nextHeadChars;
  }
}

function truncateJobErrorDetailString(value: string, budget: JobErrorDetailBudget): string {
  const allowedChars = Math.min(value.length, MAX_JOB_ERROR_DETAIL_STRING_CHARS, budget.chars);

  if (allowedChars <= 0) {
    return `[Truncated ${value.length} chars]`;
  }

  budget.chars -= allowedChars;

  if (allowedChars < value.length) {
    return `${value.slice(0, allowedChars)}...[truncated ${value.length - allowedChars} chars]`;
  }

  return value;
}

function sanitizeJobErrorDetail(
  value: unknown,
  budget: JobErrorDetailBudget,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (budget.nodes <= 0) {
    return "[Truncated]";
  }
  budget.nodes -= 1;

  if (typeof value === "string") {
    return truncateJobErrorDetailString(value, budget);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_JOB_ERROR_DETAIL_DEPTH) {
    return "[Truncated]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: truncateJobErrorString(value.name),
      message: truncateJobErrorDetailString(value.message, budget),
    };

    return output;
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];

      for (const entry of value.slice(0, MAX_JOB_ERROR_DETAIL_ARRAY_ITEMS)) {
        if (budget.nodes <= 0) {
          output.push("[Truncated]");
          break;
        }

        output.push(sanitizeJobErrorDetail(entry, budget, seen, depth + 1));
      }

      if (value.length > MAX_JOB_ERROR_DETAIL_ARRAY_ITEMS) {
        output.push(`[Truncated ${value.length - MAX_JOB_ERROR_DETAIL_ARRAY_ITEMS} items]`);
      }

      return output;
    }

    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable object: ${truncateJobErrorString(toErrorMessage(error))}]`;
    }

    const output: Record<string, unknown> = {};

    for (const key of keys.slice(0, MAX_JOB_ERROR_DETAIL_KEYS)) {
      if (key.toLowerCase() === "stack") {
        continue;
      }

      const safeKey = truncateJobErrorDetailKey(key);

      if (budget.nodes <= 0) {
        output.__truncatedValues = true;
        break;
      }

      try {
        output[safeKey] = sanitizeJobErrorDetail(
          (value as Record<string, unknown>)[key],
          budget,
          seen,
          depth + 1,
        );
      } catch (error) {
        output[safeKey] = `[Thrown: ${truncateJobErrorString(toErrorMessage(error))}]`;
      }
    }

    if (keys.length > MAX_JOB_ERROR_DETAIL_KEYS) {
      output.__truncatedKeys = keys.length - MAX_JOB_ERROR_DETAIL_KEYS;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function toJobError(error: unknown): InferenceJobError {
  if (error instanceof RayError) {
    const jobError: InferenceJobError = {
      message: truncateJobErrorString(error.message),
      code: error.code,
    };

    if (error.details !== undefined) {
      jobError.details = sanitizeJobErrorDetail(
        error.details,
        {
          chars: MAX_JOB_ERROR_DETAIL_TOTAL_CHARS,
          nodes: MAX_JOB_ERROR_DETAIL_NODES,
        },
        new WeakSet(),
      );
    }

    return jobError;
  }

  return {
    message: truncateJobErrorString(toErrorMessage(error)),
  };
}

function shouldRetryJob(error: unknown): boolean {
  if (error instanceof RayError) {
    return error.status >= 500 || RETRYABLE_JOB_ERROR_CODES.has(error.code);
  }

  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

function matchesAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const normalized = normalizeHostname(hostname);

  return allowedHosts.some((allowedHost) => {
    const allowed = normalizeHostname(allowedHost);

    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }

    return normalized === allowed;
  });
}

function isNonGlobalIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0, third = 0] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function expandIpv6Hextets(address: string): number[] | undefined {
  const normalized = normalizeHostname(address);

  if (normalized.includes(".")) {
    return undefined;
  }

  const compressedParts = normalized.split("::");
  if (compressedParts.length > 2) {
    return undefined;
  }

  const parseSide = (value: string): number[] | undefined => {
    if (value.length === 0) {
      return [];
    }

    const hextets: number[] = [];
    for (const segment of value.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(segment)) {
        return undefined;
      }

      hextets.push(Number.parseInt(segment, 16));
    }

    return hextets;
  };

  const left = parseSide(compressedParts[0] ?? "");
  const right = parseSide(compressedParts[1] ?? "");

  if (!left || !right) {
    return undefined;
  }

  if (compressedParts.length === 1) {
    return left.length === 8 ? left : undefined;
  }

  const zeroFill = 8 - left.length - right.length;
  if (zeroFill < 1) {
    return undefined;
  }

  return [...left, ...Array.from({ length: zeroFill }, () => 0), ...right];
}

function embeddedIpv4FromIpv6(address: string): string | undefined {
  const hextets = expandIpv6Hextets(address);

  if (!hextets) {
    return undefined;
  }

  const embedsIpv4 =
    (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) ||
    hextets.slice(0, 6).every((part) => part === 0);

  if (!embedsIpv4) {
    return undefined;
  }

  const high = hextets[6] ?? 0;
  const low = hextets[7] ?? 0;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isNonGlobalIpv6(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);

  if (mappedIpv4?.[1]) {
    return isNonGlobalIpv4(mappedIpv4[1]);
  }

  const embeddedIpv4 = embeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4) {
    return isNonGlobalIpv4(embeddedIpv4);
  }

  const segments = normalized.split(":");
  const firstSegment = segments[0] ?? "";
  const secondSegment = segments[1] ?? "";
  const firstHextet = /^[0-9a-f]{1,4}$/.test(firstSegment)
    ? Number.parseInt(firstSegment, 16)
    : undefined;
  const secondHextet = /^[0-9a-f]{1,4}$/.test(secondSegment)
    ? Number.parseInt(secondSegment, 16)
    : undefined;

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("64:ff9b:") ||
    normalized === "100::" ||
    normalized.startsWith("100::") ||
    (firstHextet === 0x2001 &&
      secondHextet !== undefined &&
      (secondHextet <= 0x01ff || secondHextet === 0x0db8)) ||
    firstHextet === 0x2002 ||
    (firstHextet !== undefined && firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet !== undefined && firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    (firstHextet !== undefined && firstHextet >= 0xff00 && firstHextet <= 0xffff)
  );
}

function isNonGlobalNetworkAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isNonGlobalIpv4(address);
  }

  if (version === 6) {
    return isNonGlobalIpv6(address);
  }

  return false;
}

async function resolveCallbackAddresses(
  hostname: string,
  lookupImpl: CallbackAddressLookup,
  timeoutMs: number,
): Promise<string[]> {
  const normalized = normalizeHostname(hostname);

  if (isIP(normalized)) {
    return [normalized];
  }

  let timeout: NodeJS.Timeout | undefined;

  try {
    const records = await Promise.race([
      lookupImpl(normalized, {
        all: true,
        verbatim: true,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new RayError("callbackUrl hostname resolution timed out", {
              code: "invalid_request",
              status: 400,
              details: {
                hostname: normalized,
                timeoutMs,
              },
            }),
          );
        }, timeoutMs);
      }),
    ]);
    const addresses = records.map((record) => record.address);

    if (addresses.length === 0) {
      throw new RayError("callbackUrl hostname did not resolve to any IP addresses", {
        code: "invalid_request",
        status: 400,
        details: {
          hostname: normalized,
        },
      });
    }

    for (const address of addresses) {
      if (typeof address !== "string" || isIP(address) === 0) {
        throw new RayError("callbackUrl hostname resolved to an invalid address", {
          code: "invalid_request",
          status: 400,
          details: {
            hostname: normalized,
            address: typeof address === "string" ? truncateJobErrorString(address, 128) : undefined,
          },
        });
      }
    }

    return addresses;
  } catch (error) {
    if (error instanceof RayError) {
      throw error;
    }

    throw new RayError("callbackUrl hostname could not be resolved", {
      code: "invalid_request",
      status: 400,
      details: error,
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function assertCallbackNetworkAllowed(
  parsed: URL,
  config: AsyncQueueConfig,
  lookupImpl: CallbackAddressLookup,
): Promise<void> {
  if (matchesAllowedHost(parsed.hostname, config.callbackAllowedHosts)) {
    return;
  }

  if (config.callbackAllowPrivateNetwork) {
    return;
  }

  const addresses = await resolveCallbackAddresses(
    parsed.hostname,
    lookupImpl,
    Math.min(config.callbackTimeoutMs, CALLBACK_DNS_LOOKUP_TIMEOUT_MS),
  );
  const blockedAddress = addresses.find((address) => isNonGlobalNetworkAddress(address));

  if (blockedAddress) {
    throw new RayError("callbackUrl resolves to a private, local, or non-global address", {
      code: "invalid_request",
      status: 400,
      details: {
        hostname: parsed.hostname,
        address: blockedAddress,
      },
    });
  }
}

async function normalizeCallbackUrl(
  callbackUrl: unknown,
  config: AsyncQueueConfig,
  lookupImpl: CallbackAddressLookup,
): Promise<string | undefined> {
  if (callbackUrl === undefined) {
    return undefined;
  }

  if (typeof callbackUrl !== "string" || !isNonEmptyString(callbackUrl)) {
    throw new RayError("callbackUrl must be a non-empty string when provided", {
      code: "invalid_request",
      status: 400,
      details: { value: callbackUrl },
    });
  }

  if (callbackUrl.length > MAX_CALLBACK_URL_CHARS) {
    throw new RayError(`callbackUrl must be at most ${MAX_CALLBACK_URL_CHARS} characters`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxChars: MAX_CALLBACK_URL_CHARS,
        actualChars: callbackUrl.length,
      },
    });
  }

  if (hasUnencodedWhitespaceOrControl(callbackUrl)) {
    throw new RayError("callbackUrl must not contain unencoded whitespace or control characters", {
      code: "invalid_request",
      status: 400,
    });
  }

  let parsed: URL;

  try {
    parsed = new URL(callbackUrl);
  } catch (error) {
    throw new RayError("callbackUrl must be a valid absolute URL", {
      code: "invalid_request",
      status: 400,
      details: error,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RayError("callbackUrl must use http or https", {
      code: "invalid_request",
      status: 400,
    });
  }

  if (parsed.username || parsed.password) {
    throw new RayError("callbackUrl must not include credentials", {
      code: "invalid_request",
      status: 400,
    });
  }

  if (parsed.hash) {
    throw new RayError("callbackUrl must not include a fragment", {
      code: "invalid_request",
      status: 400,
    });
  }

  await assertCallbackNetworkAllowed(parsed, config, lookupImpl);

  return parsed.toString();
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    // Callback delivery only needs response headers/status; failed body cleanup should not
    // turn a delivered callback into a failed job.
  }
}

function stringifyPersistedJob(job: InferenceJobRecord): string {
  const body = JSON.stringify(job, null, 2);
  const bytes = Buffer.byteLength(body, "utf8");

  if (bytes > PERSISTED_JOB_FILE_LIMIT_BYTES) {
    throw new RayError("The async job record exceeds the durable storage size limit", {
      code: "async_job_record_too_large",
      status: 413,
      details: {
        jobId: job.id,
        bytes,
        maxBytes: PERSISTED_JOB_FILE_LIMIT_BYTES,
      },
    });
  }

  return body;
}

function statValueToNumber(value: number | bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numberValue = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function resolveAvailableStorageMiB(stats: StorageStats): number | undefined {
  let availableBlocks = statValueToNumber(stats.bavail);
  let blockSize = statValueToNumber(stats.bsize);

  if (blockSize === 0) {
    const fallbackBlockSize = statValueToNumber(stats.blocks);
    const fallbackAvailableBlocks = statValueToNumber(stats.ffree);

    if (
      fallbackBlockSize !== undefined &&
      fallbackBlockSize > 0 &&
      fallbackBlockSize <= BYTES_PER_MIB &&
      fallbackAvailableBlocks !== undefined
    ) {
      blockSize = fallbackBlockSize;
      availableBlocks = fallbackAvailableBlocks;
    }
  }

  if (availableBlocks === undefined || blockSize === undefined || blockSize <= 0) {
    return undefined;
  }

  return Math.floor((availableBlocks * blockSize) / BYTES_PER_MIB);
}

async function writeJsonAtomic(filePath: string, body: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `${ATOMIC_WRITE_TEMP_PREFIX}${path.basename(filePath)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
  );
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    fileHandle = await fs.open(tempPath, "wx", PERSISTED_JOB_FILE_MODE);
    await fileHandle.writeFile(body, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await fs.rename(tempPath, filePath);
    await syncDirectoryBestEffort(directory);
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;

  try {
    directoryHandle = await fs.open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // Directory fsync support varies by platform; the atomic rename still protects readers.
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

export class DurableInferenceQueue {
  private readonly jobs = new Map<string, InferenceJobRecord>();
  private readonly queuedJobIds: string[] = [];
  private readonly pendingCallbackJobIds: string[] = [];
  private readonly retryTimers = new Map<NodeJS.Timeout, ScheduledRetry>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: CallbackAddressLookup;
  private readonly statfsImpl: StorageStatsReader;
  private readonly removeFileImpl: RemoveFile;
  private readonly jobsDir: string;
  private readonly options: CreateDurableInferenceQueueOptions;
  private readyPromise: Promise<void> | undefined;
  private started = false;
  private activeInferenceJobs = 0;
  private activeCallbackDeliveries = 0;
  private pendingJobAdmissions = 0;

  constructor(options: CreateDurableInferenceQueueOptions) {
    this.options = {
      ...options,
      config: snapshotAsyncQueueConfig(options.config),
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupImpl = options.lookupImpl ?? (lookup as CallbackAddressLookup);
    this.statfsImpl = options.statfsImpl ?? fs.statfs;
    this.removeFileImpl =
      options.removeFileImpl ?? ((filePath) => fs.rm(filePath, { force: true }));
    this.jobsDir = path.join(this.options.config.storageDir, "jobs");
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.ensureReady();
    await this.loadJobsFromDisk();
    this.started = true;
    this.requestDrain();
  }

  async stop(options: StopDurableInferenceQueueOptions = {}): Promise<void> {
    const timeoutMs = resolveAsyncQueueStopTimeoutMs(
      options.timeoutMs,
      Math.max(
        this.options.runtime.config.scheduler.requestTimeoutMs,
        this.options.config.callbackTimeoutMs,
      ) + STOP_TIMEOUT_BUFFER_MS,
    );

    this.started = false;

    for (const timer of this.retryTimers.keys()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    await this.waitForActiveTasks(timeoutMs);
  }

  snapshot(): AsyncQueueSnapshot {
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    let callbackPending = 0;
    let callbackDelivered = 0;
    let callbackFailed = 0;
    let jobRetryScheduled = 0;
    let callbackRetryScheduled = 0;

    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        running += 1;
      }

      if (job.status === "succeeded") {
        succeeded += 1;
      }

      if (job.status === "failed") {
        failed += 1;
      }

      if (job.callback?.status === "pending") {
        callbackPending += 1;
      }

      if (job.callback?.status === "delivered") {
        callbackDelivered += 1;
      }

      if (job.callback?.status === "failed") {
        callbackFailed += 1;
      }
    }

    for (const retry of this.retryTimers.values()) {
      if (retry.kind === "job") {
        jobRetryScheduled += 1;
      } else {
        callbackRetryScheduled += 1;
      }
    }

    const jobsRatio = Number(
      (this.jobs.size / Math.max(1, this.options.config.maxJobs)).toFixed(4),
    );
    const jobsPressure = jobsRatio >= ASYNC_QUEUE_JOB_PRESSURE_RATIO;

    return {
      enabled: true,
      degraded: jobsPressure,
      queued: this.queuedJobIds.length,
      running,
      activeInferenceJobs: this.activeInferenceJobs,
      succeeded,
      failed,
      callbackPending,
      activeCallbackDeliveries: this.activeCallbackDeliveries,
      callbackDelivered,
      callbackFailed,
      retryScheduled: jobRetryScheduled + callbackRetryScheduled,
      jobRetryScheduled,
      callbackRetryScheduled,
      totalJobs: this.jobs.size,
      maxJobs: this.options.config.maxJobs,
      jobsRatio,
      jobsPressure,
      pressureThreshold: ASYNC_QUEUE_JOB_PRESSURE_RATIO,
      pendingAdmissions: this.pendingJobAdmissions,
      minFreeStorageMiB: this.options.config.minFreeStorageMiB,
      reservedAdmissionMiB: this.pendingJobAdmissions * PERSISTED_JOB_FILE_LIMIT_MIB,
      completedTtlMs: this.options.config.completedTtlMs,
      pollIntervalMs: this.options.config.pollIntervalMs,
      dispatchConcurrency: this.options.config.dispatchConcurrency,
      callbackConcurrency: ASYNC_QUEUE_CALLBACK_CONCURRENCY,
      maxAttempts: this.options.config.maxAttempts,
      callbackTimeoutMs: this.options.config.callbackTimeoutMs,
      maxCallbackAttempts: this.options.config.maxCallbackAttempts,
    };
  }

  async snapshotWithStorage(): Promise<AsyncQueueSnapshot> {
    const snapshot = this.snapshot();
    const availableStorageMiB = await this.readAvailableStorageMiB();

    if (availableStorageMiB !== undefined) {
      snapshot.availableStorageMiB = availableStorageMiB;
      snapshot.effectiveAvailableStorageMiB = availableStorageMiB - snapshot.reservedAdmissionMiB;
      snapshot.storageReserveRatio = Number(
        (availableStorageMiB / Math.max(1, snapshot.minFreeStorageMiB)).toFixed(4),
      );
      snapshot.storageLow = availableStorageMiB < snapshot.minFreeStorageMiB;
      snapshot.storageAdmissionReserveRatio = Number(
        (snapshot.effectiveAvailableStorageMiB / Math.max(1, snapshot.minFreeStorageMiB)).toFixed(
          4,
        ),
      );
      snapshot.storageAdmissionLow =
        snapshot.effectiveAvailableStorageMiB < snapshot.minFreeStorageMiB;
      snapshot.degraded = snapshot.degraded || snapshot.storageLow || snapshot.storageAdmissionLow;
    }

    return snapshot;
  }

  async enqueue(request: CreateInferenceJobRequest): Promise<InferenceJobRecord> {
    await this.ensureReady();
    normalizeInferenceRequest(this.options.runtime.config, cloneRequest(request));
    await this.pruneCompletedJobs();
    const admissionCount = this.reserveJobAdmission();

    try {
      await this.ensureStorageReserve(admissionCount);
      const callbackUrl = await normalizeCallbackUrl(
        request.callbackUrl,
        this.options.config,
        this.lookupImpl,
      );
      const now = new Date().toISOString();
      const job: InferenceJobRecord = {
        id: createRequestId("job"),
        status: "queued",
        request: cloneRequest(request),
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: this.options.config.maxAttempts,
        ...(callbackUrl
          ? {
              callback: {
                url: callbackUrl,
                status: "pending",
                attempts: 0,
              } satisfies InferenceJobCallbackState,
            }
          : {}),
      };

      this.jobs.set(job.id, job);

      try {
        await this.persistJob(job);
      } catch (error) {
        this.jobs.delete(job.id);
        throw error;
      }

      this.enqueueJobId(job.id);
      this.requestDrain();

      return cloneJobRecord(job);
    } finally {
      this.pendingJobAdmissions -= 1;
    }
  }

  async get(jobId: string): Promise<InferenceJobRecord | undefined> {
    const normalizedId = this.normalizeJobId(jobId);
    await this.ensureReady();
    const existing = this.jobs.get(normalizedId);

    if (existing) {
      if (await this.pruneCompletedJob(existing)) {
        return undefined;
      }

      return cloneJobRecord(existing);
    }

    try {
      const filePath = this.getJobPath(normalizedId);
      const raw = await readPersistedJobFile(filePath);
      const parsed = validatePersistedJobRecord(JSON.parse(raw), normalizedId);
      this.validatePersistedInferenceRequest(parsed);

      if (await this.pruneCompletedJob(parsed, filePath)) {
        return undefined;
      }

      if (this.jobs.size + this.pendingJobAdmissions >= this.options.config.maxJobs) {
        this.options.logger.warn("skipped persisted async job because retained store is full", {
          jobId: parsed.id,
          maxJobs: this.options.config.maxJobs,
        });
        return undefined;
      }

      this.jobs.set(parsed.id, parsed);
      return cloneJobRecord(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      if (error instanceof SyntaxError || error instanceof PersistedJobValidationError) {
        this.options.logger.warn("failed to load persisted async job", {
          jobId: normalizedId,
          error: toErrorMessage(error),
        });
        await this.removeInvalidPersistedJob(this.getJobPath(normalizedId));
        return undefined;
      }

      throw error;
    }
  }

  toAcceptedResponse(job: InferenceJobRecord): InferenceJobAcceptedResponse {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      location: `/v1/jobs/${job.id}`,
    };
  }

  private async ensureReady(): Promise<void> {
    this.readyPromise ??= fs
      .mkdir(this.jobsDir, { mode: ASYNC_QUEUE_DIRECTORY_MODE, recursive: true })
      .then(() => undefined);
    await this.readyPromise;
  }

  private async ensureStorageReserve(admissionCount = this.pendingJobAdmissions): Promise<void> {
    const availableMiB = await this.readAvailableStorageMiB();
    if (availableMiB === undefined) {
      return;
    }

    const reservedAdmissionMiB = admissionCount * PERSISTED_JOB_FILE_LIMIT_MIB;
    const effectiveAvailableMiB = availableMiB - reservedAdmissionMiB;

    if (effectiveAvailableMiB < this.options.config.minFreeStorageMiB) {
      throw new RayError("The async job store has insufficient free disk space", {
        code: "async_queue_storage_low",
        status: 503,
        details: {
          storageDir: this.options.config.storageDir,
          availableMiB,
          reservedAdmissionMiB,
          effectiveAvailableMiB,
          minFreeStorageMiB: this.options.config.minFreeStorageMiB,
        },
      });
    }
  }

  private async readAvailableStorageMiB(): Promise<number | undefined> {
    let stats: StorageStats;

    try {
      stats = await this.statfsImpl(this.options.config.storageDir);
    } catch (error) {
      this.options.logger.warn("failed to inspect async queue storage capacity", {
        storageDir: this.options.config.storageDir,
        error: toErrorMessage(error),
      });
      return undefined;
    }

    const availableMiB = resolveAvailableStorageMiB(stats);

    if (availableMiB === undefined) {
      this.options.logger.warn("failed to resolve async queue free storage", {
        storageDir: this.options.config.storageDir,
      });
    }

    return availableMiB;
  }

  private reserveJobAdmission(): number {
    const retainedOrPendingJobs = this.jobs.size + this.pendingJobAdmissions;

    if (retainedOrPendingJobs >= this.options.config.maxJobs) {
      throw new RayError("The async job store is full", {
        code: "async_queue_full",
        status: 503,
        details: {
          totalJobs: this.jobs.size,
          pendingAdmissions: this.pendingJobAdmissions,
          maxJobs: this.options.config.maxJobs,
        },
      });
    }

    this.pendingJobAdmissions += 1;
    return this.pendingJobAdmissions;
  }

  private async loadJobsFromDisk(): Promise<void> {
    this.jobs.clear();
    this.queuedJobIds.length = 0;
    this.pendingCallbackJobIds.length = 0;

    const recoveredJobs: InferenceJobRecord[] = [];
    const recoveredJobPaths = new Map<string, string>();
    let visitedEntries = 0;
    let removedTempFiles = 0;

    for await (const entry of await fs.opendir(this.jobsDir)) {
      visitedEntries += 1;
      if (visitedEntries > MAX_ASYNC_QUEUE_RECOVERY_ENTRIES) {
        throw new RayError(
          `Async job recovery visited more than ${MAX_ASYNC_QUEUE_RECOVERY_ENTRIES} directory entries`,
          {
            code: "async_queue_recovery_limit_exceeded",
            status: 503,
            details: {
              jobsDir: this.jobsDir,
              visitedEntries,
              maxEntries: MAX_ASYNC_QUEUE_RECOVERY_ENTRIES,
            },
          },
        );
      }

      const filePath = path.join(this.jobsDir, entry.name);

      if (entry.isFile() && entry.name.startsWith(ATOMIC_WRITE_TEMP_PREFIX)) {
        removedTempFiles += 1;
        if (removedTempFiles > MAX_ASYNC_QUEUE_RECOVERY_TEMP_REMOVALS) {
          throw new RayError(
            `Async job recovery found more than ${MAX_ASYNC_QUEUE_RECOVERY_TEMP_REMOVALS} stale temp files`,
            {
              code: "async_queue_recovery_limit_exceeded",
              status: 503,
              details: {
                jobsDir: this.jobsDir,
                removedTempFiles,
                maxTempRemovals: MAX_ASYNC_QUEUE_RECOVERY_TEMP_REMOVALS,
              },
            },
          );
        }

        await this.removeStaleTempFile(filePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      try {
        const expectedJobId = jobIdFromPersistedFileName(entry.name);
        if (!expectedJobId) {
          throw new PersistedJobValidationError("persisted async job file name is invalid");
        }

        const raw = await readPersistedJobFile(filePath);
        const parsed = validatePersistedJobRecord(JSON.parse(raw), expectedJobId);
        this.validatePersistedInferenceRequest(parsed);

        if (parsed.status === "running") {
          const recoveredAt = new Date().toISOString();
          parsed.updatedAt = recoveredAt;

          if (parsed.attempts >= parsed.maxAttempts) {
            parsed.status = "failed";
            parsed.completedAt = recoveredAt;
            parsed.error = {
              code: "job_recovery_attempts_exhausted",
              message: "The job was running during restart and had no retry attempts remaining",
            };
          } else {
            parsed.status = "queued";
            parsed.error = {
              code: "job_recovered",
              message: "The job was returned to the durable queue after a restart",
            };
          }

          await this.persistJob(parsed);
        }

        if (
          isTerminalJobStatus(parsed.status) &&
          parsed.callback?.status === "pending" &&
          parsed.callback.attempts >= this.options.config.maxCallbackAttempts
        ) {
          const recoveredAt = new Date().toISOString();
          parsed.callback.status = "failed";
          parsed.callback.lastError =
            "Callback delivery was pending during restart and had no retry attempts remaining";
          parsed.updatedAt = recoveredAt;
          await this.persistJob(parsed);
        }

        if (await this.pruneCompletedJob(parsed, filePath)) {
          continue;
        }

        const retention = retainRecoveredJob(recoveredJobs, parsed, this.options.config.maxJobs);

        if (!retention.retained) {
          this.options.logger.warn("skipped persisted async job because retained store is full", {
            jobId: parsed.id,
            filePath,
            maxJobs: this.options.config.maxJobs,
          });
          await this.removeOverflowPersistedJob(parsed, filePath);
          continue;
        }

        recoveredJobPaths.set(parsed.id, filePath);

        if (retention.displaced) {
          const displacedPath = recoveredJobPaths.get(retention.displaced.id);
          recoveredJobPaths.delete(retention.displaced.id);

          if (displacedPath) {
            this.options.logger.warn("pruned overflow persisted async job from retained store", {
              jobId: retention.displaced.id,
              filePath: displacedPath,
              maxJobs: this.options.config.maxJobs,
            });
            await this.removeOverflowPersistedJob(retention.displaced, displacedPath);
          }
        }
      } catch (error) {
        this.options.logger.warn("failed to load persisted async job", {
          filePath,
          error: toErrorMessage(error),
        });

        if (error instanceof SyntaxError || error instanceof PersistedJobValidationError) {
          await this.removeInvalidPersistedJob(filePath);
        }
      }
    }

    recoveredJobs.sort(compareRecoveryRetention);

    for (const job of recoveredJobs) {
      this.jobs.set(job.id, job);

      if (job.status === "queued") {
        this.enqueueJobId(job.id);
      }

      if (
        isTerminalJobStatus(job.status) &&
        job.callback?.status === "pending" &&
        job.callback.attempts < this.options.config.maxCallbackAttempts
      ) {
        this.enqueueCallbackJobId(job.id);
      }
    }
  }

  private validatePersistedInferenceRequest(job: InferenceJobRecord): void {
    try {
      normalizeInferenceRequest(this.options.runtime.config, job.request);
    } catch (error) {
      throw new PersistedJobValidationError(
        `persisted async job request is invalid: ${toErrorMessage(error)}`,
      );
    }
  }

  private requestDrain(): void {
    if (!this.started) {
      return;
    }

    while (
      this.activeInferenceJobs < this.options.config.dispatchConcurrency &&
      this.queuedJobIds.length > 0
    ) {
      const jobId = this.queuedJobIds.shift();

      if (!jobId) {
        break;
      }

      this.activeInferenceJobs += 1;
      this.trackActiveTask(this.runInferenceJob(jobId), { kind: "inference", jobId }, () => {
        this.activeInferenceJobs -= 1;
      });
    }

    while (
      this.activeCallbackDeliveries < ASYNC_QUEUE_CALLBACK_CONCURRENCY &&
      this.pendingCallbackJobIds.length > 0
    ) {
      const jobId = this.pendingCallbackJobIds.shift();

      if (!jobId) {
        break;
      }

      this.activeCallbackDeliveries += 1;
      this.trackActiveTask(this.deliverCallback(jobId), { kind: "callback", jobId }, () => {
        this.activeCallbackDeliveries -= 1;
      });
    }
  }

  private trackActiveTask(
    task: Promise<void>,
    context: ActiveTaskContext,
    onSettled: () => void,
  ): void {
    const handled = task.catch((error) => {
      this.options.logger.error("async queue task failed", {
        ...context,
        error: toErrorMessage(error),
      });
    });
    const tracked = handled.finally(() => {
      onSettled();
      this.activeTasks.delete(tracked);
      this.requestDrain();
    });
    this.activeTasks.add(tracked);
  }

  private async waitForActiveTasks(timeoutMs: number): Promise<void> {
    const tasks = [...this.activeTasks];
    if (tasks.length === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    const outcome = await Promise.race<"settled" | "timed_out">([
      Promise.allSettled(tasks).then(() => "settled"),
      new Promise<"timed_out">((resolve) => {
        timeout = setTimeout(() => resolve("timed_out"), Math.max(1, timeoutMs));
      }),
    ]);

    if (timeout) {
      clearTimeout(timeout);
    }

    if (outcome === "timed_out") {
      this.options.logger.warn("async queue stop timed out with active tasks", {
        activeTasks: this.activeTasks.size,
        timeoutMs,
      });
    }
  }

  private async runInferenceJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);

    if (!job || job.status !== "queued") {
      return;
    }

    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.attempts += 1;
    delete job.error;
    await this.persistJob(job);

    try {
      const result = await this.options.runtime.infer(job.request);
      job.status = "succeeded";
      job.result = result;
      delete job.error;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      await this.persistJob(job);

      if (job.callback?.status === "pending") {
        this.enqueueCallbackJobId(job.id);
      }
    } catch (error) {
      const retryable = shouldRetryJob(error) && job.attempts < job.maxAttempts;
      job.error = toJobError(error);
      job.updatedAt = new Date().toISOString();
      delete job.result;
      delete job.completedAt;

      if (retryable) {
        job.status = "queued";
        await this.persistJob(job);
        this.scheduleRetry(job.id, "job");
        return;
      }

      job.status = "failed";
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      await this.persistJob(job);

      if (job.callback?.status === "pending") {
        this.enqueueCallbackJobId(job.id);
      }
    }
  }

  private async deliverCallback(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);

    if (
      !job ||
      !job.callback ||
      job.callback.status !== "pending" ||
      !isTerminalJobStatus(job.status)
    ) {
      return;
    }

    const callback = job.callback;
    callback.attempts += 1;
    callback.lastAttemptAt = new Date().toISOString();
    job.updatedAt = callback.lastAttemptAt;
    await this.persistJob(job);

    try {
      const response = await this.requestCallback(job);
      await discardResponseBody(response);

      if (!response.ok) {
        throw new Error(`Callback endpoint responded with ${response.status}`);
      }

      callback.status = "delivered";
      callback.deliveredAt = new Date().toISOString();
      delete callback.lastError;
      job.updatedAt = callback.deliveredAt;
      await this.persistJob(job);
    } catch (error) {
      callback.lastError = truncateJobErrorString(toErrorMessage(error));
      job.updatedAt = new Date().toISOString();

      if (callback.attempts < this.options.config.maxCallbackAttempts) {
        await this.persistJob(job);
        this.scheduleRetry(job.id, "callback");
        return;
      }

      callback.status = "failed";
      await this.persistJob(job);
    }
  }

  private async requestCallback(job: InferenceJobRecord): Promise<Response> {
    const callbackUrl = await normalizeCallbackUrl(
      job.callback?.url,
      this.options.config,
      this.lookupImpl,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`Callback delivery exceeded ${this.options.config.callbackTimeoutMs}ms`),
      );
    }, this.options.config.callbackTimeoutMs);

    try {
      return await this.fetchImpl(callbackUrl ?? "", {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          job,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleRetry(jobId: string, kind: "job" | "callback"): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);

      if (!this.started) {
        return;
      }

      if (kind === "job") {
        this.enqueueJobId(jobId);
      } else {
        this.enqueueCallbackJobId(jobId);
      }

      this.requestDrain();
    }, this.options.config.pollIntervalMs);

    this.retryTimers.set(timer, { kind, jobId });
  }

  private enqueueJobId(jobId: string): void {
    if (!this.queuedJobIds.includes(jobId)) {
      this.queuedJobIds.push(jobId);
    }
  }

  private enqueueCallbackJobId(jobId: string): void {
    if (!this.pendingCallbackJobIds.includes(jobId)) {
      this.pendingCallbackJobIds.push(jobId);
    }
  }

  private normalizeJobId(jobId: string): string {
    if (!isSafeJobId(jobId)) {
      throw new RayError("job id is invalid", {
        code: "invalid_request",
        status: 400,
        details: {
          maxChars: MAX_JOB_ID_CHARS,
        },
      });
    }

    return jobId;
  }

  private getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private isCompletedJobExpired(job: InferenceJobRecord, nowMs = Date.now()): boolean {
    if (!isTerminalJobStatus(job.status) || job.callback?.status === "pending") {
      return false;
    }

    const updatedAtMs = Date.parse(job.updatedAt);

    return (
      Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= this.options.config.completedTtlMs
    );
  }

  private async pruneCompletedJob(
    job: InferenceJobRecord,
    filePath = this.getJobPath(job.id),
  ): Promise<boolean> {
    if (!this.isCompletedJobExpired(job)) {
      return false;
    }

    this.jobs.delete(job.id);
    this.removeQueuedJobId(job.id);
    this.removeCallbackJobId(job.id);

    try {
      await this.removeFileImpl(filePath);
    } catch (error) {
      this.options.logger.warn("failed to prune expired async job", {
        jobId: job.id,
        filePath,
        error: toErrorMessage(error),
      });
    }

    return true;
  }

  private async pruneCompletedJobs(): Promise<void> {
    const jobs = [...this.jobs.values()];

    for (let offset = 0; offset < jobs.length; offset += ASYNC_QUEUE_PRUNE_CONCURRENCY) {
      await Promise.all(
        jobs
          .slice(offset, offset + ASYNC_QUEUE_PRUNE_CONCURRENCY)
          .map((job) => this.pruneCompletedJob(job)),
      );
    }
  }

  private async removeOverflowPersistedJob(
    job: InferenceJobRecord,
    filePath: string,
  ): Promise<void> {
    if (hasPendingWork(job)) {
      return;
    }

    try {
      await this.removeFileImpl(filePath);
    } catch (error) {
      this.options.logger.warn("failed to remove overflow persisted async job", {
        jobId: job.id,
        filePath,
        error: toErrorMessage(error),
      });
    }
  }

  private removeQueuedJobId(jobId: string): void {
    const index = this.queuedJobIds.indexOf(jobId);
    if (index !== -1) {
      this.queuedJobIds.splice(index, 1);
    }
  }

  private removeCallbackJobId(jobId: string): void {
    const index = this.pendingCallbackJobIds.indexOf(jobId);
    if (index !== -1) {
      this.pendingCallbackJobIds.splice(index, 1);
    }
  }

  private async removeStaleTempFile(filePath: string): Promise<void> {
    try {
      await this.removeFileImpl(filePath);
    } catch (error) {
      this.options.logger.warn("failed to remove stale async job temp file", {
        filePath,
        error: toErrorMessage(error),
      });
    }
  }

  private async removeInvalidPersistedJob(filePath: string): Promise<void> {
    try {
      await this.removeFileImpl(filePath);
    } catch (error) {
      this.options.logger.warn("failed to remove invalid persisted async job", {
        filePath,
        error: toErrorMessage(error),
      });
    }
  }

  private async persistJob(job: InferenceJobRecord): Promise<void> {
    await writeJsonAtomic(this.getJobPath(job.id), stringifyPersistedJob(job));
  }
}
