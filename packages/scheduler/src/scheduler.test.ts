import test from "node:test";
import assert from "node:assert/strict";
import type { SchedulerConfig, SchedulerSlotSnapshot } from "@razroo/ray-core";
import { RequestScheduler } from "./index.js";

function createSchedulerConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 128,
    maxInflightTokens: 64,
    requestTimeoutMs: 1_000,
    dedupeInflight: true,
    batchWindowMs: 0,
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
    ...overrides,
  };
}

test("scheduler rejects invalid resource limit config", () => {
  assert.throws(
    () => new RequestScheduler<string>(null as never),
    /scheduler config must be an object/,
  );
  assert.throws(
    () =>
      new RequestScheduler<string>({
        ...createSchedulerConfig(),
        extra: "not-supported",
      } as SchedulerConfig),
    /scheduler config must not contain unsupported key "extra"/,
  );
  assert.throws(
    () =>
      new RequestScheduler<string>(
        JSON.parse(
          '{"concurrency":1,"maxQueue":8,"maxQueuedTokens":128,"maxInflightTokens":64,"requestTimeoutMs":1000,"dedupeInflight":true,"batchWindowMs":0,"affinityLookahead":8,"shortJobMaxTokens":96,"__proto__":"polluted"}',
        ),
      ),
    /scheduler config must not contain unsafe key "__proto__"/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ concurrency: 0 })),
    /scheduler\.concurrency/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ concurrency: 9 })),
    /scheduler\.concurrency/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxQueue: 0 })),
    /scheduler\.maxQueue/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxQueue: 513 })),
    /scheduler\.maxQueue/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxQueuedTokens: Infinity })),
    /scheduler\.maxQueuedTokens/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxQueuedTokens: 262_145 })),
    /scheduler\.maxQueuedTokens/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxInflightTokens: 1.5 })),
    /scheduler\.maxInflightTokens/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ maxInflightTokens: 65_537 })),
    /scheduler\.maxInflightTokens/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ requestTimeoutMs: 0 })),
    /scheduler\.requestTimeoutMs/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ requestTimeoutMs: 120_001 })),
    /scheduler\.requestTimeoutMs/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ batchWindowMs: -1 })),
    /scheduler\.batchWindowMs/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ batchWindowMs: 1_001 })),
    /scheduler\.batchWindowMs/,
  );
  assert.throws(
    () =>
      new RequestScheduler<string>(
        createSchedulerConfig({ requestTimeoutMs: 1_000, batchWindowMs: 1_000 }),
      ),
    /scheduler\.batchWindowMs must be less than scheduler\.requestTimeoutMs/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ affinityLookahead: 9 })),
    /scheduler\.affinityLookahead/,
  );
  assert.throws(
    () => new RequestScheduler<string>(createSchedulerConfig({ shortJobMaxTokens: 0 })),
    /scheduler\.shortJobMaxTokens/,
  );
  assert.throws(
    () =>
      new RequestScheduler<string>(
        createSchedulerConfig({ dedupeInflight: "true" as unknown as boolean }),
      ),
    /scheduler\.dedupeInflight/,
  );
});

test("scheduler snapshots resource limits at construction", async () => {
  const config = createSchedulerConfig({
    maxQueue: 1,
    affinityLookahead: 1,
  });
  const scheduler = new RequestScheduler<string>(config);
  let releaseFirst!: () => void;

  config.concurrency = 10;
  config.maxQueue = 10;
  config.maxQueuedTokens = 10_000;
  config.maxInflightTokens = 10_000;

  const first = scheduler.schedule({
    handler: async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    },
  });
  const second = scheduler.schedule({
    handler: async () => "second",
  });

  assert.throws(
    () =>
      scheduler.schedule({
        handler: async () => "third",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "queue_full",
  );
  assert.equal(scheduler.snapshot().concurrency, 1);
  assert.equal(scheduler.snapshot().maxQueue, 1);

  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.value),
    ["first", "second"],
  );
});

test("scheduler rejects malformed backend slot snapshots", () => {
  const scheduler = new RequestScheduler<string>(createSchedulerConfig());
  const validSlot = {
    id: 1,
    isProcessing: false,
    updatedAt: new Date().toISOString(),
  };
  scheduler.updateBackendSlots([validSlot]);

  assert.throws(
    () => scheduler.updateBackendSlots(null as never),
    /backend slots must be an array/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots(
        Array.from({ length: 65 }, (_value, index) => ({
          id: index,
          isProcessing: false,
          updatedAt: new Date().toISOString(),
        })),
      ),
    /backend slots must contain at most 64 entries/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots([
        {
          isProcessing: false,
          updatedAt: new Date().toISOString(),
        } as never,
      ]),
    /backend slots\[0\]\.id is required/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots([
        {
          id: 1_000_000_001,
          isProcessing: false,
          updatedAt: new Date().toISOString(),
        },
      ]),
    /backend slots\[0\]\.id/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots([
        {
          id: 1,
          isProcessing: "false" as never,
          updatedAt: new Date().toISOString(),
        },
      ]),
    /backend slots\[0\]\.isProcessing/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots([
        {
          id: 1,
          isProcessing: false,
          updatedAt: "x".repeat(65),
        },
      ]),
    /backend slots\[0\]\.updatedAt/,
  );
  assert.throws(
    () =>
      scheduler.updateBackendSlots([
        {
          id: 1,
          isProcessing: false,
          updatedAt: new Date().toISOString(),
          contextWindow: 8,
          promptTokens: 9,
        },
      ]),
    /backend slots\[0\]\.promptTokens/,
  );

  const schedulerState = scheduler as unknown as {
    backendSlots: Map<number, SchedulerSlotSnapshot>;
  };
  assert.equal(schedulerState.backendSlots.has(1), true);
});

