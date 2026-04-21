import test from "node:test";
import assert from "node:assert/strict";
import { RequestScheduler } from "./index.js";

test("scheduler deduplicates matching inflight work", async () => {
  let executions = 0;
  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
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
