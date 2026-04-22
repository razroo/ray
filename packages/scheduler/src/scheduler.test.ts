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
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
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
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
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
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
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
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
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

test("scheduler prefers matching prompt affinity when capacity allows", async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;

  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 256,
    maxInflightTokens: 128,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
  });

  const first = scheduler.schedule({
    affinityKey: "email:cold_outreach",
    handler: async () => {
      started.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });

  const second = scheduler.schedule({
    affinityKey: "classification",
    handler: async () => {
      started.push("second");
      return "second";
    },
  });

  const third = scheduler.schedule({
    affinityKey: "email:cold_outreach",
    handler: async () => {
      started.push("third");
      return "third";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFirst();

  const results = await Promise.all([first, second, third]);
  assert.deepEqual(started, ["first", "third", "second"]);
  assert.deepEqual(
    results.map((result) => result.value),
    ["first", "second", "third"],
  );
});

test("scheduler prefers short-lane work over draft-lane work", async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;

  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 256,
    maxInflightTokens: 128,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
  });

  const first = scheduler.schedule({
    lane: "draft",
    handler: async () => {
      started.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });

  const draft = scheduler.schedule({
    lane: "draft",
    handler: async () => {
      started.push("draft");
      return "draft";
    },
  });

  const short = scheduler.schedule({
    lane: "short",
    handler: async () => {
      started.push("short");
      return "short";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFirst();

  const results = await Promise.all([first, draft, short]);
  assert.deepEqual(started, ["first", "short", "draft"]);
  assert.deepEqual(
    results.map((result) => result.value),
    ["first", "draft", "short"],
  );
});

test("scheduler prefers work that can reuse an idle preferred slot", async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;
  let releaseIdle!: () => void;
  let releaseBusy!: () => void;

  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 256,
    maxInflightTokens: 128,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
  });

  scheduler.updateBackendSlots([
    { id: 0, isProcessing: false, updatedAt: new Date().toISOString() },
    { id: 1, isProcessing: true, updatedAt: new Date().toISOString() },
  ]);

  const first = scheduler.schedule({
    preferredSlot: 1,
    handler: async () => {
      started.push("first");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });

  const hotBusy = scheduler.schedule({
    preferredSlot: 1,
    handler: async () => {
      started.push("busy");
      await new Promise<void>((resolve) => {
        releaseBusy = resolve;
      });
      return "busy";
    },
  });

  const hotIdle = scheduler.schedule({
    preferredSlot: 0,
    handler: async () => {
      started.push("idle");
      await new Promise<void>((resolve) => {
        releaseIdle = resolve;
      });
      return "idle";
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["first"]);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["first", "idle"]);

  releaseIdle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["first", "idle", "busy"]);

  releaseBusy();
  const results = await Promise.all([first, hotBusy, hotIdle]);
  assert.deepEqual(
    results.map((result) => result.value),
    ["first", "busy", "idle"],
  );
});
