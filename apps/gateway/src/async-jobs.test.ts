import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createRayRuntime } from "@ray/runtime";
import { Logger } from "@ray/telemetry";
import { RayError, type ModelProvider } from "@razroo/ray-core";
import { DurableInferenceQueue } from "./async-jobs.js";

const PERSISTED_JOB_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

async function waitFor<T>(
  load: () => Promise<T | undefined>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await load();
    if (value && predicate(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for condition");
}

test("durable inference queue rejects invalid direct config", () => {
  const runtime = createRayRuntime(createDefaultConfig("tiny"));
  const logger = new Logger("test", "error");
  const config = createDefaultConfig("tiny").asyncQueue;

  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          maxJobs: 0,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.maxJobs/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          dispatchConcurrency: Infinity,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.dispatchConcurrency/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          minFreeStorageMiB: 0,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.minFreeStorageMiB/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          callbackAllowPrivateNetwork: "true" as unknown as boolean,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.callbackAllowPrivateNetwork/,
  );
});

test("durable inference queue snapshots config at construction", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    config.asyncQueue.maxJobs = 2;

    await queue.enqueue({
      input: "first",
    });
    await assert.rejects(
      () =>
        queue.enqueue({
          input: "second",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "async_queue_full",
    );

    assert.equal(queue.snapshot().maxJobs, 1);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue rejects new jobs when storage reserve is exhausted", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-storage-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        minFreeStorageMiB: 128,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      statfsImpl: async () => ({
        bavail: 127,
        bsize: 1024 * 1024,
      }),
    });

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "should be rejected before disk is exhausted",
        }),
      (error: unknown) =>
        error instanceof RayError &&
        error.code === "async_queue_storage_low" &&
        error.status === 503 &&
        (error.details as { availableMiB?: number }).availableMiB === 127 &&
        (error.details as { minFreeStorageMiB?: number }).minFreeStorageMiB === 128,
    );
    assert.equal(queue.snapshot().totalJobs, 0);
    assert.equal(queue.snapshot().minFreeStorageMiB, 128);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue recovers queued jobs from disk", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");

    const queueBeforeRestart = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const queuedJob = await queueBeforeRestart.enqueue({
      input: "Recover me after restart",
    });

    const queueAfterRestart = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queueAfterRestart.start();

    const completedJob = await waitFor(
      async () => queueAfterRestart.get(queuedJob.id),
      (job) => job.status === "succeeded",
    );

    assert.equal(completedJob.status, "succeeded");
    assert.match(completedJob.result?.output ?? "", /Recover me after restart/);

    await queueAfterRestart.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue fails recovered running jobs with exhausted attempts", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const jobsDir = join(storageDir, "jobs");
    const now = new Date().toISOString();
    await mkdir(jobsDir, { recursive: true });
    await writeFile(
      join(jobsDir, "job_running.json"),
      JSON.stringify({
        id: "job_running",
        status: "running",
        request: {
          input: "should not run again after restart",
        },
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attempts: 2,
        maxAttempts: 2,
      }),
    );

    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    const recovered = await queue.get("job_running");
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.attempts, 2);
    assert.equal(recovered?.error?.code, "job_recovery_attempts_exhausted");
    assert.equal(recovered?.result, undefined);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue fails oversized persisted results without writing oversized records", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      cache: {
        enabled: false,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const provider: ModelProvider = {
      modelId: config.model.id,
      kind: "mock",
      capabilities: {
        streaming: false,
        quantized: false,
        localBackend: true,
      },
      infer: async () => ({
        output: "x".repeat(PERSISTED_JOB_FILE_LIMIT_BYTES),
      }),
    };
    const runtime = createRayRuntime(config, { provider });
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const queuedJob = await queue.enqueue({
      input: "oversized persisted result",
    });

    await queue.start();

    const failedJob = await waitFor(
      async () => queue.get(queuedJob.id),
      (job) => job.status === "failed",
    );
    await queue.stop();

    const stats = await fs.stat(join(storageDir, "jobs", `${queuedJob.id}.json`));

    assert.equal(failedJob.attempts, 1);
    assert.equal(failedJob.result, undefined);
    assert.equal(failedJob.error?.code, "async_job_record_too_large");
    assert.ok(stats.size <= PERSISTED_JOB_FILE_LIMIT_BYTES);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue persists bounded JSON-safe job error details", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 1,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const details: Record<string, unknown> = {
      count: 2n,
      huge: "x".repeat(20_000),
      bytes: new Uint8Array(16),
      values: Array.from({ length: 40 }, (_value, index) => index),
    };
    details.self = details;
    Object.defineProperty(details, "explode", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    const runtime = {
      config,
      infer: async () => {
        throw new RayError("backend returned hostile diagnostics", {
          code: "provider_upstream_error",
          status: 502,
          details,
        });
      },
    } as unknown as ReturnType<typeof createRayRuntime>;
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const queuedJob = await queue.enqueue({
      input: "hostile error details",
    });

    await queue.start();

    const failedJob = await waitFor(
      async () => queue.get(queuedJob.id),
      (job) => job.status === "failed",
    );
    await queue.stop();

    const raw = await fs.readFile(join(storageDir, "jobs", `${queuedJob.id}.json`), "utf8");
    const persisted = JSON.parse(raw) as {
      error?: {
        details?: {
          count?: string;
          huge?: string;
          self?: string;
          explode?: string;
          bytes?: string;
          values?: unknown[];
        };
      };
    };
    const errorDetails = persisted.error?.details;

    assert.equal(failedJob.error?.code, "provider_upstream_error");
    assert.equal(errorDetails?.count, "2");
    assert.match(errorDetails?.huge ?? "", /\[truncated \d+ chars\]$/);
    assert.equal(errorDetails?.self, "[Circular]");
    assert.equal(errorDetails?.explode, "[Thrown: getter boom]");
    assert.equal(errorDetails?.bytes, "[Uint8Array 16 bytes]");
    assert.equal(errorDetails?.values?.at(-1), "[Truncated 8 items]");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue skips malformed persisted jobs during recovery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const jobsDir = join(storageDir, "jobs");
    const now = new Date().toISOString();
    await mkdir(jobsDir, { recursive: true });
    await writeFile(
      join(jobsDir, "job_bad.json"),
      JSON.stringify({
        id: "job_bad",
        status: "queued",
        request: {
          input: "bad persisted job",
        },
        attempts: 0,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_good.json"),
      JSON.stringify({
        id: "job_good",
        status: "queued",
        request: {
          input: "good persisted job",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_mismatch.json"),
      JSON.stringify({
        id: "job_other",
        status: "queued",
        request: {
          input: "mismatched persisted job",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_id_too_long.json"),
      JSON.stringify({
        id: "x".repeat(129),
        status: "queued",
        request: {
          input: "oversized persisted job id",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_too_long.json"),
      JSON.stringify({
        id: "job_callback_too_long",
        status: "failed",
        request: {
          input: "oversized persisted callback url",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: `https://example.com/${"x".repeat(2_048)}`,
          status: "pending",
          attempts: 0,
        },
      }),
    );

    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    assert.equal(await queue.get("job_bad"), undefined);
    assert.equal(await queue.get("job_mismatch"), undefined);
    assert.equal(await queue.get("job_other"), undefined);
    assert.equal(await queue.get("job_id_too_long"), undefined);
    assert.equal(await queue.get("job_callback_too_long"), undefined);

    const completedJob = await waitFor(
      async () => queue.get("job_good"),
      (job) => job.status === "succeeded",
    );
    assert.match(completedJob.result?.output ?? "", /good persisted job/);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue skips oversized persisted jobs during recovery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const jobsDir = join(storageDir, "jobs");
    const now = new Date().toISOString();
    await mkdir(jobsDir, { recursive: true });
    await writeFile(join(jobsDir, "job_oversized.json"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFile(
      join(jobsDir, "job_good.json"),
      JSON.stringify({
        id: "job_good",
        status: "queued",
        request: {
          input: "good persisted job after oversized file",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );

    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    assert.equal(await queue.get("job_oversized"), undefined);

    const completedJob = await waitFor(
      async () => queue.get("job_good"),
      (job) => job.status === "succeeded",
    );
    assert.match(completedJob.result?.output ?? "", /good persisted job after oversized file/);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue enforces retained job cap during recovery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const jobsDir = join(storageDir, "jobs");
    const terminalAt = new Date(Date.now() - 60_000).toISOString();
    const queuedAt = new Date().toISOString();
    await mkdir(jobsDir, { recursive: true });
    await writeFile(
      join(jobsDir, "job_terminal.json"),
      JSON.stringify({
        id: "job_terminal",
        status: "succeeded",
        request: {
          input: "terminal job should overflow",
        },
        createdAt: terminalAt,
        updatedAt: terminalAt,
        completedAt: terminalAt,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_queued.json"),
      JSON.stringify({
        id: "job_queued",
        status: "queued",
        request: {
          input: "queued job should be retained",
        },
        createdAt: queuedAt,
        updatedAt: queuedAt,
        attempts: 0,
        maxAttempts: 2,
      }),
    );

    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    const completedJob = await waitFor(
      async () => queue.get("job_queued"),
      (job) => job.status === "succeeded",
    );
    assert.match(completedJob.result?.output ?? "", /queued job should be retained/);
    assert.equal(await queue.get("job_terminal"), undefined);
    assert.equal(queue.snapshot().totalJobs, 1);
    assert.equal((await readdir(jobsDir)).includes("job_terminal.json"), false);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue streams persisted job recovery without readdir", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const jobsDir = join(storageDir, "jobs");
    const now = new Date().toISOString();
    await mkdir(jobsDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 128 }, (_value, index) =>
        writeFile(join(jobsDir, `ignored-${index}.txt`), "ignored", "utf8"),
      ),
    );
    await writeFile(
      join(jobsDir, "job_streamed.json"),
      JSON.stringify({
        id: "job_streamed",
        status: "queued",
        request: {
          input: "streamed recovery job",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );

    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const originalReaddir = fs.readdir;

    Object.defineProperty(fs, "readdir", {
      configurable: true,
      value: async () => {
        throw new Error("readdir should not be used during async job recovery");
      },
    });
    t.after(() => {
      Object.defineProperty(fs, "readdir", {
        configurable: true,
        value: originalReaddir,
      });
    });

    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    const completedJob = await waitFor(
      async () => queue.get("job_streamed"),
      (job) => job.status === "succeeded",
    );
    assert.match(completedJob.result?.output ?? "", /streamed recovery job/);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue removes stale atomic-write temp files during recovery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const jobsDir = join(storageDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    await writeFile(join(jobsDir, ".tmp-job_stale.json-deadbeef"), "partial");

    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    await queue.start();

    const entries = await readdir(jobsDir);
    assert.equal(
      entries.some((entry) => entry.startsWith(".tmp-")),
      false,
    );

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue rejects private and non-global callbacks by default", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not call local callback",
          callbackUrl: "http://127.0.0.1:8080/callback",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "invalid_request",
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not call documentation-only callback",
          callbackUrl: "http://203.0.113.10/ray-callback",
        }),
      /private, local, or non-global/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not call documentation-only IPv6 callback",
          callbackUrl: "http://[2001:db8::1]/ray-callback",
        }),
      /private, local, or non-global/,
    );

    const dnsQueue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => [{ address: "198.51.100.7" }],
    });

    await assert.rejects(
      () =>
        dnsQueue.enqueue({
          input: "Do not call non-global DNS callback",
          callbackUrl: "https://callback.example/ray-callback",
        }),
      /private, local, or non-global/,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue rejects malformed callbackUrl values", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Bad callback",
          callbackUrl: 123,
        } as unknown as Parameters<typeof queue.enqueue>[0]),
      /callbackUrl must be a non-empty string/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Blank callback",
          callbackUrl: "   ",
        }),
      /callbackUrl must be a non-empty string/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Long callback",
          callbackUrl: `https://example.com/${"x".repeat(2_048)}`,
        }),
      /callbackUrl must be at most 2048 characters/,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue bounds job id lookups", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const jobsDir = join(storageDir, "jobs");
    const now = new Date().toISOString();

    await mkdir(jobsDir, { recursive: true });
    await writeFile(
      join(jobsDir, "job_lookup.json"),
      JSON.stringify({
        id: "job_other",
        status: "queued",
        request: {
          input: "mismatched lazy lookup job",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );

    await assert.rejects(() => queue.get("../job"), /job id is invalid/);
    await assert.rejects(() => queue.get("x".repeat(129)), /job id is invalid/);
    assert.equal(await queue.get("job_lookup"), undefined);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue bounds callback hostname resolution during admission", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 25,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => new Promise<never>(() => undefined),
    });

    const startedAt = Date.now();
    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not wait forever on DNS",
          callbackUrl: "https://slow-dns.example/ray-callback",
        }),
      /callbackUrl hostname resolution timed out/,
    );

    assert.ok(Date.now() - startedAt < 500);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue rejects new jobs when retained job store is full", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    await queue.enqueue({
      input: "First job fits",
    });

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Second job exceeds retained store cap",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "async_queue_full",
    );

    const snapshot = queue.snapshot();
    assert.equal(snapshot.totalJobs, 1);
    assert.equal(snapshot.maxJobs, 1);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue enforces the retained job cap under concurrent submissions", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    const results = await Promise.allSettled([
      queue.enqueue({
        input: "Concurrent job A",
      }),
      queue.enqueue({
        input: "Concurrent job B",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          "code" in result.reason &&
          (result.reason as { code?: string }).code === "async_queue_full",
      ),
    );
    assert.equal(queue.snapshot().totalJobs, 1);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue stop returns when an active inference ignores cancellation", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const logger = new Logger("test", "error");
    let releaseInference: (() => void) | undefined;
    let markInferenceStarted!: () => void;
    const inferenceStarted = new Promise<void>((resolve) => {
      markInferenceStarted = resolve;
    });
    const runtime = {
      config,
      infer: async () => {
        markInferenceStarted();
        await new Promise<void>((resolve) => {
          releaseInference = resolve;
        });

        return {
          id: "test-inference",
          model: config.model.id,
          output: "done",
          usage: {
            chars: {
              prompt: 0,
              completion: 4,
              total: 4,
            },
          },
          cached: false,
          deduplicated: false,
          queueTimeMs: 0,
          latencyMs: 0,
          degraded: false,
          createdAt: new Date().toISOString(),
        };
      },
    } as unknown as ReturnType<typeof createRayRuntime>;
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const job = await queue.enqueue({
      input: "Never resolves",
    });

    await queue.start();
    await Promise.race([
      inferenceStarted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Inference did not start")), 2_000);
      }),
    ]);
    assert.equal((await queue.get(job.id))?.status, "running");

    const startedAt = Date.now();
    await queue.stop({ timeoutMs: 10 });

    assert.ok(Date.now() - startedAt < 500);
    assert.equal((await queue.get(job.id))?.status, "running");

    if (!releaseInference) {
      throw new Error("Inference did not start");
    }

    releaseInference();
    await waitFor(
      async () => queue.get(job.id),
      (value) => value.status === "succeeded",
    );
    await queue.stop({ timeoutMs: 2_000 });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue prunes expired completed jobs from the retained store", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const jobsDir = join(storageDir, "jobs");
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await mkdir(jobsDir, { recursive: true });
    await writeFile(
      join(jobsDir, "job_expired.json"),
      JSON.stringify({
        id: "job_expired",
        status: "succeeded",
        request: {
          input: "Already completed",
        },
        createdAt: expiredAt,
        updatedAt: expiredAt,
        completedAt: expiredAt,
        attempts: 1,
        maxAttempts: 1,
      }),
    );

    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
        completedTtlMs: 1,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    await queue.start();
    const job = await queue.enqueue({
      input: "New job should fit after pruning",
    });

    assert.notEqual(job.id, "job_expired");
    assert.equal(await queue.get("job_expired"), undefined);
    assert.equal(queue.snapshot().totalJobs, 1);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue does not prune expired jobs while callbacks are pending", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 1,
        completedTtlMs: 1,
        pollIntervalMs: 1_000,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 5,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      fetchImpl: async () => new Response(null, { status: 500 }),
    });

    const job = await queue.enqueue({
      input: "Callback should stay pending",
      callbackUrl: "http://93.184.216.34/ray-callback",
    });

    await queue.start();
    await waitFor(
      async () => queue.get(job.id),
      (value) =>
        value.status === "succeeded" &&
        value.callback?.status === "pending" &&
        value.callback.attempts === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Pending callback should still count against the cap",
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "async_queue_full",
    );

    assert.equal(queue.snapshot().totalJobs, 1);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue delivers callbacks without following redirects", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 2,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 5,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const callbackRequests: RequestInit[] = [];
    let callbackBodyCancelled = false;
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      fetchImpl: async (_url, init) => {
        callbackRequests.push(init ?? {});
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              callbackBodyCancelled = true;
            },
          }),
          { status: 200 },
        );
      },
    });
    const job = await queue.enqueue({
      input: "Deliver callback",
      callbackUrl: "http://93.184.216.34/ray-callback",
    });

    await queue.start();

    const completedJob = await waitFor(
      async () => queue.get(job.id),
      (value) => value.callback?.status === "delivered",
    );

    assert.equal(completedJob.status, "succeeded");
    assert.equal(completedJob.callback?.status, "delivered");
    assert.equal(callbackRequests[0]?.redirect, "manual");
    assert.equal(callbackBodyCancelled, true);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
