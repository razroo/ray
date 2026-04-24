import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultConfig, mergeConfig } from "@ray/config";
import { createRayRuntime } from "@ray/runtime";
import { Logger } from "@ray/telemetry";
import { DurableInferenceQueue } from "./async-jobs.js";

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

test("durable inference queue rejects private-network callbacks by default", async () => {
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
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
