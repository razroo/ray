import assert from "node:assert/strict";
import test from "node:test";
import { RayError } from "./errors.js";

test("RayError rejects invalid direct constructor values", () => {
  assert.throws(() => new RayError(""), /message/);
  assert.throws(() => new RayError("x".repeat(8_193)), /message/);
  assert.throws(
    () => new RayError("bad options", null as never),
    /RayError options must be an object/,
  );
  assert.throws(
    () => new RayError("bad options", { extra: true } as never),
    /RayError options contains unsupported key "extra"/,
  );
  assert.throws(
    () => new RayError("bad options", JSON.parse('{"__proto__":true}')),
    /RayError options must not contain unsafe key "__proto__"/,
  );
  assert.throws(() => new RayError("bad code", { code: "BadCode" }), /code/);
  assert.throws(() => new RayError("bad status", { status: 200 }), /status/);
  assert.throws(() => new RayError("bad status", { status: Number.NaN }), /status/);
});

test("RayError snapshots details at construction", () => {
  const details = {
    phase: "prepare",
    timeoutMs: 20,
  };
  const error = new RayError("timed out", {
    code: "request_timeout",
    status: 504,
    details,
  });
  details.timeoutMs = 100;

  assert.equal(error.code, "request_timeout");
  assert.equal(error.status, 504);
  assert.deepEqual(error.details, {
    phase: "prepare",
    timeoutMs: 20,
  });
});

test("RayError stores bounded JSON-safe details", () => {
  const details: Record<string, unknown> = {
    count: 2n,
    huge: "x".repeat(8_193),
    bytes: new Uint8Array(16),
    values: Array.from({ length: 65 }, (_value, index) => index),
  };
  const longKey = `k${"x".repeat(140)}`;
  details[longKey] = "bounded-key";
  details.self = details;
  Object.defineProperty(details, "explode", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    },
  });

  const error = new RayError("hostile details", {
    details,
  });
  const snapshot = error.details as {
    count?: string;
    huge?: string;
    self?: string;
    explode?: string;
    bytes?: string;
    values?: unknown[];
    [key: string]: unknown;
  };

  assert.equal(snapshot.count, "2");
  assert.match(snapshot.huge ?? "", /\[truncated 1 chars\]$/);
  assert.equal(snapshot.self, "[Circular]");
  assert.equal(snapshot.explode, "[Thrown: getter boom]");
  assert.equal(snapshot.bytes, "[Uint8Array 16 bytes]");
  assert.equal(snapshot.values?.at(-1), "[Truncated 1 items]");
  assert.equal(snapshot[`k${"x".repeat(104)}...[truncated 36 chars]`], "bounded-key");
  assert.equal(snapshot[longKey], undefined);
  assert.ok(Object.keys(snapshot).every((key) => key.length <= 128));
});

test("RayError converts nested Error details into bounded objects", () => {
  const cause = new Error("backend failed");
  const error = new RayError("provider failed", {
    details: {
      cause,
    },
  });

  const details = error.details as {
    cause?: {
      name?: string;
      message?: string;
      stack?: string;
    };
  };

  assert.equal(details.cause?.name, "Error");
  assert.equal(details.cause?.message, "backend failed");
  assert.equal(typeof details.cause?.stack, "string");
});

test("RayError stores unsafe detail keys as inert own properties", () => {
  const error = new RayError("hostile detail keys", {
    details: JSON.parse('{"__proto__":{"polluted":true},"constructor":"shadowed"}'),
  });
  const details = error.details as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(details), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(details, "__proto__"), true);
  assert.deepEqual(details.__proto__, { polluted: true });
  assert.equal(details.constructor, "shadowed");
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
