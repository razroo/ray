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

export interface CreateDurableInferenceQueueOptions {
  config: AsyncQueueConfig;
  runtime: RayRuntime;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

function isTerminalJobStatus(status: InferenceJobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed";
}

function cloneJobRecord(job: InferenceJobRecord): InferenceJobRecord {
  return structuredClone(job);
}

function cloneRequest(request: CreateInferenceJobRequest): InferenceRequest {
  const next = structuredClone(request) as CreateInferenceJobRequest;
  delete next.callbackUrl;
  return next;
}

function toJobError(error: unknown): InferenceJobError {
  if (error instanceof RayError) {
    return {
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }

  return {
    message: toErrorMessage(error),
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

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first = 0, second = 0] = parts;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mappedIpv4?.[1]) {
    return isPrivateIpv4(mappedIpv4[1]);
  }

  const firstSegment = normalized.split(":")[0] ?? "";

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(firstSegment)
  );
}

function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return isPrivateIpv4(address);
  }

  if (version === 6) {
    return isPrivateIpv6(address);
  }

  return false;
}

async function resolveCallbackAddresses(hostname: string): Promise<string[]> {
  const normalized = normalizeHostname(hostname);

  if (isIP(normalized)) {
    return [normalized];
  }

  try {
    const records = await lookup(normalized, {
      all: true,
      verbatim: true,
    });
    return records.map((record) => record.address);
  } catch (error) {
    throw new RayError("callbackUrl hostname could not be resolved", {
      code: "invalid_request",
      status: 400,
      details: error,
    });
  }
}

async function assertCallbackNetworkAllowed(parsed: URL, config: AsyncQueueConfig): Promise<void> {
  if (matchesAllowedHost(parsed.hostname, config.callbackAllowedHosts)) {
    return;
  }

  if (config.callbackAllowPrivateNetwork) {
    return;
  }

  const addresses = await resolveCallbackAddresses(parsed.hostname);
  const blockedAddress = addresses.find((address) => isPrivateNetworkAddress(address));

  if (blockedAddress) {
    throw new RayError("callbackUrl resolves to a private or local network address", {
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
  callbackUrl: string | undefined,
  config: AsyncQueueConfig,
): Promise<string | undefined> {
  if (!isNonEmptyString(callbackUrl)) {
    return undefined;
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

  await assertCallbackNetworkAllowed(parsed, config);

  return parsed.toString();
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.tmp-${path.basename(filePath)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
  );
  const body = JSON.stringify(value, null, 2);
  await fs.writeFile(tempPath, body, "utf8");
  await fs.rename(tempPath, filePath);
}

export class DurableInferenceQueue {
  private readonly jobs = new Map<string, InferenceJobRecord>();
  private readonly queuedJobIds: string[] = [];
  private readonly pendingCallbackJobIds: string[] = [];
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly jobsDir: string;
  private readyPromise: Promise<void> | undefined;
  private started = false;
  private activeInferenceJobs = 0;
  private activeCallbackDeliveries = 0;

  constructor(private readonly options: CreateDurableInferenceQueueOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.jobsDir = path.join(options.config.storageDir, "jobs");
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

  async stop(): Promise<void> {
    this.started = false;

    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();

    await Promise.allSettled([...this.activeTasks]);
  }

  snapshot(): AsyncQueueSnapshot {
    let running = 0;
    let callbackPending = 0;

    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        running += 1;
      }

      if (job.callback?.status === "pending") {
        callbackPending += 1;
      }
    }

    return {
      enabled: true,
      queued: this.queuedJobIds.length,
      running,
      callbackPending,
      totalJobs: this.jobs.size,
      dispatchConcurrency: this.options.config.dispatchConcurrency,
    };
  }

  async enqueue(request: CreateInferenceJobRequest): Promise<InferenceJobRecord> {
    await this.ensureReady();
    normalizeInferenceRequest(this.options.runtime.config, cloneRequest(request));

    const callbackUrl = await normalizeCallbackUrl(request.callbackUrl, this.options.config);
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
    await this.persistJob(job);
    this.enqueueJobId(job.id);
    this.requestDrain();

    return cloneJobRecord(job);
  }

  async get(jobId: string): Promise<InferenceJobRecord | undefined> {
    const normalizedId = this.normalizeJobId(jobId);
    const existing = this.jobs.get(normalizedId);

    if (existing) {
      return cloneJobRecord(existing);
    }

    await this.ensureReady();

    try {
      const raw = await fs.readFile(this.getJobPath(normalizedId), "utf8");
      const parsed = JSON.parse(raw) as InferenceJobRecord;
      this.jobs.set(parsed.id, parsed);
      return cloneJobRecord(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
    this.readyPromise ??= fs.mkdir(this.jobsDir, { recursive: true }).then(() => undefined);
    await this.readyPromise;
  }

  private async loadJobsFromDisk(): Promise<void> {
    this.jobs.clear();
    this.queuedJobIds.length = 0;
    this.pendingCallbackJobIds.length = 0;

    const entries = await fs.readdir(this.jobsDir, { withFileTypes: true });
    const recoveredJobs: InferenceJobRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.jobsDir, entry.name);

      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as InferenceJobRecord;

        if (parsed.status === "running") {
          parsed.status = "queued";
          parsed.updatedAt = new Date().toISOString();
          parsed.error = {
            code: "job_recovered",
            message: "The job was returned to the durable queue after a restart",
          };
          await this.persistJob(parsed);
        }

        recoveredJobs.push(parsed);
      } catch (error) {
        this.options.logger.warn("failed to load persisted async job", {
          filePath,
          error: toErrorMessage(error),
        });
      }
    }

    recoveredJobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

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
      const task = this.runInferenceJob(jobId).finally(() => {
        this.activeInferenceJobs -= 1;
        this.activeTasks.delete(task);
        this.requestDrain();
      });
      this.activeTasks.add(task);
    }

    while (this.activeCallbackDeliveries < 1 && this.pendingCallbackJobIds.length > 0) {
      const jobId = this.pendingCallbackJobIds.shift();

      if (!jobId) {
        break;
      }

      this.activeCallbackDeliveries += 1;
      const task = this.deliverCallback(jobId).finally(() => {
        this.activeCallbackDeliveries -= 1;
        this.activeTasks.delete(task);
        this.requestDrain();
      });
      this.activeTasks.add(task);
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

      if (!response.ok) {
        throw new Error(`Callback endpoint responded with ${response.status}`);
      }

      callback.status = "delivered";
      callback.deliveredAt = new Date().toISOString();
      delete callback.lastError;
      job.updatedAt = callback.deliveredAt;
      await this.persistJob(job);
    } catch (error) {
      callback.lastError = toErrorMessage(error);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`Callback delivery exceeded ${this.options.config.callbackTimeoutMs}ms`),
      );
    }, this.options.config.callbackTimeoutMs);

    try {
      return await this.fetchImpl(job.callback?.url ?? "", {
        method: "POST",
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

    this.retryTimers.add(timer);
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
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
      throw new RayError("job id is invalid", {
        code: "invalid_request",
        status: 400,
      });
    }

    return jobId;
  }

  private getJobPath(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private async persistJob(job: InferenceJobRecord): Promise<void> {
    await writeJsonAtomic(this.getJobPath(job.id), job);
  }
}
