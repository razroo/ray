import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createRayRuntime, type RayRuntime } from "@ray/runtime";
import { Logger } from "@ray/telemetry";
import { RayError } from "@razroo/ray-core";
import { DurableInferenceQueue } from "./async-jobs.js";

const PERSISTED_JOB_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
const ASYNC_QUEUE_RECOVERY_ENTRY_LIMIT = 4_096;
const ASYNC_QUEUE_RECOVERY_TEMP_REMOVAL_LIMIT = 2_048;
const MAX_PERSISTED_RESULT_OUTPUT_CHARS = 262_144;

function persistedInferenceResult(
  output: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "req_persisted_test",
    model: "mock-model",
    output,
    usage: {
      chars: {
        prompt: 0,
        completion: output.length,
        total: output.length,
      },
    },
    cached: false,
    deduplicated: false,
    queueTimeMs: 0,
    latencyMs: 1,
    degraded: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function writeFilesInBatches(
  directory: string,
  count: number,
  toFileName: (index: number) => string,
  body: string,
): Promise<void> {
  const batchSize = 128;

  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - offset) }, (_value, index) =>
        writeFile(join(directory, toFileName(offset + index)), body, "utf8"),
      ),
    );
  }
}

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
          storageDir: "",
        },
        runtime,
        logger,
      }),
    /asyncQueue\.storageDir must be a non-empty string/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          storageDir: " .ray/jobs",
        },
        runtime,
        logger,
      }),
    /asyncQueue\.storageDir must be a path without surrounding whitespace/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          storageDir: ".ray/jobs\n",
        },
        runtime,
        logger,
      }),
    /asyncQueue\.storageDir must not contain control characters/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          storageDir: "x".repeat(4_097),
        },
        runtime,
        logger,
      }),
    /asyncQueue\.storageDir must be at most 4096 bytes/,
  );
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
          maxAttempts: 101,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.maxAttempts/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          maxCallbackAttempts: 101,
        },
        runtime,
        logger,
      }),
    /asyncQueue\.maxCallbackAttempts/,
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
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          callbackAllowedHosts: ["https://callback.example/ray-callback"],
        },
        runtime,
        logger,
      }),
    /asyncQueue\.callbackAllowedHosts entries must be exact host\/IP literals/,
  );
  assert.throws(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          callbackAllowedHosts: ["*"],
        },
        runtime,
        logger,
      }),
    /asyncQueue\.callbackAllowedHosts entries must be exact host\/IP literals/,
  );
  assert.doesNotThrow(
    () =>
      new DurableInferenceQueue({
        config: {
          ...config,
          callbackAllowedHosts: [
            "callback.example",
            "*.trusted.example",
            "127.0.0.1",
            "[2001:db8::1]",
          ],
        },
        runtime,
        logger,
      }),
  );
});

