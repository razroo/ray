import {
  RayError,
  type ScheduleLane,
  type SchedulerConfig,
  type SchedulerSlotSnapshot,
  type SchedulerSnapshot,
} from "@razroo/ray-core";

const SHORT_LANE_BONUS = 120;
const SLOT_IDLE_BONUS = 220;
const SLOT_BUSY_PENALTY = 180;
const RECENT_AFFINITY_BONUS = 80;
const DOMINANT_AFFINITY_BONUS = 40;
const WAIT_SCORE_DIVISOR = 25;
const MAX_SCHEDULE_KEY_CHARS = 512;
const MAX_SCHEDULE_AFFINITY_KEY_CHARS = 512;
const MAX_SCHEDULER_CONCURRENCY = 8;
const MAX_SCHEDULER_QUEUE_DEPTH = 512;
const MAX_SCHEDULER_QUEUED_TOKENS = 262_144;
const MAX_SCHEDULER_INFLIGHT_TOKENS = 65_536;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_SCHEDULER_BATCH_WINDOW_MS = 1_000;
const MAX_SCHEDULER_BACKEND_SLOTS = 64;
const MAX_SCHEDULER_SLOT_DIAGNOSTIC_NUMBER = 1_000_000_000;
const MAX_SCHEDULER_SLOT_UPDATED_AT_CHARS = 64;
const unsafeSchedulerRecordKeys = new Set(["__proto__", "constructor", "prototype"]);
const schedulerConfigKeys = new Set([
  "concurrency",
  "maxQueue",
  "maxQueuedTokens",
  "maxInflightTokens",
  "requestTimeoutMs",
  "dedupeInflight",
  "batchWindowMs",
  "affinityLookahead",
  "shortJobMaxTokens",
]);

function createRequestTimeoutError(): RayError {
  return new RayError("The inference request exceeded the scheduler timeout", {
    code: "request_timeout",
    status: 504,
  });
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  assertPositiveSafeInteger(value, label);

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertNonNegativeSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  assertNonNegativeSafeInteger(value, label);

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertOptionalNonNegativeSafeIntegerAtMost(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number") {
    throw new TypeError(`${label} must be a number`);
  }

  assertNonNegativeSafeIntegerAtMost(value, label, maximum);
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertKnownObjectKeys(
  value: object,
  label: string,
  allowedKeys: ReadonlySet<string>,
): void {
  for (const [key] of objectEntries(value, label)) {
    if (unsafeSchedulerRecordKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsafe key "${key}"`);
    }

    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsupported key "${key}"`);
    }
  }
}

function assertSchedulerConfig(config: SchedulerConfig): void {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("scheduler config must be an object");
  }

  assertKnownObjectKeys(config, "scheduler config", schedulerConfigKeys);
}

function normalizeScheduleLane(value: unknown): ScheduleLane {
  if (value === undefined) {
    return "draft";
  }

  if (value !== "short" && value !== "draft") {
    throw new TypeError("schedule.lane must be short or draft");
  }

  return value;
}

function normalizeCostTokens(value: unknown): number {
  const costTokens = value ?? 1;

  if (typeof costTokens !== "number" || !Number.isSafeInteger(costTokens) || costTokens <= 0) {
    throw new RangeError("schedule.costTokens must be a positive safe integer");
  }

  return costTokens;
}

function normalizePreferredSlot(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("schedule.preferredSlot must be a non-negative safe integer");
  }

  return value;
}

function normalizeScheduleKey(value: unknown): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError("schedule.key must be a string");
  }

  if (value.length > MAX_SCHEDULE_KEY_CHARS) {
    throw new RangeError(`schedule.key must be at most ${MAX_SCHEDULE_KEY_CHARS} characters`);
  }

  return value;
}

function normalizeScheduleAffinityKey(value: unknown): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new TypeError("schedule.affinityKey must be a string");
  }

  if (value.length > MAX_SCHEDULE_AFFINITY_KEY_CHARS) {
    throw new RangeError(
      `schedule.affinityKey must be at most ${MAX_SCHEDULE_AFFINITY_KEY_CHARS} characters`,
    );
  }

  return value;
}

function assertScheduleOptions<T>(value: unknown): asserts value is ScheduleTaskOptions<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("schedule options must be an object");
  }
}

