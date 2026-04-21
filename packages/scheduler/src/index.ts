import { RayError, type SchedulerConfig, type SchedulerSnapshot } from "@ray/core";

interface QueueItem<T> {
  key?: string;
  enqueuedAt: number;
  handler: (signal: AbortSignal) => Promise<T>;
  resolve: (value: ScheduledTaskResult<T>) => void;
  reject: (reason?: unknown) => void;
}

export interface ScheduleTaskOptions<T> {
  key?: string;
  handler: (signal: AbortSignal) => Promise<T>;
}

export interface ScheduledTaskResult<T> {
  value: T;
  queueTimeMs: number;
  deduplicated: boolean;
}

export class RequestScheduler<T> {
  private readonly queue: QueueItem<T>[] = [];
  private readonly dedupeMap = new Map<string, Promise<ScheduledTaskResult<T>>>();
  private inFlight = 0;
  private drainTimer: NodeJS.Timeout | undefined;

  constructor(private readonly config: SchedulerConfig) {}

  schedule(options: ScheduleTaskOptions<T>): Promise<ScheduledTaskResult<T>> {
    if (options.key && this.config.dedupeInflight) {
      const existing = this.dedupeMap.get(options.key);
      if (existing) {
        return existing.then((result) => ({
          ...result,
          deduplicated: true,
        }));
      }
    }

    if (this.queue.length >= this.config.maxQueue) {
      throw new RayError("The request queue is full", {
        code: "queue_full",
        status: 503,
        details: this.snapshot(),
      });
    }

    let item!: QueueItem<T>;

    const promise = new Promise<ScheduledTaskResult<T>>((resolve, reject) => {
      item = {
        enqueuedAt: Date.now(),
        handler: options.handler,
        resolve,
        reject,
        ...(options.key ? { key: options.key } : {}),
      };
    });

    if (options.key && this.config.dedupeInflight) {
      this.dedupeMap.set(options.key, promise);
      void promise.finally(() => {
        this.dedupeMap.delete(options.key as string);
      });
    }

    this.queue.push(item);
    this.requestDrain();

    return promise;
  }

  snapshot(): SchedulerSnapshot {
    return {
      queueDepth: this.queue.length,
      inFlight: this.inFlight,
      maxQueue: this.config.maxQueue,
      concurrency: this.config.concurrency,
    };
  }

  private drain(): void {
    while (this.inFlight < this.config.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        break;
      }

      void this.run(item);
    }
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

  private async run(item: QueueItem<T>): Promise<void> {
    this.inFlight += 1;
    const queueTimeMs = Date.now() - item.enqueuedAt;
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort(
        new RayError("The inference request exceeded the scheduler timeout", {
          code: "request_timeout",
          status: 504,
        }),
      );
    }, this.config.requestTimeoutMs);

    try {
      const value = await item.handler(controller.signal);
      item.resolve({
        value,
        queueTimeMs,
        deduplicated: false,
      });
    } catch (error) {
      item.reject(error);
    } finally {
      clearTimeout(timeout);
      this.inFlight -= 1;
      this.requestDrain();
    }
  }
}