test("durable inference queue rejects malformed direct stop timeouts", async () => {
  const config = createDefaultConfig("tiny");
  const queue = new DurableInferenceQueue({
    config: config.asyncQueue,
    runtime: createRayRuntime(config),
    logger: new Logger("test", "error"),
  });

  await assert.rejects(
    () => queue.stop({ timeoutMs: 0 }),
    /async queue stop timeoutMs must be a positive safe integer/,
  );
  await assert.rejects(
    () => queue.stop({ timeoutMs: Number.POSITIVE_INFINITY }),
    /async queue stop timeoutMs must be a positive safe integer/,
  );
  await assert.rejects(
    () => queue.stop({ timeoutMs: 121_001 }),
    /async queue stop timeoutMs must be less than or equal to 121000/,
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
        pollIntervalMs: 750,
        dispatchConcurrency: 2,
        maxAttempts: 4,
        callbackTimeoutMs: 1_500,
        maxCallbackAttempts: 3,
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

    const snapshot = queue.snapshot();
    assert.equal(snapshot.maxJobs, 1);
    assert.equal(snapshot.jobsRatio, 1);
    assert.equal(snapshot.jobsPressure, true);
    assert.equal(snapshot.pressureThreshold, 0.9);
    assert.equal(snapshot.degraded, true);
    assert.equal(snapshot.activeInferenceJobs, 0);
    assert.equal(snapshot.activeCallbackDeliveries, 0);
    assert.equal(snapshot.pollIntervalMs, 750);
    assert.equal(snapshot.dispatchConcurrency, 2);
    assert.equal(snapshot.callbackConcurrency, 1);
    assert.equal(snapshot.maxAttempts, 4);
    assert.equal(snapshot.callbackTimeoutMs, 1_500);
    assert.equal(snapshot.maxCallbackAttempts, 3);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue creates private persisted job state", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode assertions are unavailable on Windows");
    return;
  }

  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-private-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });
    const queuedJob = await queue.enqueue({
      input: "private persisted prompt",
    });
    const jobsDir = join(storageDir, "jobs");
    const jobPath = join(jobsDir, `${queuedJob.id}.json`);
    const [jobsDirStats, jobStats] = await Promise.all([fs.stat(jobsDir), fs.stat(jobPath)]);

    assert.equal(jobsDirStats.mode & 0o777, 0o700);
    assert.equal(jobStats.mode & 0o777, 0o600);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue snapshots active inference dispatches", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-active-inference-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        dispatchConcurrency: 1,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 250,
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
      input: "slow active inference",
    });
    await queue.start();

    const snapshot = await waitFor(
      async () => queue.snapshot(),
      (value) => value.activeInferenceJobs === 1,
    );

    assert.equal(snapshot.running, 1);
    assert.equal(snapshot.activeInferenceJobs, 1);
    assert.equal(snapshot.queued, 0);

    const completed = await waitFor(
      async () => queue.snapshot(),
      (value) => value.succeeded === 1 && value.activeInferenceJobs === 0,
    );
    assert.equal(completed.activeInferenceJobs, 0);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue snapshots active callback deliveries", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-active-callback-"));
  let completeCallback: (() => void) | undefined;
  let markCallbackStarted: (() => void) | undefined;
  const callbackStarted = new Promise<void>((resolve) => {
    markCallbackStarted = resolve;
  });
  const callbackResponse = new Promise<Response>((resolve) => {
    completeCallback = () => resolve(new Response(null, { status: 200 }));
  });

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        callbackTimeoutMs: 1_000,
        callbackAllowedHosts: ["callback.example"],
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 1,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      fetchImpl: async () => {
        markCallbackStarted?.();
        return callbackResponse;
      },
    });

    await queue.enqueue({
      input: "callback stays active",
      callbackUrl: "https://callback.example/ray",
    });
    await queue.start();
    await callbackStarted;

    const active = queue.snapshot();
    assert.equal(active.succeeded, 1);
    assert.equal(active.callbackPending, 1);
    assert.equal(active.activeCallbackDeliveries, 1);
    assert.equal(active.callbackConcurrency, 1);

    completeCallback?.();
    const delivered = await waitFor(
      async () => queue.snapshot(),
      (value) => value.callbackDelivered === 1 && value.activeCallbackDeliveries === 0,
    );
    assert.equal(delivered.activeCallbackDeliveries, 0);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue reports job pressure before admission is full", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-pressure-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 10,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
    });

    for (let index = 0; index < 9; index += 1) {
      await queue.enqueue({
        input: `pressure ${index}`,
      });
    }

    const snapshot = queue.snapshot();
    assert.equal(snapshot.totalJobs, 9);
    assert.equal(snapshot.maxJobs, 10);
    assert.equal(snapshot.jobsRatio, 0.9);
    assert.equal(snapshot.jobsPressure, true);
    assert.equal(snapshot.pressureThreshold, 0.9);
    assert.equal(snapshot.degraded, true);

    await queue.enqueue({
      input: "still admitted at pressure threshold",
    });
    assert.equal(queue.snapshot().totalJobs, 10);
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
    const snapshot = await queue.snapshotWithStorage();
    assert.equal(snapshot.totalJobs, 0);
    assert.equal(snapshot.pendingAdmissions, 0);
    assert.equal(snapshot.minFreeStorageMiB, 128);
    assert.equal(snapshot.availableStorageMiB, 127);
    assert.equal(snapshot.reservedAdmissionMiB, 0);
    assert.equal(snapshot.effectiveAvailableStorageMiB, 127);
    assert.equal(snapshot.storageReserveRatio, 0.9922);
    assert.equal(snapshot.storageLow, true);
    assert.equal(snapshot.storageAdmissionReserveRatio, 0.9922);
    assert.equal(snapshot.storageAdmissionLow, true);
    assert.equal(snapshot.degraded, true);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue reserves storage headroom for concurrent admissions", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-storage-concurrent-"));
  let statfsCalls = 0;
  let releaseStatfs!: () => void;
  const bothAdmissionsReserved = new Promise<void>((resolve) => {
    releaseStatfs = resolve;
  });

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 2,
        minFreeStorageMiB: 2,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      statfsImpl: async () => {
        statfsCalls += 1;
        if (statfsCalls >= 2) {
          releaseStatfs();
        }
        await Promise.race([
          bothAdmissionsReserved,
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
        return {
          bavail: 5,
          bsize: 1024 * 1024,
        };
      },
    });

    const results = await Promise.allSettled([
      queue.enqueue({
        input: "First concurrent job",
      }),
      queue.enqueue({
        input: "Second concurrent job",
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
          result.reason instanceof RayError &&
          result.reason.code === "async_queue_storage_low" &&
          (result.reason.details as { availableMiB?: number }).availableMiB === 5 &&
          (result.reason.details as { reservedAdmissionMiB?: number }).reservedAdmissionMiB === 4 &&
          (result.reason.details as { effectiveAvailableMiB?: number }).effectiveAvailableMiB === 1,
      ),
    );
    assert.equal(queue.snapshot().totalJobs, 1);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue reports admission-adjusted storage pressure", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-storage-observe-"));
  let statfsCalls = 0;
  let releaseSecondStorageRead!: () => void;
  let markSecondStorageReadStarted!: () => void;
  let releaseCallbackLookup!: () => void;
  let markCallbackLookupStarted!: () => void;
  const secondStorageReadReleased = new Promise<void>((resolve) => {
    releaseSecondStorageRead = resolve;
  });
  const secondStorageReadStarted = new Promise<void>((resolve) => {
    markSecondStorageReadStarted = resolve;
  });
  const callbackLookupReleased = new Promise<void>((resolve) => {
    releaseCallbackLookup = resolve;
  });
  const callbackLookupStarted = new Promise<void>((resolve) => {
    markCallbackLookupStarted = resolve;
  });

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 4,
        minFreeStorageMiB: 2,
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      statfsImpl: async () => {
        statfsCalls += 1;
        if (statfsCalls === 2) {
          markSecondStorageReadStarted();
          await secondStorageReadReleased;
        }

        return {
          bavail: 5,
          bsize: 1024 * 1024,
        };
      },
      lookupImpl: async () => {
        markCallbackLookupStarted();
        await callbackLookupReleased;
        return [{ address: "93.184.216.34" }];
      },
    });

    const first = queue.enqueue({
      input: "First job held during callback normalization",
      callbackUrl: "https://callback.example/ray",
    });
    await callbackLookupStarted;
    const second = queue.enqueue({
      input: "Second job waits on storage admission",
    });
    const secondResult = second.then(
      (job) => ({ status: "fulfilled" as const, job }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await secondStorageReadStarted;

    const snapshot = await queue.snapshotWithStorage();
    assert.equal(snapshot.pendingAdmissions, 2);
    assert.equal(snapshot.availableStorageMiB, 5);
    assert.equal(snapshot.minFreeStorageMiB, 2);
    assert.equal(snapshot.reservedAdmissionMiB, 4);
    assert.equal(snapshot.effectiveAvailableStorageMiB, 1);
    assert.equal(snapshot.storageReserveRatio, 2.5);
    assert.equal(snapshot.storageLow, false);
    assert.equal(snapshot.storageAdmissionReserveRatio, 0.5);
    assert.equal(snapshot.storageAdmissionLow, true);
    assert.equal(snapshot.degraded, true);

    releaseSecondStorageRead();
    const rejected = await secondResult;
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.error instanceof RayError);
    assert.equal(rejected.error.code, "async_queue_storage_low");

    releaseCallbackLookup();
    const accepted = await first;
    assert.equal(accepted.status, "queued");
    assert.equal(queue.snapshot().pendingAdmissions, 0);
  } finally {
    releaseSecondStorageRead?.();
    releaseCallbackLookup?.();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue handles Bun statfs zero block size", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-bun-statfs-"));

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
        bavail: 999_999,
        bsize: 0,
        blocks: 4096,
        ffree: 32_512,
      }),
    });

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "should use fallback statfs fields",
        }),
      (error: unknown) =>
        error instanceof RayError &&
        error.code === "async_queue_storage_low" &&
        (error.details as { availableMiB?: number }).availableMiB === 127,
    );

    const snapshot = await queue.snapshotWithStorage();
    assert.equal(snapshot.availableStorageMiB, 127);
    assert.equal(snapshot.reservedAdmissionMiB, 0);
    assert.equal(snapshot.effectiveAvailableStorageMiB, 127);
    assert.equal(snapshot.storageReserveRatio, 0.9922);
    assert.equal(snapshot.storageLow, true);
    assert.equal(snapshot.storageAdmissionReserveRatio, 0.9922);
    assert.equal(snapshot.storageAdmissionLow, true);
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