function assertScheduleHandler<T>(
  value: unknown,
): asserts value is (signal: AbortSignal) => Promise<T> {
  if (typeof value !== "function") {
    throw new TypeError("schedule.handler must be a function");
  }
}

function normalizeBackendSlotSnapshots(value: unknown): SchedulerSlotSnapshot[] {
  if (!Array.isArray(value)) {
    throw new TypeError("scheduler backend slots must be an array");
  }

  if (value.length > MAX_SCHEDULER_BACKEND_SLOTS) {
    throw new RangeError(
      `scheduler backend slots must contain at most ${MAX_SCHEDULER_BACKEND_SLOTS} entries`,
    );
  }

  const slots: SchedulerSlotSnapshot[] = [];

  for (const [index, slot] of value.entries()) {
    if (slot === null || typeof slot !== "object" || Array.isArray(slot)) {
      throw new TypeError(`scheduler backend slots[${index}] must be an object`);
    }

    const snapshot = slot as Partial<SchedulerSlotSnapshot>;
    if (snapshot.id === undefined) {
      throw new TypeError(`scheduler backend slots[${index}].id is required`);
    }
    assertOptionalNonNegativeSafeIntegerAtMost(
      snapshot.id,
      `scheduler backend slots[${index}].id`,
      MAX_SCHEDULER_SLOT_DIAGNOSTIC_NUMBER,
    );

    if (typeof snapshot.isProcessing !== "boolean") {
      throw new TypeError(`scheduler backend slots[${index}].isProcessing must be a boolean`);
    }

    if (
      typeof snapshot.updatedAt !== "string" ||
      snapshot.updatedAt.length === 0 ||
      snapshot.updatedAt.length > MAX_SCHEDULER_SLOT_UPDATED_AT_CHARS
    ) {
      throw new TypeError(`scheduler backend slots[${index}].updatedAt must be a bounded string`);
    }

    assertOptionalNonNegativeSafeIntegerAtMost(
      snapshot.taskId,
      `scheduler backend slots[${index}].taskId`,
      MAX_SCHEDULER_SLOT_DIAGNOSTIC_NUMBER,
    );
    assertOptionalNonNegativeSafeIntegerAtMost(
      snapshot.contextWindow,
      `scheduler backend slots[${index}].contextWindow`,
      MAX_SCHEDULER_SLOT_DIAGNOSTIC_NUMBER,
    );
    const maxSlotTokens = snapshot.contextWindow ?? MAX_SCHEDULER_SLOT_DIAGNOSTIC_NUMBER;
    assertOptionalNonNegativeSafeIntegerAtMost(
      snapshot.promptTokens,
      `scheduler backend slots[${index}].promptTokens`,
      maxSlotTokens,
    );
    assertOptionalNonNegativeSafeIntegerAtMost(
      snapshot.cacheTokens,
      `scheduler backend slots[${index}].cacheTokens`,
      maxSlotTokens,
    );

    const normalized: SchedulerSlotSnapshot = {
      id: snapshot.id,
      isProcessing: snapshot.isProcessing,
      updatedAt: snapshot.updatedAt,
    };

    if (snapshot.taskId !== undefined) {
      normalized.taskId = snapshot.taskId;
    }

    if (snapshot.contextWindow !== undefined) {
      normalized.contextWindow = snapshot.contextWindow;
    }

    if (snapshot.promptTokens !== undefined) {
      normalized.promptTokens = snapshot.promptTokens;
    }

    if (snapshot.cacheTokens !== undefined) {
      normalized.cacheTokens = snapshot.cacheTokens;
    }

    slots.push(normalized);
  }

  return slots;
}

