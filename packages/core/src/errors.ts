import { toErrorMessage } from "./utils.js";

const MAX_ERROR_MESSAGE_CHARS = 8_192;
const MAX_ERROR_CODE_CHARS = 128;
const MAX_ERROR_DETAIL_DEPTH = 6;
const MAX_ERROR_DETAIL_OBJECT_KEYS = 64;
const MAX_ERROR_DETAIL_ARRAY_ITEMS = 64;
const MAX_ERROR_DETAIL_KEY_CHARS = 128;
const MAX_ERROR_DETAIL_STRING_CHARS = 8_192;

function assertErrorMessage(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("RayError message must be a non-empty string");
  }

  if (value.length > MAX_ERROR_MESSAGE_CHARS) {
    throw new RangeError(`RayError message must be at most ${MAX_ERROR_MESSAGE_CHARS} characters`);
  }
}

function assertErrorCode(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ERROR_CODE_CHARS ||
    !/^[a-z][a-z0-9_:-]*$/.test(value)
  ) {
    throw new TypeError(
      `RayError code must be 1-${MAX_ERROR_CODE_CHARS} characters of lowercase letters, numbers, _, :, or -`,
    );
  }
}

function assertErrorStatus(value: number): void {
  if (!Number.isSafeInteger(value) || value < 400 || value > 599) {
    throw new RangeError("RayError status must be an HTTP error status from 400 to 599");
  }
}

function truncateDetailString(value: string, maxChars = MAX_ERROR_DETAIL_STRING_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function snapshotErrorDetail(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateDetailString(value);
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

  if (depth >= MAX_ERROR_DETAIL_DEPTH) {
    return "[Truncated]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (value instanceof Error) {
    const snapshot: Record<string, unknown> = {
      name: truncateDetailString(value.name),
      message: truncateDetailString(value.message),
    };

    if (value.stack) {
      snapshot.stack = truncateDetailString(value.stack);
    }

    return snapshot;
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ERROR_DETAIL_ARRAY_ITEMS)
        .map((entry) => snapshotErrorDetail(entry, seen, depth + 1));

      if (value.length > MAX_ERROR_DETAIL_ARRAY_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_ERROR_DETAIL_ARRAY_ITEMS} items]`);
      }

      return items;
    }

    const output: Record<string, unknown> = {};
    let keys: string[];

    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable object: ${truncateDetailString(toErrorMessage(error))}]`;
    }

    for (const key of keys.slice(0, MAX_ERROR_DETAIL_OBJECT_KEYS)) {
      const safeKey = truncateDetailString(key, MAX_ERROR_DETAIL_KEY_CHARS);

      try {
        output[safeKey] = snapshotErrorDetail(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[safeKey] = `[Thrown: ${truncateDetailString(toErrorMessage(error))}]`;
      }
    }

    if (keys.length > MAX_ERROR_DETAIL_OBJECT_KEYS) {
      output.__truncatedKeys = keys.length - MAX_ERROR_DETAIL_OBJECT_KEYS;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

export class RayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, options?: { code?: string; status?: number; details?: unknown }) {
    assertErrorMessage(message);
    super(message);
    const code = options?.code ?? "ray_error";
    const status = options?.status ?? 500;
    assertErrorCode(code);
    assertErrorStatus(status);

    this.name = "RayError";
    this.code = code;
    this.status = status;

    if (options && "details" in options) {
      this.details = snapshotErrorDetail(options.details, new WeakSet());
    }
  }
}