test("scheduler snapshots backend slot inputs", () => {
  const scheduler = new RequestScheduler<string>(createSchedulerConfig());
  const slot = {
    id: 2,
    taskId: 3,
    isProcessing: false,
    contextWindow: 128,
    promptTokens: 32,
    cacheTokens: 16,
    updatedAt: new Date().toISOString(),
    extra: "discarded",
  } as SchedulerSlotSnapshot & { extra?: string };

  scheduler.updateBackendSlots([slot]);
  slot.isProcessing = true;
  slot.extra = "mutated";

  const schedulerState = scheduler as unknown as {
    backendSlots: Map<number, SchedulerSlotSnapshot & { extra?: unknown }>;
  };
  const stored = schedulerState.backendSlots.get(2);

  assert.equal(stored?.taskId, 3);
  assert.equal(stored?.isProcessing, false);
  assert.equal(stored?.contextWindow, 128);
  assert.equal(stored?.promptTokens, 32);
  assert.equal(stored?.cacheTokens, 16);
  assert.equal(stored?.extra, undefined);
});

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

test("scheduler rejects over-budget keyed work before deduplicating", async () => {
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

  let releaseBlocked!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const first = scheduler.schedule({
    key: "same",
    costTokens: 16,
    handler: async () => {
      markStarted();
      await blocked;
      return "ok";
    },
  });

  await firstStarted;

  assert.throws(
    () =>
      scheduler.schedule({
        key: "same",
        costTokens: 80,
        handler: async () => "not-used",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "request_token_budget_exceeded",
  );

  releaseBlocked();
  assert.equal((await first).value, "ok");
});

test("scheduler handles cleanup after rejected keyed work", async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  process.on("unhandledRejection", onUnhandledRejection);

  try {
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

    await assert.rejects(
      scheduler.schedule({
        key: "fails",
        handler: async () => {
          throw new Error("backend failed");
        },
      }),
      /backend failed/,
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
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

test("scheduler rejects batch windows that cannot drain before timeout", () => {
  assert.throws(
    () =>
      new RequestScheduler<string>({
        concurrency: 1,
        maxQueue: 8,
        maxQueuedTokens: 128,
        maxInflightTokens: 64,
        requestTimeoutMs: 20,
        dedupeInflight: true,
        batchWindowMs: 50,
        affinityLookahead: 8,
        shortJobMaxTokens: 96,
      }),
    /scheduler\.batchWindowMs must be less than scheduler\.requestTimeoutMs/,
  );
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

test("scheduler rejects invalid task options before queueing", async () => {
  const scheduler = new RequestScheduler<string>(createSchedulerConfig());

  assert.throws(() => scheduler.schedule(null as never), /schedule options/);
  assert.throws(
    () =>
      scheduler.schedule({
        handler: "not-a-handler" as never,
      }),
    /schedule\.handler/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        lane: "bulk" as never,
        handler: async () => "bad-lane",
      }),
    /schedule\.lane/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        costTokens: Number.NaN,
        handler: async () => "bad-cost",
      }),
    /schedule\.costTokens/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        costTokens: 1.5,
        handler: async () => "fractional-cost",
      }),
    /schedule\.costTokens/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        preferredSlot: -1,
        handler: async () => "bad-slot",
      }),
    /schedule\.preferredSlot/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        key: 123 as never,
        handler: async () => "bad-key",
      }),
    /schedule\.key/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        key: "x".repeat(513),
        handler: async () => "long-key",
      }),
    /schedule\.key must be at most 512 characters/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        affinityKey: 123 as never,
        handler: async () => "bad-affinity",
      }),
    /schedule\.affinityKey/,
  );
  assert.throws(
    () =>
      scheduler.schedule({
        affinityKey: "x".repeat(513),
        handler: async () => "long-affinity",
      }),
    /schedule\.affinityKey must be at most 512 characters/,
  );

  assert.equal(scheduler.snapshot().queueDepth, 0);
  assert.equal(scheduler.snapshot().queuedTokens, 0);
  assert.equal(scheduler.snapshot().inFlightTokens, 0);
});

test("scheduler does not retain dedupe entries for invalid task options", async () => {
  const scheduler = new RequestScheduler<string>(createSchedulerConfig());

  assert.throws(
    () =>
      scheduler.schedule({
        key: "same",
        lane: "bulk" as never,
        handler: async () => "bad-lane",
      }),
    /schedule\.lane/,
  );

  const result = await Promise.race([
    scheduler.schedule({
      key: "same",
      handler: async () => "ok",
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("valid keyed work did not run")), 100);
    }),
  ]);

  assert.equal(result.value, "ok");
  assert.equal(result.deduplicated, false);
});

test("scheduler enforces requestTimeoutMs when work ignores abort", async () => {
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  let aborted = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const scheduler = new RequestScheduler<string>({
    concurrency: 1,
    maxQueue: 8,
    maxQueuedTokens: 128,
    maxInflightTokens: 64,
    requestTimeoutMs: 50,
    dedupeInflight: true,
    batchWindowMs: 0,
    affinityLookahead: 8,
    shortJobMaxTokens: 96,
  });

  const first = scheduler.schedule({
    handler: async (signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      markStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "late";
    },
  });

  await started;

  await assert.rejects(
    first,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "request_timeout",
  );

  const second = await scheduler.schedule({
    handler: async () => "next",
  });

  assert.equal(second.value, "next");
  assert.equal(aborted, true);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
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
