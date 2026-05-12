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

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
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

function normalizeSchedulerConfig(config: SchedulerConfig): SchedulerConfig {
  assertPositiveSafeInteger(config.concurrency, "scheduler.concurrency");
  assertPositiveSafeInteger(config.maxQueue, "scheduler.maxQueue");
  assertPositiveSafeInteger(config.maxQueuedTokens, "scheduler.maxQueuedTokens");
  assertPositiveSafeInteger(config.maxInflightTokens, "scheduler.maxInflightTokens");
  assertPositiveSafeInteger(config.requestTimeoutMs, "scheduler.requestTimeoutMs");
  assertNonNegativeSafeInteger(config.batchWindowMs, "scheduler.batchWindowMs");
  assertPositiveSafeInteger(config.affinityLookahead, "scheduler.affinityLookahead");
  assertPositiveSafeInteger(config.shortJobMaxTokens, "scheduler.shortJobMaxTokens");
  assertBoolean(config.dedupeInflight, "scheduler.dedupeInflight");

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
    const lane = normalizeScheduleLane(options.lane);
    const costTokens = normalizeCostTokens(options.costTokens);
    const preferredSlot = normalizePreferredSlot(options.preferredSlot);

    if (options.key && this.config.dedupeInflight) {
      const existing = this.dedupeMap.get(options.key);
      if (existing) {
        return existing.then((result) => ({
          ...result,
          deduplicated: true,
        }));
      }
    }

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
        ...(options.key ? { key: options.key } : {}),
        ...(options.affinityKey ? { affinityKey: options.affinityKey } : {}),
        ...(preferredSlot !== undefined ? { preferredSlot } : {}),
      };
    });

    if (options.key && this.config.dedupeInflight) {
      const dedupeKey = options.key;
      this.dedupeMap.set(dedupeKey, promise);
      void promise
        .finally(() => {
          this.dedupeMap.delete(dedupeKey);
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
    this.backendSlots.clear();

    for (const slot of slots) {
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