test("durable inference queue fails recovered pending callbacks with exhausted attempts", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-callback-recovery-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 2,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 1,
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
      join(jobsDir, "job_callback_exhausted.json"),
      JSON.stringify({
        id: "job_callback_exhausted",
        status: "succeeded",
        request: {
          input: "callback crashed after final attempt was recorded",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "http://93.184.216.34/ray-callback",
          status: "pending",
          attempts: 1,
          lastAttemptAt: now,
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

    const recovered = await queue.get("job_callback_exhausted");
    assert.equal(recovered?.status, "succeeded");
    assert.equal(recovered?.callback?.status, "failed");
    assert.equal(recovered?.callback?.attempts, 1);
    assert.match(recovered?.callback?.lastError ?? "", /no retry attempts remaining/);

    await queue.stop();

    const raw = await fs.readFile(join(jobsDir, "job_callback_exhausted.json"), "utf8");
    const persisted = JSON.parse(raw) as {
      callback?: {
        status?: string;
      };
    };
    assert.equal(persisted.callback?.status, "failed");
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
    const runtime = {
      config,
      infer: async () => ({
        id: "req_oversized_persisted_result",
        model: "x".repeat(PERSISTED_JOB_FILE_LIMIT_BYTES),
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
        latencyMs: 1,
        degraded: false,
        createdAt: new Date().toISOString(),
      }),
    } as unknown as RayRuntime;
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
      stack: "internal stack trace",
      cause: new Error("backend failed"),
    };
    const longKey = `k${"x".repeat(140)}`;
    details[longKey] = "bounded-key";
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
        const error = new RayError("backend returned hostile diagnostics", {
          code: "provider_upstream_error",
          status: 502,
        });
        (error as unknown as { details: unknown }).details = details;
        throw error;
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
          stack?: string;
          cause?: {
            name?: string;
            message?: string;
            stack?: string;
          };
          [key: string]: unknown;
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
    assert.equal(errorDetails?.stack, undefined);
    assert.equal(errorDetails?.cause?.name, "Error");
    assert.equal(errorDetails?.cause?.message, "backend failed");
    assert.equal(errorDetails?.cause?.stack, undefined);
    assert.equal(errorDetails?.[`k${"x".repeat(104)}...[truncated 36 chars]`], "bounded-key");
    assert.equal(errorDetails?.[longKey], undefined);
    assert.ok(Object.keys(errorDetails ?? {}).every((key) => key.length <= 128));
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue snapshots scheduled inference retries", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-retry-snapshot-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 5_000,
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
    const runtime = {
      config,
      infer: async () => {
        throw new RayError("backend is still recovering", {
          code: "provider_timeout",
          status: 504,
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
      input: "retry after provider timeout",
    });

    await queue.start();
    const snapshot = await waitFor(
      async () => queue.snapshot(),
      (value) => value.jobRetryScheduled === 1,
    );
    const retryingJob = await queue.get(queuedJob.id);

    assert.equal(retryingJob?.status, "queued");
    assert.equal(retryingJob?.attempts, 1);
    assert.equal(snapshot.retryScheduled, 1);
    assert.equal(snapshot.jobRetryScheduled, 1);
    assert.equal(snapshot.callbackRetryScheduled, 0);
    assert.equal(snapshot.queued, 0);
    assert.equal(snapshot.running, 0);
    assert.equal(snapshot.failed, 0);

    await queue.stop();

    assert.equal(queue.snapshot().retryScheduled, 0);
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
      join(jobsDir, "job_attempts_too_large.json"),
      JSON.stringify({
        id: "job_attempts_too_large",
        status: "queued",
        request: {
          input: "oversized persisted job attempts",
        },
        createdAt: now,
        updatedAt: now,
        attempts: 101,
        maxAttempts: 101,
      }),
    );
    await writeFile(
      join(jobsDir, "job_succeeded_without_result.json"),
      JSON.stringify({
        id: "job_succeeded_without_result",
        status: "succeeded",
        request: {
          input: "succeeded persisted job without result",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_succeeded_with_error.json"),
      JSON.stringify({
        id: "job_succeeded_with_error",
        status: "succeeded",
        request: {
          input: "succeeded persisted job with stale error",
        },
        result: persistedInferenceResult("done"),
        error: {
          message: "stale failure",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_failed_without_error.json"),
      JSON.stringify({
        id: "job_failed_without_error",
        status: "failed",
        request: {
          input: "failed persisted job without error",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_queued_with_result.json"),
      JSON.stringify({
        id: "job_queued_with_result",
        status: "queued",
        request: {
          input: "queued persisted job with stale result",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_result_good.json"),
      JSON.stringify({
        id: "job_result_good",
        status: "succeeded",
        request: {
          input: "valid persisted result with diagnostics",
        },
        result: persistedInferenceResult("done", {
          diagnostics: {
            provider: {
              requestShape: "llama.cpp-completion",
              promptFormat: "prompt-scaffold",
              promptFormatReason: "mock provider",
              jsonRepairAttempted: false,
              totalSlots: 1,
              timings: {
                totalMs: 1,
                completionTokensPerSecond: 12,
              },
            },
          },
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_result_output_too_long.json"),
      JSON.stringify({
        id: "job_result_output_too_long",
        status: "succeeded",
        request: {
          input: "oversized persisted result output",
        },
        result: persistedInferenceResult("x".repeat(MAX_PERSISTED_RESULT_OUTPUT_CHARS + 1)),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_result_extra_field.json"),
      JSON.stringify({
        id: "job_result_extra_field",
        status: "succeeded",
        request: {
          input: "persisted result with extra fields",
        },
        result: persistedInferenceResult("done", {
          raw: {
            stack: "secret stack",
          },
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_result_bad_provider_diagnostics.json"),
      JSON.stringify({
        id: "job_result_bad_provider_diagnostics",
        status: "succeeded",
        request: {
          input: "persisted result with malformed provider diagnostics",
        },
        result: persistedInferenceResult("done", {
          diagnostics: {
            provider: {
              tokensCached: 1_000_000_001,
            },
          },
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
      }),
    );
    await writeFile(
      join(jobsDir, "job_error_message_too_long.json"),
      JSON.stringify({
        id: "job_error_message_too_long",
        status: "failed",
        request: {
          input: "oversized persisted error message",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        error: {
          message: "x".repeat(8_193),
          code: "gateway_error",
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_error_extra_field.json"),
      JSON.stringify({
        id: "job_error_extra_field",
        status: "failed",
        request: {
          input: "persisted error with extra fields",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        error: {
          message: "backend failed",
          code: "provider_upstream_error",
          stack: "secret stack",
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_error_detail_stack.json"),
      JSON.stringify({
        id: "job_error_detail_stack",
        status: "failed",
        request: {
          input: "persisted error details with stack",
        },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        error: {
          message: "backend failed",
          details: {
            cause: {
              stack: "secret stack",
            },
          },
        },
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
        error: {
          message: "callback URL was rejected",
          code: "invalid_request",
        },
        callback: {
          url: `https://example.com/${"x".repeat(2_048)}`,
          status: "pending",
          attempts: 0,
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_credentials.json"),
      JSON.stringify({
        id: "job_callback_credentials",
        status: "succeeded",
        request: {
          input: "credentialed persisted callback",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "https://user:secret@93.184.216.34/ray-callback",
          status: "pending",
          attempts: 0,
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_fragment.json"),
      JSON.stringify({
        id: "job_callback_fragment",
        status: "succeeded",
        request: {
          input: "fragmented persisted callback",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "https://93.184.216.34/ray-callback#secret",
          status: "pending",
          attempts: 0,
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_control.json"),
      JSON.stringify({
        id: "job_callback_control",
        status: "succeeded",
        request: {
          input: "callback url with raw control character",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "https://exa\tmple.com/ray-callback",
          status: "pending",
          attempts: 0,
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_attempts_too_large.json"),
      JSON.stringify({
        id: "job_callback_attempts_too_large",
        status: "succeeded",
        request: {
          input: "callback with oversized persisted attempts",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "https://93.184.216.34/ray-callback",
          status: "pending",
          attempts: 101,
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_callback_last_error_too_long.json"),
      JSON.stringify({
        id: "job_callback_last_error_too_long",
        status: "succeeded",
        request: {
          input: "callback with oversized persisted error",
        },
        result: persistedInferenceResult("done"),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        attempts: 1,
        maxAttempts: 2,
        callback: {
          url: "https://93.184.216.34/ray-callback",
          status: "failed",
          attempts: 1,
          lastError: "x".repeat(8_193),
        },
      }),
    );
    await writeFile(
      join(jobsDir, "job_bad_request.json"),
      JSON.stringify({
        id: "job_bad_request",
        status: "queued",
        request: {
          input: "bad request shape",
          metadata: {
            promptFamily: ["email"],
          },
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

    assert.equal(await queue.get("job_bad"), undefined);
    assert.equal(await queue.get("job_mismatch"), undefined);
    assert.equal(await queue.get("job_other"), undefined);
    assert.equal(await queue.get("job_id_too_long"), undefined);
    assert.equal(await queue.get("job_attempts_too_large"), undefined);
    assert.equal(await queue.get("job_succeeded_without_result"), undefined);
    assert.equal(await queue.get("job_succeeded_with_error"), undefined);
    assert.equal(await queue.get("job_failed_without_error"), undefined);
    assert.equal(await queue.get("job_queued_with_result"), undefined);
    assert.equal(await queue.get("job_result_output_too_long"), undefined);
    assert.equal(await queue.get("job_result_extra_field"), undefined);
    assert.equal(await queue.get("job_result_bad_provider_diagnostics"), undefined);
    assert.equal(await queue.get("job_error_message_too_long"), undefined);
    assert.equal(await queue.get("job_error_extra_field"), undefined);
    assert.equal(await queue.get("job_error_detail_stack"), undefined);
    assert.equal(await queue.get("job_callback_too_long"), undefined);
    assert.equal(await queue.get("job_callback_credentials"), undefined);
    assert.equal(await queue.get("job_callback_fragment"), undefined);
    assert.equal(await queue.get("job_callback_control"), undefined);
    assert.equal(await queue.get("job_callback_attempts_too_large"), undefined);
    assert.equal(await queue.get("job_callback_last_error_too_long"), undefined);
    assert.equal(await queue.get("job_bad_request"), undefined);

    const completedJob = await waitFor(
      async () => queue.get("job_good"),
      (job) => job.status === "succeeded",
    );
    assert.match(completedJob.result?.output ?? "", /good persisted job/);
    const recoveredResultJob = await queue.get("job_result_good");
    assert.equal(recoveredResultJob?.status, "succeeded");
    assert.equal(recoveredResultJob?.result?.diagnostics?.provider?.totalSlots, 1);

    await queue.stop();

    const entries = await readdir(jobsDir);
    assert.equal(entries.includes("job_bad.json"), false);
    assert.equal(entries.includes("job_mismatch.json"), false);
    assert.equal(entries.includes("job_id_too_long.json"), false);
    assert.equal(entries.includes("job_attempts_too_large.json"), false);
    assert.equal(entries.includes("job_succeeded_without_result.json"), false);
    assert.equal(entries.includes("job_succeeded_with_error.json"), false);
    assert.equal(entries.includes("job_failed_without_error.json"), false);
    assert.equal(entries.includes("job_queued_with_result.json"), false);
    assert.equal(entries.includes("job_result_output_too_long.json"), false);
    assert.equal(entries.includes("job_result_extra_field.json"), false);
    assert.equal(entries.includes("job_result_bad_provider_diagnostics.json"), false);
    assert.equal(entries.includes("job_error_message_too_long.json"), false);
    assert.equal(entries.includes("job_error_extra_field.json"), false);
    assert.equal(entries.includes("job_error_detail_stack.json"), false);
    assert.equal(entries.includes("job_callback_too_long.json"), false);
    assert.equal(entries.includes("job_callback_credentials.json"), false);
    assert.equal(entries.includes("job_callback_fragment.json"), false);
    assert.equal(entries.includes("job_callback_control.json"), false);
    assert.equal(entries.includes("job_callback_attempts_too_large.json"), false);
    assert.equal(entries.includes("job_callback_last_error_too_long.json"), false);
    assert.equal(entries.includes("job_bad_request.json"), false);
    assert.equal(entries.includes("job_good.json"), true);
    assert.equal(entries.includes("job_result_good.json"), true);
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

    const entries = await readdir(jobsDir);
    assert.equal(entries.includes("job_oversized.json"), false);
    assert.equal(entries.includes("job_good.json"), true);
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
        result: persistedInferenceResult("terminal job should overflow"),
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

test("durable inference queue bounds recovery directory scans", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-recovery-scan-"));

  try {
    const jobsDir = join(storageDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    await writeFilesInBatches(
      jobsDir,
      ASYNC_QUEUE_RECOVERY_ENTRY_LIMIT + 1,
      (index) => `ignored-${index}.txt`,
      "ignored",
    );

    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
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
      () => queue.start(),
      (error: unknown) =>
        error instanceof RayError &&
        error.code === "async_queue_recovery_limit_exceeded" &&
        error.status === 503 &&
        /visited more than 4096 directory entries/.test(error.message) &&
        (error.details as { maxEntries?: number }).maxEntries === ASYNC_QUEUE_RECOVERY_ENTRY_LIMIT,
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue bounds stale temp cleanup during recovery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-recovery-temp-"));

  try {
    const jobsDir = join(storageDir, "jobs");
    await mkdir(jobsDir, { recursive: true });
    await writeFilesInBatches(
      jobsDir,
      ASYNC_QUEUE_RECOVERY_TEMP_REMOVAL_LIMIT + 1,
      (index) => `.tmp-job_stale_${index}.json-deadbeef`,
      "partial",
    );

    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
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
      () => queue.start(),
      (error: unknown) =>
        error instanceof RayError &&
        error.code === "async_queue_recovery_limit_exceeded" &&
        error.status === 503 &&
        /found more than 2048 stale temp files/.test(error.message) &&
        (error.details as { maxTempRemovals?: number }).maxTempRemovals ===
          ASYNC_QUEUE_RECOVERY_TEMP_REMOVAL_LIMIT,
    );
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

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not call hexadecimal IPv4-mapped loopback callback",
          callbackUrl: "http://[::ffff:7f00:1]/ray-callback",
        }),
      /private, local, or non-global/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Do not call hexadecimal IPv4-mapped private callback",
          callbackUrl: "http://[::ffff:c0a8:1]/ray-callback",
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

    const mappedDnsQueue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => [{ address: "::ffff:0a00:1" }],
    });

    await assert.rejects(
      () =>
        mappedDnsQueue.enqueue({
          input: "Do not call IPv4-mapped private DNS callback",
          callbackUrl: "https://mapped-private.example/ray-callback",
        }),
      /private, local, or non-global/,
    );

    const fullMappedDnsQueue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => [{ address: "0:0:0:0:0:ffff:10.0.0.1" }],
    });

    await assert.rejects(
      () =>
        fullMappedDnsQueue.enqueue({
          input: "Do not call full IPv4-mapped private DNS callback",
          callbackUrl: "https://full-mapped-private.example/ray-callback",
        }),
      /private, local, or non-global/,
    );

    const wildcardAllowlistQueue = new DurableInferenceQueue({
      config: {
        ...config.asyncQueue,
        callbackAllowedHosts: ["*.trusted.example"],
      },
      runtime,
      logger,
      lookupImpl: async () => {
        throw new Error("allowlisted callback hosts should not require DNS admission checks");
      },
    });

    const accepted = await wildcardAllowlistQueue.enqueue({
      input: "Allow trusted callback host",
      callbackUrl: "https://hooks.trusted.example/ray-callback",
    });

    assert.equal(accepted.status, "queued");
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

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Spaced callback",
          callbackUrl: " https://93.184.216.34/ray-callback",
        }),
      /callbackUrl must not contain unencoded whitespace or control characters/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Controlled callback",
          callbackUrl: "https://exa\tmple.com/ray-callback",
        }),
      /callbackUrl must not contain unencoded whitespace or control characters/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Credentialed callback",
          callbackUrl: "https://user:secret@93.184.216.34/ray-callback",
        }),
      /callbackUrl must not include credentials/,
    );

    await assert.rejects(
      () =>
        queue.enqueue({
          input: "Fragmented callback",
          callbackUrl: "https://93.184.216.34/ray-callback#secret",
        }),
      /callbackUrl must not include a fragment/,
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

    const emptyQueue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => [],
    });
    await assert.rejects(
      () =>
        emptyQueue.enqueue({
          input: "Do not accept empty DNS results",
          callbackUrl: "https://empty-dns.example/ray-callback",
        }),
      /callbackUrl hostname did not resolve to any IP addresses/,
    );

    const invalidAddressQueue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      lookupImpl: async () => [{ address: "not-an-ip-address" }],
    });
    await assert.rejects(
      () =>
        invalidAddressQueue.enqueue({
          input: "Do not accept malformed DNS addresses",
          callbackUrl: "https://invalid-dns.example/ray-callback",
        }),
      /callbackUrl hostname resolved to an invalid address/,
    );
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
        result: persistedInferenceResult("Already completed"),
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

test("durable inference queue bounds expired job prune file removals", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-"));
  let activeRemovals = 0;
  let maxActiveRemovals = 0;
  let removals = 0;

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        maxJobs: 24,
        completedTtlMs: 25,
        pollIntervalMs: 20,
        dispatchConcurrency: 8,
        maxAttempts: 1,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 1,
      },
      model: {
        adapter: {
          kind: "mock",
          latencyMs: 1,
        },
      },
    });
    const runtime = createRayRuntime(config);
    const logger = new Logger("test", "error");
    const queue = new DurableInferenceQueue({
      config: config.asyncQueue,
      runtime,
      logger,
      removeFileImpl: async (filePath: string) => {
        activeRemovals += 1;
        removals += 1;
        maxActiveRemovals = Math.max(maxActiveRemovals, activeRemovals);

        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          await rm(filePath, { force: true });
        } finally {
          activeRemovals -= 1;
        }
      },
    });

    for (let index = 0; index < config.asyncQueue.maxJobs; index += 1) {
      await queue.enqueue({
        input: `Completed job ${index}`,
      });
    }

    await queue.start();
    await waitFor(
      async () => queue.snapshot(),
      (snapshot) => snapshot.succeeded === config.asyncQueue.maxJobs && snapshot.running === 0,
    );
    await queue.stop();
    await new Promise((resolve) => setTimeout(resolve, config.asyncQueue.completedTtlMs + 10));

    await queue.enqueue({
      input: "New job should fit after bounded pruning",
    });

    assert.equal(removals, config.asyncQueue.maxJobs);
    assert.ok(
      maxActiveRemovals <= 16,
      `expected at most 16 concurrent removals, saw ${maxActiveRemovals}`,
    );
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

    const snapshot = await waitFor(
      async () => queue.snapshot(),
      (value) => value.callbackRetryScheduled === 1,
    );
    assert.equal(snapshot.totalJobs, 1);
    assert.equal(snapshot.retryScheduled, 1);
    assert.equal(snapshot.jobRetryScheduled, 0);
    assert.equal(snapshot.callbackRetryScheduled, 1);

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
    const snapshot = queue.snapshot();
    assert.equal(snapshot.succeeded, 1);
    assert.equal(snapshot.failed, 0);
    assert.equal(snapshot.callbackPending, 0);
    assert.equal(snapshot.callbackDelivered, 1);
    assert.equal(snapshot.callbackFailed, 0);

    await queue.stop();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable inference queue persists bounded callback failure errors", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "ray-async-jobs-callback-error-"));

  try {
    const config = mergeConfig(createDefaultConfig("tiny"), {
      asyncQueue: {
        enabled: true,
        storageDir,
        pollIntervalMs: 20,
        dispatchConcurrency: 1,
        maxAttempts: 1,
        callbackTimeoutMs: 500,
        maxCallbackAttempts: 1,
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
      fetchImpl: async () => {
        throw new Error(`Callback failed: ${"x".repeat(PERSISTED_JOB_FILE_LIMIT_BYTES)}`);
      },
    });
    const job = await queue.enqueue({
      input: "Callback failure should stay persisted",
      callbackUrl: "http://93.184.216.34/ray-callback",
    });

    await queue.start();

    await waitFor(
      async () => queue.get(job.id),
      (value) => value.callback?.status === "failed",
    );

    await queue.stop();

    const raw = await fs.readFile(join(storageDir, "jobs", `${job.id}.json`), "utf8");
    const persisted = JSON.parse(raw) as {
      callback?: {
        status?: string;
        lastError?: string;
      };
    };

    assert.equal(persisted.callback?.status, "failed");
    assert.match(persisted.callback?.lastError ?? "", /\[truncated \d+ chars\]/);
    assert.ok((persisted.callback?.lastError ?? "").length < 9_000);
    assert.ok(Buffer.byteLength(raw, "utf8") < PERSISTED_JOB_FILE_LIMIT_BYTES);
    const snapshot = queue.snapshot();
    assert.equal(snapshot.succeeded, 1);
    assert.equal(snapshot.failed, 0);
    assert.equal(snapshot.callbackPending, 0);
    assert.equal(snapshot.callbackDelivered, 0);
    assert.equal(snapshot.callbackFailed, 1);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
