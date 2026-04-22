import test from "node:test";
import assert from "node:assert/strict";
import { RequestScheduler } from "./index.js";

test("scheduler deduplicates matching inflight work", async () => {
  let executions = 0;
  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 128,
    maxInflightTokens: 64,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
  });

  const first = scheduler.schedule({
    key: "same",
    handler: async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return "ok";
    },
  });

  const second = scheduler.schedule({
    key: "same",
    handler: async () => "not-used",
  });

  const [a, b] = await Promise.all([first, second]);

  assert.equal(executions, 1);
  assert.equal(a.value, "ok");
  assert.equal(b.value, "ok");
  assert.equal(b.deduplicated, true);
});

test("scheduler honors batchWindowMs before starting work", async () => {
  let started = false;
  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 128,
    maxInflightTokens: 64,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 25,
  });

  const pending = scheduler.schedule({
    handler: async () => {
      started = true;
      return "ok";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, false);

  const result = await pending;
  assert.equal(started, true);
  assert.equal(result.value, "ok");
});

test("scheduler rejects work that exceeds token budgets", async () => {
  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 64,
    maxInflightTokens: 32,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
  });

  assert.throws(
    () =>
      scheduler.schedule({
        costTokens: 80,
        handler: async () => "nope",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "request_token_budget_exceeded",
  );
});

test("scheduler allows smaller queued work to bypass an oversized inflight wait", async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;

  const scheduler = new RequestScheduler<string>({
    concurrency: 2,
    maxQueue: 8,
    maxQueuedTokens: 256,
    maxInflightTokens: 100,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
  });

  const first = scheduler.schedule({
    costTokens: 60,
    handler: async () => {
      started.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });

  const second = scheduler.schedule({
    costTokens: 50,
    handler: async () => {
      started.push("second");
      return "second";
    },
  });

  const third = scheduler.schedule({
    costTokens: 20,
    handler: async () => {
      started.push("third");
      return "third";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["first", "third"]);

  releaseFirst();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(
    results.map((result) => result.value),
    ["first", "second", "third"],
  );
});
