import assert from "node:assert/strict";
import test from "node:test";
import {
  clamp,
  createRequestId,
  getLlamaCppLaunchProfileExtraArgOverride,
  hashValue,
  sleep,
  stableStringify,
  toErrorMessage,
} from "./utils.js";

test("stableStringify preserves deterministic object ordering", () => {
  const left = {
    beta: 2,
    alpha: {
      delta: true,
      gamma: "value",
    },
  };
  const right = {
    alpha: {
      gamma: "value",
      delta: true,
    },
    beta: 2,
  };

  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashValue(left), hashValue(right));
});

test("stableStringify handles non-JSON primitives without collapsing them", () => {
  const serialized = stableStringify({
    missing: undefined,
    count: 2n,
    invalid: Number.NaN,
    nothing: null,
  });

  assert.match(serialized, /"missing":\[Undefined\]/);
  assert.match(serialized, /"count":\[BigInt:2\]/);
  assert.match(serialized, /"invalid":\[Number:NaN\]/);
  assert.match(serialized, /"nothing":null/);
});

test("stableStringify rejects circular structures with a clear error", () => {
  const circular: Record<string, unknown> = {
    label: "root",
  };
  circular.self = circular;

  assert.throws(() => stableStringify(circular), /circular structures/);
  assert.throws(() => hashValue(circular), /circular structures/);
});

test("stableStringify bounds direct serialization work", () => {
  assert.throws(() => stableStringify("x".repeat(1_048_577)), /string/);
  assert.throws(() => stableStringify(Array.from({ length: 4_097 }, () => 1)), /arrays/);
  assert.throws(
    () =>
      stableStringify(
        Object.fromEntries(Array.from({ length: 513 }, (_value, index) => [`key${index}`, 1])),
      ),
    /objects/,
  );

  let nested: unknown = "leaf";
  for (let index = 0; index < 33; index += 1) {
    nested = { nested };
  }

  assert.throws(() => stableStringify(nested), /depth/);
});

test("stableStringify rejects objects with unreadable entries", () => {
  const value = {};
  Object.defineProperty(value, "explode", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });

  assert.throws(() => stableStringify(value), /could not read object entries: boom/);
});

test("createRequestId validates direct prefixes", () => {
  assert.match(createRequestId("req"), /^req_[a-f0-9]{16}$/);
  assert.throws(() => createRequestId(""), /request id prefix/);
  assert.throws(() => createRequestId("1bad"), /request id prefix/);
  assert.throws(() => createRequestId("x".repeat(33)), /request id prefix/);
  assert.throws(() => createRequestId("bad/prefix"), /request id prefix/);
});

test("clamp rejects invalid numeric bounds", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.throws(() => clamp(Number.NaN, 0, 10), /clamp value/);
  assert.throws(() => clamp(1, Number.NEGATIVE_INFINITY, 10), /clamp minimum/);
  assert.throws(() => clamp(1, 10, 0), /clamp minimum/);
});

test("toErrorMessage bounds direct error text", () => {
  assert.equal(toErrorMessage(new Error("boom")), "boom");
  assert.equal(toErrorMessage("plain failure"), "plain failure");
  assert.match(toErrorMessage(new Error("x".repeat(8_001))), /\[truncated 1 chars\]$/);
  assert.match(toErrorMessage("x".repeat(8_001)), /\[truncated 1 chars\]$/);
  assert.equal(toErrorMessage({}), "Unknown error");
});

test("sleep rejects invalid direct durations", async () => {
  await sleep(0);
  assert.throws(() => sleep(-1), /sleep duration/);
  assert.throws(() => sleep(1.5), /sleep duration/);
  assert.throws(() => sleep(120_001), /sleep duration/);
});

test("getLlamaCppLaunchProfileExtraArgOverride detects launch-profile args", () => {
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("--host"), "--host");
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("--port=8082"), "--port");
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("-m=/models/other.gguf"), "-m");
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("--no-cache-prompt"), "--no-cache-prompt");
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("--jinja-template=chatml"), undefined);
  assert.equal(getLlamaCppLaunchProfileExtraArgOverride("--no-mmap"), undefined);
});