function normalizeSchedulerConfig(config: SchedulerConfig): SchedulerConfig {
  assertSchedulerConfig(config);
  assertPositiveSafeIntegerAtMost(
    config.concurrency,
    "scheduler.concurrency",
    MAX_SCHEDULER_CONCURRENCY,
  );
  assertPositiveSafeIntegerAtMost(config.maxQueue, "scheduler.maxQueue", MAX_SCHEDULER_QUEUE_DEPTH);
  assertPositiveSafeIntegerAtMost(
    config.maxQueuedTokens,
    "scheduler.maxQueuedTokens",
    MAX_SCHEDULER_QUEUED_TOKENS,
  );
  assertPositiveSafeIntegerAtMost(
    config.maxInflightTokens,
    "scheduler.maxInflightTokens",
    MAX_SCHEDULER_INFLIGHT_TOKENS,
  );
  assertPositiveSafeIntegerAtMost(
    config.requestTimeoutMs,
    "scheduler.requestTimeoutMs",
    MAX_REQUEST_TIMEOUT_MS,
  );
  assertNonNegativeSafeIntegerAtMost(
    config.batchWindowMs,
    "scheduler.batchWindowMs",
    MAX_SCHEDULER_BATCH_WINDOW_MS,
  );
  assertPositiveSafeInteger(config.affinityLookahead, "scheduler.affinityLookahead");
  assertPositiveSafeInteger(config.shortJobMaxTokens, "scheduler.shortJobMaxTokens");
  assertBoolean(config.dedupeInflight, "scheduler.dedupeInflight");

  if (config.batchWindowMs >= config.requestTimeoutMs) {
    throw new RangeError("scheduler.batchWindowMs must be less than scheduler.requestTimeoutMs");
  }

  if (config.affinityLookahead > config.maxQueue) {
    throw new RangeError("scheduler.affinityLookahead must be less than or equal to maxQueue");
  }

  return {
    concurrency: config.concurrency,
    maxQueue: config.maxQueue,
    maxQueuedTokens: config.maxQueuedTokens,
    maxInflightTokens: config.maxInflightTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    dedupeInflight: config.dedupeInflight,
    batchWindowMs: config.batchWindowMs,
    affinityLookahead: config.affinityLookahead,
    shortJobMaxTokens: config.shortJobMaxTokens,
  };
}

interface QueueItem<T> {
  key?: string;
  affinityKey?: string;
  preferredSlot?: number;
  lane: ScheduleLane;
  costTokens: number;
  enqueuedAt: number;
  queuedTimeout?: NodeJS.Timeout;
  handler: (signal: AbortSignal) => Promise<T>;
  resolve: (value: ScheduledTaskResult<T>) => void;
  reject: (reason?: unknown) => void;
}

interface QueueCandidate<T> {
  index: number;
  lane: ScheduleLane;
  item: QueueItem<T>;
  score: number;
}

export interface ScheduleTaskOptions<T> {
  key?: string;
  affinityKey?: string;
  preferredSlot?: number;
  lane?: ScheduleLane;
  costTokens?: number;
  handler: (signal: AbortSignal) => Promise<T>;
}

export interface ScheduledTaskResult<T> {
  value: T;
  queueTimeMs: number;
  deduplicated: boolean;
}

