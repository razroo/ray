import type {
  CreateInferenceJobRequest,
  HealthSnapshot,
  InferenceJobAcceptedResponse,
  InferenceJobRecord,
  InferenceRequest,
  InferenceResponse,
  ReadinessSnapshot,
  RuntimeMetricsSnapshot,
} from "@razroo/ray-core";

export interface RayClientOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  requestBodyLimitBytes?: number;
  responseBodyLimitBytes?: number;
}

export const DEFAULT_RAY_CLIENT_TIMEOUT_MS = 60_000;
export const DEFAULT_RAY_CLIENT_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_RAY_CLIENT_RESPONSE_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_RAY_CLIENT_BASE_URL_CHARS = 2_048;
const MAX_RAY_CLIENT_TIMEOUT_MS = 600_000;
const MAX_RAY_CLIENT_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
const MAX_RAY_CLIENT_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_RAY_CLIENT_HEADERS = 64;
const MAX_RAY_CLIENT_HEADER_NAME_CHARS = 128;
const MAX_RAY_CLIENT_HEADER_VALUE_CHARS = 8_192;
const MAX_RAY_CLIENT_API_KEY_CHARS = 1_024;
const MAX_JOB_ID_CHARS = 128;
const unsafeHeaderNames = new Set(["__proto__", "constructor", "prototype"]);
const clientOptionKeys = new Set([
  "baseUrl",
  "apiKey",
  "headers",
  "timeoutMs",
  "requestBodyLimitBytes",
  "responseBodyLimitBytes",
]);
const reservedClientHeaderNames = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface LimitedResponseBody {
  text: string;
  truncated: boolean;
  bytesRead: number;
  limitBytes: number;
  declaredContentLength?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new TypeError("baseUrl must be a non-empty string");
  }

  if (baseUrl.length > MAX_RAY_CLIENT_BASE_URL_CHARS) {
    throw new RangeError(`baseUrl must be at most ${MAX_RAY_CLIENT_BASE_URL_CHARS} characters`);
  }

  if (/[\0-\x20\x7f]/.test(baseUrl)) {
    throw new TypeError("baseUrl must not contain unencoded whitespace or control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be a valid HTTP or HTTPS URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("baseUrl cannot include credentials, query strings, or fragments");
  }

  return parsed.toString().replace(/\/$/, "");
}

function assertPositiveSafeIntegerAtMost(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertHeaderName(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RAY_CLIENT_HEADER_NAME_CHARS ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
  ) {
    throw new TypeError("headers names must be valid bounded HTTP token strings");
  }
}

function assertHeaderValue(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_RAY_CLIENT_HEADER_VALUE_CHARS ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TypeError("headers values must be bounded strings without control characters");
  }
}

function assertClientOptions(value: unknown): asserts value is RayClientOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("RayClient options must be an object");
  }

  for (const [key] of objectEntries(value, "RayClient options")) {
    if (unsafeHeaderNames.has(key)) {
      throw new TypeError(`RayClient options must not contain unsafe key "${key}"`);
    }

    if (!clientOptionKeys.has(key)) {
      throw new TypeError(`RayClient options must not contain unsupported key "${key}"`);
    }
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function snapshotHeaders(headers?: Record<string, string>): Record<string, string> {
  const snapshot = Object.create(null) as Record<string, string>;
  snapshot["content-type"] = "application/json";

  if (headers === undefined) {
    return snapshot;
  }

  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("headers must be an object of string values when provided");
  }

  const entries = objectEntries(headers, "headers");
  if (entries.length > MAX_RAY_CLIENT_HEADERS) {
    throw new RangeError(`headers must contain at most ${MAX_RAY_CLIENT_HEADERS} entries`);
  }

  for (const [name, value] of entries) {
    const normalizedName = name.toLowerCase();

    if (unsafeHeaderNames.has(normalizedName)) {
      throw new TypeError(`headers names must not contain unsafe key "${name}"`);
    }

    assertHeaderName(name);
    if (reservedClientHeaderNames.has(normalizedName)) {
      throw new TypeError(`headers must not override reserved HTTP header "${name}"`);
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, normalizedName)) {
      throw new TypeError(`headers must not contain duplicate HTTP header "${name}"`);
    }

    if (typeof value !== "string") {
      throw new TypeError("headers values must be bounded strings without control characters");
    }

    assertHeaderValue(value);
    snapshot[normalizedName] = value;
  }

  return snapshot;
}

function assertApiKey(apiKey: string): void {
  if (
    typeof apiKey !== "string" ||
    apiKey.length === 0 ||
    apiKey.length > MAX_RAY_CLIENT_API_KEY_CHARS ||
    /[\0-\x20\x7f]|\s/u.test(apiKey)
  ) {
    throw new TypeError(
      "apiKey must be a bounded bearer token string without whitespace or control characters",
    );
  }
}

function assertJobId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > MAX_JOB_ID_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`jobId must be 1-${MAX_JOB_ID_CHARS} characters of A-Z, a-z, 0-9, _ or -`);
  }
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const buffer = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

function getDeclaredContentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");

  if (!header) {
    return undefined;
  }

  const normalized = header.trim();
  const parsed = Number(normalized);

  return /^\d+$/.test(normalized) && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const [type, subtype, extra] = mediaType.split("/");

  return (
    type === "application" &&
    extra === undefined &&
    subtype !== undefined &&
    (subtype === "json" || subtype.endsWith("+json"))
  );
}

