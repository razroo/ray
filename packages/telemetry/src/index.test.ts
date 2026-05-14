import test from "node:test";
import assert from "node:assert/strict";
import { Logger, RuntimeMetrics, serializeError } from "./index.js";

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
    const longKey = `k${"x".repeat(140)}`;
    circular[longKey] = "bounded-key";
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
    circular: { self: string; [key: string]: unknown };
    huge: string;
  };
  assert.equal(parsed.service, "ray-test");
  assert.equal(parsed.count, "2");
  assert.equal(parsed.circular.self, "[Circular]");
  assert.equal(parsed.circular[`k${"x".repeat(104)}...[truncated 36 chars]`], "bounded-key");
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
    const longKey = `k${"x".repeat(140)}`;
    fields[longKey] = "bounded-key";
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
    [key: string]: unknown;
  };
  assert.equal(parsed.service, "ray-test");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "safe log");
  assert.equal(parsed["field.service"], "spoofed");
  assert.equal(parsed["field.level"], "spoofed");
  assert.equal(parsed["field.message"], "spoofed");
  assert.equal(parsed["field.ts"], "spoofed");
  assert.equal(parsed.explode, "[Thrown: boom]");
  assert.equal(parsed[`k${"x".repeat(104)}...[truncated 36 chars]`], "bounded-key");
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

test("logger bounds direct Error fields", () => {
  const originalError = console.error;
  let line = "";
  console.error = (value?: unknown) => {
    line = String(value);
  };

  try {
    const error = new Error("x".repeat(8_193));
    error.name = "E".repeat(8_193);
    error.stack = "s".repeat(8_193);

    assert.doesNotThrow(() => {
      new Logger("ray-test", "debug").error("safe error log", {
        error,
      });
    });
  } finally {
    console.error = originalError;
  }

  const parsed = JSON.parse(line) as {
    error: {
      name: string;
      message: string;
      stack?: string;
    };
  };
  assert.match(parsed.error.name, /\[truncated 1 chars\]$/);
  assert.match(parsed.error.message, /\[truncated 1 chars\]$/);
  assert.match(parsed.error.stack ?? "", /\[truncated 1 chars\]$/);
});

test("serializeError bounds direct Error fields", () => {
  const error = new Error("x".repeat(8_193));
  error.name = "E".repeat(8_193);
  error.stack = "s".repeat(8_193);

  const serialized = serializeError(error);

  assert.match(serialized.name ?? "", /\[truncated 1 chars\]$/);
  assert.match(serialized.message, /\[truncated 1 chars\]$/);
  assert.match(serialized.stack ?? "", /\[truncated 1 chars\]$/);
  assert.equal(serializeError("plain failure").message, "plain failure");
});

test("runtime metrics rejects invalid direct metric values", () => {
  const metrics = new RuntimeMetrics();

  assert.throws(() => metrics.increment("", 1), /metric name/);
  assert.throws(() => metrics.increment("1bad", 1), /metric name/);
  assert.throws(
    () => metrics.increment("requests.total", Infinity),
    /metric increment.*absolute value no greater than 1000000000000000/,
  );
  assert.throws(
    () => metrics.increment("requests.total", 1_000_000_000_000_001),
    /metric increment.*absolute value no greater than 1000000000000000/,
  );
  metrics.increment("requests.total", 1_000_000_000_000_000);
  assert.throws(
    () => metrics.increment("requests.total", 1),
    /metric counter.*absolute value no greater than 1000000000000000/,
  );
  assert.throws(
    () => metrics.gauge("queue.depth", Number.NaN),
    /metric value.*absolute value no greater than 1000000000000000/,
  );
  assert.throws(
    () => metrics.gauge("queue.depth", -1_000_000_000_000_001),
    /metric value.*absolute value no greater than 1000000000000000/,
  );
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
