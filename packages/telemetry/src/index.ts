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
const MAX_LOG_FIELD_DEPTH = 6;
const MAX_LOG_OBJECT_KEYS = 64;
const MAX_LOG_ARRAY_ITEMS = 64;
const MAX_LOG_KEY_CHARS = 128;
const MAX_LOG_STRING_CHARS = 8_192;
const MAX_LOG_SERVICE_NAME_CHARS = 128;
const MAX_METRIC_SERIES = 256;
const MAX_METRIC_NAME_CHARS = 128;
const logLevels = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const reservedLogFields = new Set(["ts", "service", "level", "message"]);

export interface LogFields {
  [key: string]: unknown;
}

interface LogLine {
  ts: string;
  service: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

function assertNonEmptyStringLength(value: string, label: string, maxChars: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new RangeError(`${label} must be at most ${maxChars} characters`);
  }
}

function assertLogLevel(value: LogLevel): void {
  if (!logLevels.has(value)) {
    throw new TypeError("level must be a supported log level");
  }
}

function assertMetricName(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_METRIC_NAME_CHARS ||
    !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
  ) {
    throw new TypeError(
      `metric name must be 1-${MAX_METRIC_NAME_CHARS} characters and start with a letter`,
    );
  }
}

function assertFiniteMetricValue(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
}

function setBoundedMetricValue(metrics: Map<string, number>, name: string, value: number): void {
  if (!metrics.has(name) && metrics.size >= MAX_METRIC_SERIES) {
    const oldestKey = metrics.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      metrics.delete(oldestKey);
    }
  }

  metrics.set(name, value);
}

function truncateLogString(value: string, maxChars = MAX_LOG_STRING_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateLogString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_LOG_FIELD_DEPTH) {
    return "[Truncated]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (value instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: value.name,
      message: truncateLogString(value.message),
    };

    if (value.stack) {
      serialized.stack = truncateLogString(value.stack);
    }

    return serialized;
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_LOG_ARRAY_ITEMS)
        .map((entry) => sanitizeLogValue(entry, seen, depth + 1));

      if (value.length > MAX_LOG_ARRAY_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_LOG_ARRAY_ITEMS} items]`);
      }

      return items;
    }

    const output: Record<string, unknown> = {};
    let keys: string[];

    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable object: ${truncateLogString(toErrorMessage(error))}]`;
    }

    for (const key of keys.slice(0, MAX_LOG_OBJECT_KEYS)) {
      const safeKey = truncateLogString(key, MAX_LOG_KEY_CHARS);

      try {
        output[safeKey] = sanitizeLogValue(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[safeKey] = `[Thrown: ${truncateLogString(toErrorMessage(error))}]`;
      }
    }

    if (keys.length > MAX_LOG_OBJECT_KEYS) {
      output.__truncatedKeys = keys.length - MAX_LOG_OBJECT_KEYS;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(sanitizeLogValue(value, new WeakSet())) ?? "null";
  } catch (error) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      service: "ray-telemetry",
      level: "error",
      message: "failed to serialize log line",
      error: toErrorMessage(error),
    });
  }
}

function copyLogFields(line: LogLine, fields?: LogFields): void {
  if (!fields) {
    return;
  }

  let keys: string[];

  try {
    keys = Object.keys(fields);
  } catch (error) {
    line.fields = `[Unserializable fields: ${truncateLogString(toErrorMessage(error))}]`;
    return;
  }

  for (const key of keys.slice(0, MAX_LOG_OBJECT_KEYS)) {
    const targetKey = reservedLogFields.has(key) ? `field.${key}` : key;

    try {
      line[targetKey] = fields[key];
    } catch (error) {
      line[targetKey] = `[Thrown: ${truncateLogString(toErrorMessage(error))}]`;
    }
  }

  if (keys.length > MAX_LOG_OBJECT_KEYS) {
    line.__truncatedFields = keys.length - MAX_LOG_OBJECT_KEYS;
  }
}

export class Logger {
  private readonly serviceName: string;
  private readonly level: LogLevel;

  constructor(serviceName: string, level: LogLevel) {
    assertNonEmptyStringLength(serviceName, "serviceName", MAX_LOG_SERVICE_NAME_CHARS);
    assertLogLevel(level);
    this.serviceName = serviceName;
    this.level = level;
  }

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

    const line: LogLine = {
      ts: new Date().toISOString(),
      service: this.serviceName,
      level,
      message,
    };
    copyLogFields(line, fields);

    const writer = level === "error" ? console.error : console.log;
    writer(safeJsonStringify(line));
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
    assertMetricName(name);
    assertFiniteMetricValue(by, "metric increment");
    const next = (this.counters.get(name) ?? 0) + by;
    assertFiniteMetricValue(next, "metric counter");
    setBoundedMetricValue(this.counters, name, next);
  }

  gauge(name: string, value: number): void {
    assertMetricName(name);
    assertFiniteMetricValue(value, "metric value");
    setBoundedMetricValue(this.gauges, name, value);
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
