import { availableParallelism } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  toErrorMessage,
  type LogLevel,
  type ProviderDiagnostics,
  type ProviderHealthSnapshot,
  type RuntimeMetricsSnapshot,
  type SchedulerSlotSnapshot,
} from "@razroo/ray-core";

const logOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly serviceName: string,
    private readonly level: LogLevel,
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  private log(level: LogLevel, message: string, fields?: LogFields): void {
    if (logOrder[level] < logOrder[this.level]) {
      return;
    }

    const line = {
      ts: new Date().toISOString(),
      service: this.serviceName,
      level,
      message,
      ...(fields ?? {}),
    };

    const writer = level === "error" ? console.error : console.log;
    writer(JSON.stringify(line));
  }
}

export class RuntimeMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly cpuCount = Math.max(1, availableParallelism());
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleAt = Date.now();
  private readonly recent = {
    lastLatencyMs: null as number | null,
    lastCacheHitAt: null as string | null,
    lastRequestAt: null as string | null,
    lastErrorAt: null as string | null,
    lastDegradedAt: null as string | null,
    lastRateLimitAt: null as string | null,
    lastAuthRejectAt: null as string | null,
    lastPromptCacheReuseRatio: null as number | null,
    lastPromptCacheTokens: null as number | null,
    lastSlotId: null as number | null,
    lastSlotOccupancyRatio: null as number | null,
    lastProcessRssMiB: null as number | null,
    lastHeapUsedMiB: null as number | null,
    lastCpuPercent: null as number | null,
    lastEventLoopLagP95Ms: null as number | null,
  };

  constructor() {
    this.eventLoopDelay.enable();
  }

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  recordRequest(latencyMs: number, options: { cached: boolean; degraded: boolean }): void {
    this.increment("requests.total");
    if (options.cached) {
      this.increment("cache.hits");
      this.recent.lastCacheHitAt = new Date().toISOString();
    } else {
      this.increment("cache.misses");
    }

    if (options.degraded) {
      this.increment("requests.degraded");
      this.recent.lastDegradedAt = new Date().toISOString();
    }

    this.recent.lastLatencyMs = latencyMs;
    this.recent.lastRequestAt = new Date().toISOString();
  }

  recordError(): void {
    this.increment("requests.errors");
    this.recent.lastErrorAt = new Date().toISOString();
  }

  recordRateLimitReject(): void {
    this.increment("requests.rate_limited");
    this.recent.lastRateLimitAt = new Date().toISOString();
  }

  recordAuthReject(): void {
    this.increment("requests.auth_rejected");
    this.recent.lastAuthRejectAt = new Date().toISOString();
  }

  recordProviderHealth(snapshot: ProviderHealthSnapshot): void {
    this.gauge(
      "provider.health.status",
      snapshot.status === "ready"
        ? 1
        : snapshot.status === "degraded" || snapshot.status === "warming"
          ? 0.5
          : 0,
    );

    if (typeof snapshot.latencyMs === "number") {
      this.gauge("provider.health.latency_ms", snapshot.latencyMs);
    }

    const details = snapshot.details;
    if (!details) {
      return;
    }

    const slotsIdle = this.resolveNumericDetail(details, "slotsIdle");
    const slotsProcessing = this.resolveNumericDetail(details, "slotsProcessing");
    const totalSlots = this.resolveNumericDetail(details, "totalSlots");

    if (typeof slotsIdle === "number") {
      this.gauge("provider.slots.idle", slotsIdle);
    }

    if (typeof slotsProcessing === "number") {
      this.gauge("provider.slots.processing", slotsProcessing);
    }

    if (typeof totalSlots === "number" && totalSlots > 0) {
      this.gauge("provider.slots.total", totalSlots);

      if (typeof slotsProcessing === "number") {
        const occupancyRatio = slotsProcessing / totalSlots;
        this.gauge("provider.slots.occupancy_ratio", occupancyRatio);
        this.recent.lastSlotOccupancyRatio = occupancyRatio;
      }
    }
  }

  recordProviderResult(options: {
    diagnostics?: ProviderDiagnostics;
    promptTokens?: number;
    slotSnapshots?: SchedulerSlotSnapshot[];
  }): void {
    const diagnostics = options.diagnostics;
    const slotSnapshots = options.slotSnapshots ?? [];

    if (slotSnapshots.length > 0) {
      const processing = slotSnapshots.filter((slot) => slot.isProcessing).length;
      const idle = Math.max(0, slotSnapshots.length - processing);
      const occupancyRatio = processing / slotSnapshots.length;

      this.gauge("provider.slots.total", slotSnapshots.length);
      this.gauge("provider.slots.processing", processing);
      this.gauge("provider.slots.idle", idle);
      this.gauge("provider.slots.occupancy_ratio", occupancyRatio);
      this.recent.lastSlotOccupancyRatio = occupancyRatio;
    }

    const slotId = diagnostics?.slotId ?? diagnostics?.preferredSlot;
    if (typeof slotId === "number") {
      this.gauge("provider.slot.last_id", slotId);
      this.recent.lastSlotId = slotId;
      this.increment("provider.slot.assignments");
    }

    const tokensCached = diagnostics?.tokensCached;
    if (typeof tokensCached === "number") {
      this.gauge("provider.prompt_cache.tokens_cached", tokensCached);
      this.recent.lastPromptCacheTokens = tokensCached;
      this.increment(
        tokensCached > 0 ? "provider.prompt_cache.hits" : "provider.prompt_cache.misses",
      );

      if (typeof options.promptTokens === "number" && options.promptTokens > 0) {
        const reuseRatio = tokensCached / options.promptTokens;
        this.gauge("provider.prompt_cache.reuse_ratio", reuseRatio);
        this.recent.lastPromptCacheReuseRatio = reuseRatio;
      }
    }
  }

  snapshot(includeDebugMetrics = true): RuntimeMetricsSnapshot {
    this.captureProcessMetrics();

    const snapshot: RuntimeMetricsSnapshot = {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
    };

    if (includeDebugMetrics) {
      snapshot.recent = structuredClone(this.recent);
    }

    return snapshot;
  }

  private captureProcessMetrics(): void {
    const memory = process.memoryUsage();
    const rssMiB = bytesToMiB(memory.rss);
    const heapUsedMiB = bytesToMiB(memory.heapUsed);
    const heapTotalMiB = bytesToMiB(memory.heapTotal);
    const externalMiB = bytesToMiB(memory.external);
    const arrayBuffersMiB = bytesToMiB(memory.arrayBuffers);
    const cpuUsage = process.cpuUsage();
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastCpuSampleAt);
    const cpuUsedMicros =
      cpuUsage.user - this.lastCpuUsage.user + (cpuUsage.system - this.lastCpuUsage.system);
    const cpuPercent = Math.min(
      100,
      Math.max(0, (cpuUsedMicros / 1000 / elapsedMs / this.cpuCount) * 100),
    );
    const eventLoopLagP95Ms = nanosecondsToMs(this.eventLoopDelay.percentile(95));
    const eventLoopLagMeanMs = nanosecondsToMs(this.eventLoopDelay.mean);
    const eventLoopLagMaxMs = nanosecondsToMs(this.eventLoopDelay.max);

    this.gauge("process.memory.rss_mib", rssMiB);
    this.gauge("process.memory.heap_used_mib", heapUsedMiB);
    this.gauge("process.memory.heap_total_mib", heapTotalMiB);
    this.gauge("process.memory.external_mib", externalMiB);
    this.gauge("process.memory.array_buffers_mib", arrayBuffersMiB);
    this.gauge("process.cpu.percent", cpuPercent);
    this.gauge("process.cpu.user_ms_total", cpuUsage.user / 1000);
    this.gauge("process.cpu.system_ms_total", cpuUsage.system / 1000);
    this.gauge("runtime.event_loop_lag_p95_ms", eventLoopLagP95Ms);
    this.gauge("runtime.event_loop_lag_mean_ms", eventLoopLagMeanMs);
    this.gauge("runtime.event_loop_lag_max_ms", eventLoopLagMaxMs);

    this.recent.lastProcessRssMiB = rssMiB;
    this.recent.lastHeapUsedMiB = heapUsedMiB;
    this.recent.lastCpuPercent = cpuPercent;
    this.recent.lastEventLoopLagP95Ms = eventLoopLagP95Ms;

    this.lastCpuUsage = cpuUsage;
    this.lastCpuSampleAt = now;
    this.eventLoopDelay.reset();
  }

  private resolveNumericDetail(details: Record<string, unknown>, key: string): number | undefined {
    const value = details[key];
    return typeof value === "number" ? value : undefined;
  }
}

function bytesToMiB(value: number): number {
  return Number((value / (1024 * 1024)).toFixed(2));
}

function nanosecondsToMs(value: number): number {
  return Number.isFinite(value) ? Number((value / 1_000_000).toFixed(3)) : 0;
}

export function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    const serialized: { message: string; name?: string; stack?: string } = {
      message: error.message,
      name: error.name,
    };

    if (error.stack) {
      serialized.stack = error.stack;
    }

    return {
      ...serialized,
    };
  }

  return {
    message: toErrorMessage(error),
  };
}
