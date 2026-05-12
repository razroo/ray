import test from "node:test";
import assert from "node:assert/strict";
import { Logger, RuntimeMetrics } from "./index.js";

test("logger rejects invalid direct config", () => {
  assert.throws(() => new Logger("", "info"), /serviceName/);
  assert.throws(() => new Logger("ray-test", "trace" as "info"), /level/);
});

test("logger emits JSON for circular and non-JSON-native fields", () => {
  const originalLog = console.log;
  let line = "";
  console.log = (value?: unknown) => {
    line = String(value);
  };

  try {
    const circular: Record<string, unknown> = {
      label: "root",
    };
    circular.self = circular;

    assert.doesNotThrow(() => {
      new Logger("ray-test", "debug").info("safe log", {
        count: 2n,
        circular,
        huge: "x".repeat(8_193),
      });
    });
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(line) as {
    service: string;
    count: string;
    circular: { self: string };
    huge: string;
  };
  assert.equal(parsed.service, "ray-test");
  assert.equal(parsed.count, "2");
  assert.equal(parsed.circular.self, "[Circular]");
  assert.match(parsed.huge, /\[truncated 1 chars\]$/);
});

test("logger protects core fields and throwing top-level accessors", () => {
  const originalLog = console.log;
  let line = "";
  console.log = (value?: unknown) => {
    line = String(value);
  };

  try {
    const fields: Record<string, unknown> = {
      level: "spoofed",
      message: "spoofed",
      service: "spoofed",
      ts: "spoofed",
    };
    Object.defineProperty(fields, "explode", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    assert.doesNotThrow(() => {
      new Logger("ray-test", "debug").info("safe log", fields);
    });
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(line) as {
    service: string;
    level: string;
    message: string;
    "field.service": string;
    "field.level": string;
    "field.message": string;
    "field.ts": string;
    explode: string;
  };
  assert.equal(parsed.service, "ray-test");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "safe log");
  assert.equal(parsed["field.service"], "spoofed");
  assert.equal(parsed["field.level"], "spoofed");
  assert.equal(parsed["field.message"], "spoofed");
  assert.equal(parsed["field.ts"], "spoofed");
  assert.equal(parsed.explode, "[Thrown: boom]");
});

test("logger does not throw when field accessors fail", () => {
  const originalError = console.error;
  let line = "";
  console.error = (value?: unknown) => {
    line = String(value);
  };

  try {
    const field = {};
    Object.defineProperty(field, "explode", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    assert.doesNotThrow(() => {
      new Logger("ray-test", "debug").error("safe error log", {
        field,
      });
    });
  } finally {
    console.error = originalError;
  }

  const parsed = JSON.parse(line) as {
    field: { explode: string };
  };
  assert.equal(parsed.field.explode, "[Thrown: boom]");
});

test("runtime metrics rejects invalid direct metric values", () => {
  const metrics = new RuntimeMetrics();

  assert.throws(() => metrics.increment("", 1), /metric name/);
  assert.throws(() => metrics.increment("1bad", 1), /metric name/);
  assert.throws(() => metrics.increment("requests.total", Infinity), /metric increment/);
  assert.throws(() => metrics.gauge("queue.depth", Number.NaN), /metric value/);
});

test("runtime metrics bounds direct metric series", () => {
  const metrics = new RuntimeMetrics();

  for (let index = 0; index < 257; index += 1) {
    metrics.gauge(`custom.metric.${index}`, index);
  }

  const snapshot = metrics.snapshot(false);

  assert.ok(Object.keys(snapshot.gauges).length <= 256);
  assert.equal(snapshot.gauges["custom.metric.0"], undefined);
  assert.equal(snapshot.gauges["custom.metric.256"], 256);
});