function stringifyRequestBody(value: unknown, limitBytes: number): string {
  let body: string;

  try {
    body = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `Ray request body must be JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (body === undefined) {
    throw new TypeError("Ray request body must be JSON serializable");
  }

  const bodyBytes = encodeText(body).byteLength;

  if (bodyBytes > limitBytes) {
    throw new RangeError(`Ray request body exceeded ${limitBytes} bytes`);
  }

  return body;
}

async function readResponseTextLimited(
  response: Response,
  limitBytes: number,
): Promise<LimitedResponseBody> {
  const declaredContentLength = getDeclaredContentLength(response);

  if (declaredContentLength !== undefined && declaredContentLength > limitBytes) {
    await response.body?.cancel().catch(() => undefined);

    return {
      text: "",
      truncated: true,
      bytesRead: 0,
      limitBytes,
      declaredContentLength,
    };
  }

  if (!response.body) {
    const text = await response.text();
    const bytes = encodeText(text);
    const truncated = bytes.byteLength > limitBytes;

    return {
      text: truncated ? decodeBytes(bytes.subarray(0, limitBytes)) : text,
      truncated,
      bytesRead: truncated ? limitBytes : bytes.byteLength,
      limitBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (bytesRead >= limitBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }

      const chunk = value;
      const remaining = limitBytes - bytesRead;

      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytesRead = limitBytes;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(chunk);
      bytesRead += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: decodeBytes(concatBytes(chunks, bytesRead)),
    truncated,
    bytesRead,
    limitBytes,
  };
}

function assertJsonResponseContentType(response: Response, pathname: string): void {
  const contentType = response.headers.get("content-type") ?? "";

  if (isJsonContentType(contentType)) {
    return;
  }

  throw new Error(
    `Ray response for ${pathname} must use application/json or application/*+json content type (received ${contentType || "missing"})`,
  );
}

function parseJsonResponse<T>(text: string, pathname: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Ray response for ${pathname} must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function redactJsonErrorStacks(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactJsonErrorStacks(entry, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase() === "stack") {
        continue;
      }

      output[key] = redactJsonErrorStacks(nested, seen);
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function formatErrorResponseText(response: Response, body: LimitedResponseBody): string {
  if (!body.text || !isJsonContentType(response.headers.get("content-type") ?? "")) {
    return body.text;
  }

  try {
    return JSON.stringify(redactJsonErrorStacks(JSON.parse(body.text))) ?? "null";
  } catch {
    return body.text;
  }
}

export class RayClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly requestBodyLimitBytes: number;
  private readonly responseBodyLimitBytes: number;

  constructor(options: RayClientOptions) {
    assertClientOptions(options);

    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RAY_CLIENT_TIMEOUT_MS;
    this.requestBodyLimitBytes =
      options.requestBodyLimitBytes ?? DEFAULT_RAY_CLIENT_REQUEST_BODY_LIMIT_BYTES;
    this.responseBodyLimitBytes =
      options.responseBodyLimitBytes ?? DEFAULT_RAY_CLIENT_RESPONSE_BODY_LIMIT_BYTES;
    assertPositiveSafeIntegerAtMost(this.timeoutMs, "timeoutMs", MAX_RAY_CLIENT_TIMEOUT_MS);
    assertPositiveSafeIntegerAtMost(
      this.requestBodyLimitBytes,
      "requestBodyLimitBytes",
      MAX_RAY_CLIENT_REQUEST_BODY_LIMIT_BYTES,
    );
    assertPositiveSafeIntegerAtMost(
      this.responseBodyLimitBytes,
      "responseBodyLimitBytes",
      MAX_RAY_CLIENT_RESPONSE_BODY_LIMIT_BYTES,
    );
    this.headers = snapshotHeaders(options.headers);

    if (options.apiKey !== undefined) {
      assertApiKey(options.apiKey);
      this.headers.authorization = `Bearer ${options.apiKey}`;
    }
  }

  infer(request: InferenceRequest): Promise<InferenceResponse> {
    return this.request<InferenceResponse>("/v1/infer", {
      method: "POST",
      body: stringifyRequestBody(request, this.requestBodyLimitBytes),
    });
  }

  createJob(request: CreateInferenceJobRequest): Promise<InferenceJobAcceptedResponse> {
    return this.request<InferenceJobAcceptedResponse>("/v1/jobs", {
      method: "POST",
      body: stringifyRequestBody(request, this.requestBodyLimitBytes),
    });
  }

  job(jobId: string): Promise<InferenceJobRecord> {
    assertJobId(jobId);
    return this.request<InferenceJobRecord>(`/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  health(): Promise<HealthSnapshot> {
    return this.request<HealthSnapshot>("/health");
  }

  readyz(): Promise<ReadinessSnapshot> {
    return this.request<ReadinessSnapshot>("/readyz");
  }

  metrics(): Promise<RuntimeMetricsSnapshot> {
    return this.request<RuntimeMetricsSnapshot>("/metrics");
  }

  config(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/config");
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Ray request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        redirect: "manual",
        headers: {
          ...this.headers,
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });

      const body = await readResponseTextLimited(response, this.responseBodyLimitBytes);

      if (!response.ok) {
        const truncated = body.truncated
          ? body.declaredContentLength !== undefined
            ? ` (response body declared ${body.declaredContentLength} bytes, limit ${body.limitBytes} bytes)`
            : ` (response body truncated at ${body.limitBytes} bytes)`
          : "";
        throw new Error(
          `Ray request failed with ${response.status}: ${formatErrorResponseText(
            response,
            body,
          )}${truncated}`,
        );
      }

      if (body.truncated) {
        throw new Error(`Ray response exceeded ${body.limitBytes} bytes`);
      }

      assertJsonResponseContentType(response, pathname);
      return parseJsonResponse<T>(body.text, pathname);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error
          ? reason
          : new Error(`Ray request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
