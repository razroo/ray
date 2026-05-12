import { createHash, randomUUID } from "node:crypto";

const MAX_STABLE_STRING_CHARS = 1_048_576;
const MAX_STABLE_KEY_CHARS = 1_024;
const MAX_STABLE_OBJECT_KEYS = 512;
const MAX_STABLE_ARRAY_ITEMS = 4_096;
const MAX_STABLE_DEPTH = 32;
const MAX_STABLE_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_ID_PREFIX_CHARS = 32;
const MAX_ERROR_MESSAGE_CHARS = 8_000;
const MAX_SLEEP_MS = 120_000;

function assertStableStringLength(value: string, label: string, maximum: number): void {
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters`);
  }
}

function assertStableDepth(depth: number): void {
  if (depth > MAX_STABLE_DEPTH) {
    throw new RangeError(`stableStringify depth must be at most ${MAX_STABLE_DEPTH}`);
  }
}

function stableJsonString(value: string): string {
  assertStableStringLength(value, "stableStringify string", MAX_STABLE_STRING_CHARS);
  return JSON.stringify(value);
}

function hashBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_STABLE_BINARY_BYTES) {
    throw new RangeError(
      `stableStringify binary values must be at most ${MAX_STABLE_BINARY_BYTES} bytes`,
    );
  }

  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function stableStringifyEntries(
  entries: Array<[string, unknown]>,
  seen: WeakSet<object>,
  depth: number,
): string {
  if (entries.length > MAX_STABLE_OBJECT_KEYS) {
    throw new RangeError(
      `stableStringify objects must contain at most ${MAX_STABLE_OBJECT_KEYS} keys`,
    );
  }

  const mapped = entries
    .map(([key, nested]) => {
      assertStableStringLength(key, "stableStringify object keys", MAX_STABLE_KEY_CHARS);
      return `${JSON.stringify(key)}:${stableStringifyValue(nested, seen, depth + 1)}`;
    })
    .sort();

  return `{${mapped.join(",")}}`;
}

function stableStringifyValue(value: unknown, seen: WeakSet<object>, depth: number): string {
  assertStableDepth(depth);

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return stableJsonString(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : `[Number:${String(value)}]`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "undefined") {
    return "[Undefined]";
  }

  if (typeof value === "bigint") {
    return `[BigInt:${value.toString()}]`;
  }

  if (typeof value === "symbol") {
    return `[Symbol:${stableJsonString(String(value))}]`;
  }

  if (typeof value === "function") {
    return `[Function:${stableJsonString(value.name || "anonymous")}]`;
  }

  if (seen.has(value)) {
    throw new TypeError("stableStringify cannot serialize circular structures");
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Date:Invalid]" : `[Date:${value.toISOString()}]`;
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `[${value.constructor.name}:${value.byteLength}:${hashBytes(bytes)}]`;
  }

  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer:${value.byteLength}:${hashBytes(new Uint8Array(value))}]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_STABLE_ARRAY_ITEMS) {
        throw new RangeError(
          `stableStringify arrays must contain at most ${MAX_STABLE_ARRAY_ITEMS} items`,
        );
      }

      return `[${value.map((item) => stableStringifyValue(item, seen, depth + 1)).join(",")}]`;
    }

    if (value instanceof Map) {
      if (value.size > MAX_STABLE_OBJECT_KEYS) {
        throw new RangeError(
          `stableStringify maps must contain at most ${MAX_STABLE_OBJECT_KEYS} entries`,
        );
      }

      const mapped = Array.from(value.entries())
        .map(([key, nested]) => {
          return `${stableStringifyValue(key, seen, depth + 1)}:${stableStringifyValue(nested, seen, depth + 1)}`;
        })
        .sort();

      return `Map{${mapped.join(",")}}`;
    }

    if (value instanceof Set) {
      if (value.size > MAX_STABLE_OBJECT_KEYS) {
        throw new RangeError(
          `stableStringify sets must contain at most ${MAX_STABLE_OBJECT_KEYS} entries`,
        );
      }

      const mapped = Array.from(value.values())
        .map((entry) => stableStringifyValue(entry, seen, depth + 1))
        .sort();

      return `Set{${mapped.join(",")}}`;
    }

    let entries: Array<[string, unknown]>;
    try {
      entries = Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
    } catch (error) {
      throw new TypeError(
        `stableStringify could not read object entries: ${toErrorMessage(error)}`,
      );
    }

    return stableStringifyEntries(entries, seen, depth);
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet(), 0);
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function createRequestId(prefix = "ray"): string {
  if (
    typeof prefix !== "string" ||
    prefix.length === 0 ||
    prefix.length > MAX_REQUEST_ID_PREFIX_CHARS ||
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)
  ) {
    throw new TypeError(
      `request id prefix must be 1-${MAX_REQUEST_ID_PREFIX_CHARS} characters of A-Z, a-z, 0-9, _ or -, starting with a letter`,
    );
  }

  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("clamp value must be finite");
  }

  if (!Number.isFinite(minimum)) {
    throw new RangeError("clamp minimum must be finite");
  }

  if (!Number.isFinite(maximum)) {
    throw new RangeError("clamp maximum must be finite");
  }

  if (minimum > maximum) {
    throw new RangeError("clamp minimum must be less than or equal to maximum");
  }

  return Math.min(Math.max(value, minimum), maximum);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function truncateErrorMessage(value: string): string {
  if (value.length <= MAX_ERROR_MESSAGE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_ERROR_MESSAGE_CHARS)}...[truncated ${
    value.length - MAX_ERROR_MESSAGE_CHARS
  } chars]`;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return truncateErrorMessage(error.message);
  }

  if (typeof error === "string") {
    return truncateErrorMessage(error);
  }

  return "Unknown error";
}

export function sleep(ms: number): Promise<void> {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError("sleep duration must be a non-negative safe integer");
  }

  if (ms > MAX_SLEEP_MS) {
    throw new RangeError(`sleep duration must be less than or equal to ${MAX_SLEEP_MS}ms`);
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
