import { toErrorMessage, type LogLevel, type RuntimeMetricsSnapshot } from "@ray/core";

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
  private readonly recent = {
    lastLatencyMs: null as number | null,
    lastCacheHitAt: null as string | null,
    lastRequestAt: null as string | null,
  };

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  recordRequest(latencyMs: number, cached: boolean): void {
    this.increment("requests.total");
    if (cached) {
      this.increment("cache.hits");
      this.recent.lastCacheHitAt = new Date().toISOString();
    } else {
      this.increment("cache.misses");
    }

    this.recent.lastLatencyMs = latencyMs;
    this.recent.lastRequestAt = new Date().toISOString();
  }

  recordError(): void {
    this.increment("requests.errors");
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries()),
      recent: structuredClone(this.recent),
    };
  }
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