export class RequestScheduler<T> {
  private readonly queues: Record<ScheduleLane, QueueItem<T>[]> = {
    short: [],
    draft: [],
  };
  private readonly dedupeMap = new Map<string, Promise<ScheduledTaskResult<T>>>();
  private readonly backendSlots = new Map<number, SchedulerSlotSnapshot>();
  private readonly inFlightSlots = new Map<number, number>();
  private inFlight = 0;
  private queuedTokens = 0;
  private inFlightTokens = 0;
  private drainTimer: NodeJS.Timeout | undefined;
  private lastAffinityKey: string | undefined;
  private readonly config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = normalizeSchedulerConfig(config);
  }

  schedule(options: ScheduleTaskOptions<T>): Promise<ScheduledTaskResult<T>> {
    assertScheduleOptions<T>(options);
    assertScheduleHandler<T>(options.handler);
    const key = normalizeScheduleKey(options.key);
    const affinityKey = normalizeScheduleAffinityKey(options.affinityKey);
    const lane = normalizeScheduleLane(options.lane);
    const costTokens = normalizeCostTokens(options.costTokens);
    const preferredSlot = normalizePreferredSlot(options.preferredSlot);

    if (costTokens > this.config.maxInflightTokens || costTokens > this.config.maxQueuedTokens) {
      throw new RayError("The request exceeds the scheduler token budget", {
        code: "request_token_budget_exceeded",
        status: 413,
        details: {
          requestedTokens: costTokens,
          ...this.snapshot(),
        },
      });
    }

    if (key && this.config.dedupeInflight) {
      const existing = this.dedupeMap.get(key);
      if (existing) {
        return existing.then((result) => ({
          ...result,
          deduplicated: true,
        }));
      }
    }

    if (
      this.snapshot().queueDepth >= this.config.maxQueue ||
      this.queuedTokens + costTokens > this.config.maxQueuedTokens
    ) {
      throw new RayError("The request queue is full", {
        code: "queue_full",
        status: 503,
        details: this.snapshot(),
      });
    }

    let item!: QueueItem<T>;

    const promise = new Promise<ScheduledTaskResult<T>>((resolve, reject) => {
      item = {
        lane,
        costTokens,
        enqueuedAt: Date.now(),
        handler: options.handler,
        resolve,
        reject,
        ...(key ? { key } : {}),
        ...(affinityKey ? { affinityKey } : {}),
        ...(preferredSlot !== undefined ? { preferredSlot } : {}),
      };
    });

    if (key && this.config.dedupeInflight) {
      this.dedupeMap.set(key, promise);
      void promise
        .finally(() => {
          this.dedupeMap.delete(key);
        })
        .catch(() => undefined);
    }

    this.queues[lane].push(item);
    this.queuedTokens += costTokens;
    this.armQueuedTimeout(item);
    this.requestDrain();

    return promise;
  }

  updateBackendSlots(slots: SchedulerSlotSnapshot[]): void {
    const normalizedSlots = normalizeBackendSlotSnapshots(slots);
    this.backendSlots.clear();

    for (const slot of normalizedSlots) {
      this.backendSlots.set(slot.id, slot);
    }
  }

  snapshot(): SchedulerSnapshot {
    const shortQueueDepth = this.queues.short.length;
    const draftQueueDepth = this.queues.draft.length;

    return {
      queueDepth: shortQueueDepth + draftQueueDepth,
      shortQueueDepth,
      draftQueueDepth,
      inFlight: this.inFlight,
      maxQueue: this.config.maxQueue,
      concurrency: this.config.concurrency,
      queuedTokens: this.queuedTokens,
      inFlightTokens: this.inFlightTokens,
      maxQueuedTokens: this.config.maxQueuedTokens,
      maxInflightTokens: this.config.maxInflightTokens,
    };
  }

  private drain(): void {
    while (this.inFlight < this.config.concurrency && this.snapshot().queueDepth > 0) {
      const candidate = this.selectNextCandidate();
      if (!candidate) {
        break;
      }

      const [item] = this.queues[candidate.lane].splice(candidate.index, 1);
      if (!item) {
        break;
      }

      this.queuedTokens -= item.costTokens;
      this.clearQueuedTimeout(item);
      this.lastAffinityKey = item.affinityKey ?? this.lastAffinityKey;
      void this.run(item);
    }
  }

  private selectNextCandidate(): QueueCandidate<T> | undefined {
    const shortCandidate = this.selectBestCandidateFromLane("short");
    const draftCandidate = this.selectBestCandidateFromLane("draft");

    if (!shortCandidate) {
      return draftCandidate;
    }

    if (!draftCandidate) {
      return shortCandidate;
    }

    return shortCandidate.score >= draftCandidate.score ? shortCandidate : draftCandidate;
  }

  private selectBestCandidateFromLane(lane: ScheduleLane): QueueCandidate<T> | undefined {
    const queue = this.queues[lane];
    if (queue.length === 0) {
      return undefined;
    }

    const fitting = queue
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => this.inFlightTokens + item.costTokens <= this.config.maxInflightTokens);

    if (fitting.length === 0) {
      return undefined;
    }

    const lookahead = Math.max(1, this.config.affinityLookahead);
    const fittingWithinLookahead = fitting.filter(({ index }) => index < lookahead);
    const candidatePool = fittingWithinLookahead.length > 0 ? fittingWithinLookahead : fitting;
    const dominantAffinity = this.findDominantAffinity(candidatePool);
    const now = Date.now();

    let bestCandidate: QueueCandidate<T> | undefined;

    for (const { item, index } of candidatePool) {
      const score = this.scoreCandidate(item, dominantAffinity, now);
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          index,
          lane,
          item,
          score,
        };
      }
    }

    return bestCandidate;
  }

  private scoreCandidate(
    item: QueueItem<T>,
    dominantAffinity: string | undefined,
    now: number,
  ): number {
    let score = (now - item.enqueuedAt) / WAIT_SCORE_DIVISOR;

    if (item.lane === "short") {
      score += SHORT_LANE_BONUS;
    }

    if (this.lastAffinityKey && item.affinityKey === this.lastAffinityKey) {
      score += RECENT_AFFINITY_BONUS;
    }

    if (dominantAffinity && item.affinityKey === dominantAffinity) {
      score += DOMINANT_AFFINITY_BONUS;
    }

    if (item.preferredSlot !== undefined) {
      const backendSlot = this.backendSlots.get(item.preferredSlot);
      const inFlightOnSlot = this.inFlightSlots.get(item.preferredSlot) ?? 0;

      if (backendSlot && !backendSlot.isProcessing && inFlightOnSlot === 0) {
        score += SLOT_IDLE_BONUS;
      } else if (backendSlot && (backendSlot.isProcessing || inFlightOnSlot > 0)) {
        score -= SLOT_BUSY_PENALTY;
      } else if (inFlightOnSlot === 0) {
        score += SLOT_IDLE_BONUS / 3;
      } else {
        score -= SLOT_BUSY_PENALTY / 2;
      }
    }

    return score;
  }

  private findDominantAffinity(
    candidates: Array<{ item: QueueItem<T>; index: number }>,
  ): string | undefined {
    const counts = new Map<string, number>();

    for (const { item } of candidates) {
      if (!item.affinityKey) {
        continue;
      }

      counts.set(item.affinityKey, (counts.get(item.affinityKey) ?? 0) + 1);
    }

    let bestKey: string | undefined;
    let bestCount = 1;

    for (const [key, count] of counts.entries()) {
      if (count > bestCount) {
        bestKey = key;
        bestCount = count;
      }
    }

    return bestKey;
  }

  private requestDrain(): void {
    if (this.config.batchWindowMs <= 0) {
      this.drain();
      return;
    }

    if (this.drainTimer) {
      return;
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, this.config.batchWindowMs);
  }

  private armQueuedTimeout(item: QueueItem<T>): void {
    item.queuedTimeout = setTimeout(() => {
      delete item.queuedTimeout;

      if (!this.removeQueuedItem(item)) {
        return;
      }

      item.reject(createRequestTimeoutError());
      this.requestDrain();
    }, this.config.requestTimeoutMs);
  }

  private clearQueuedTimeout(item: QueueItem<T>): void {
    if (!item.queuedTimeout) {
      return;
    }

    clearTimeout(item.queuedTimeout);
    delete item.queuedTimeout;
  }

  private removeQueuedItem(item: QueueItem<T>): boolean {
    const queue = this.queues[item.lane];
    const index = queue.indexOf(item);

    if (index === -1) {
      return false;
    }

    queue.splice(index, 1);
    this.queuedTokens -= item.costTokens;
    return true;
  }

  private async run(item: QueueItem<T>): Promise<void> {
    this.inFlight += 1;
    this.inFlightTokens += item.costTokens;

    if (item.preferredSlot !== undefined) {
      this.inFlightSlots.set(
        item.preferredSlot,
        (this.inFlightSlots.get(item.preferredSlot) ?? 0) + 1,
      );
    }

    const queueTimeMs = Date.now() - item.enqueuedAt;
    let timeout: NodeJS.Timeout | undefined;

    try {
      const remainingTimeoutMs = this.config.requestTimeoutMs - queueTimeMs;

      if (remainingTimeoutMs <= 0) {
        throw createRequestTimeoutError();
      }

      const controller = new AbortController();
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = createRequestTimeoutError();
          controller.abort(error);
          reject(error);
        }, remainingTimeoutMs);
      });
      const handlerPromise = item.handler(controller.signal);
      void handlerPromise.catch(() => undefined);
      const value = await Promise.race([handlerPromise, timeoutPromise]);
      item.resolve({
        value,
        queueTimeMs,
        deduplicated: false,
      });
    } catch (error) {
      item.reject(error);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.inFlight -= 1;
      this.inFlightTokens -= item.costTokens;

      if (item.preferredSlot !== undefined) {
        const remaining = (this.inFlightSlots.get(item.preferredSlot) ?? 1) - 1;
        if (remaining <= 0) {
          this.inFlightSlots.delete(item.preferredSlot);
        } else {
          this.inFlightSlots.set(item.preferredSlot, remaining);
        }
      }

      this.requestDrain();
    }
  }
}
