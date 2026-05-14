import {
  RayError,
  toErrorMessage,
  type LlamaCppProviderConfig,
  type OpenAICompatibleProviderConfig,
  type PromptTemplateVariableValue,
  type WarmupInferenceRequest,
} from "@razroo/ray-core";

interface OpenAICompatibleResponse {
  choices?: Array<{
    text?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

export interface OpenAICompatibleTokenUsage {
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

type HttpAdapterConfig = Pick<
  OpenAICompatibleProviderConfig | LlamaCppProviderConfig,
  "baseUrl" | "timeoutMs" | "headers" | "apiKeyEnv"
>;

export const BACKEND_ERROR_BODY_LIMIT_BYTES = 4_096;
export const BACKEND_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
export const BACKEND_RESPONSE_BODY_LIMIT_BYTES = 1_048_576;
export const MAX_ADAPTER_TIMEOUT_MS = 120_000;
export const MAX_ADAPTER_MODEL_REF_CHARS = 256;

const MAX_ADAPTER_URL_CHARS = 2_048;
const MAX_ADAPTER_PATHNAME_CHARS = 2_048;
const MAX_ADAPTER_HEADERS = 64;
const MAX_ADAPTER_HEADER_KEY_CHARS = 128;
const MAX_ADAPTER_HEADER_VALUE_CHARS = 4_096;
const MAX_ADAPTER_API_KEY_CHARS = 1_024;
const MAX_ADAPTER_ENV_NAME_CHARS = 128;
const MAX_ADAPTER_WARMUP_REQUESTS = 8;
const MAX_ADAPTER_WARMUP_TEXT_CHARS = 8_192;
const MAX_ADAPTER_WARMUP_STOP_SEQUENCES = 16;
const MAX_ADAPTER_WARMUP_STOP_SEQUENCE_CHARS = 256;
const MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLES = 32;
const MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLE_KEY_CHARS = 128;
const MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLE_VALUE_CHARS = 16_384;
const MAX_OPENAI_COMPATIBLE_TOKEN_USAGE = 1_000_000_000;
const MAX_ASSISTANT_CONTENT_PARTS = 512;
const MIN_ASSISTANT_TEXT_CHARS = 8_192;
const MAX_ASSISTANT_TEXT_CHARS = 262_144;
const MAX_ASSISTANT_TEXT_CHARS_PER_TOKEN = 64;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const unsafeAdapterRecordKeys = new Set(["__proto__", "constructor", "prototype"]);
const reservedAdapterHeaderNames = new Set([
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
  body: string;
  truncated: boolean;
  bytesRead: number;
  limitBytes: number;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function isNonNegativeSafeInteger(
  value: unknown,
  maximum = MAX_OPENAI_COMPATIBLE_TOKEN_USAGE,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function normalizeOpenAICompatibleTokenUsage(
  payload: OpenAICompatibleResponse,
  fallbackPromptTokens?: number,
): OpenAICompatibleTokenUsage | undefined {
  const usage = payload.usage;
  const prompt = isNonNegativeSafeInteger(usage?.prompt_tokens)
    ? usage.prompt_tokens
    : isNonNegativeSafeInteger(fallbackPromptTokens)
      ? fallbackPromptTokens
      : undefined;
  const completion = isNonNegativeSafeInteger(usage?.completion_tokens)
    ? usage.completion_tokens
    : undefined;
  const total = isNonNegativeSafeInteger(usage?.total_tokens) ? usage.total_tokens : undefined;

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }

  const normalizedPrompt = prompt ?? 0;
  const normalizedCompletion = completion ?? 0;
  const computedTotal = normalizedPrompt + normalizedCompletion;
  if (computedTotal > MAX_OPENAI_COMPATIBLE_TOKEN_USAGE) {
    return undefined;
  }
  const normalizedTotal = total !== undefined && total >= computedTotal ? total : computedTotal;

  return {
    tokens: {
      prompt: normalizedPrompt,
      completion: normalizedCompletion,
      total: normalizedTotal,
    },
  };
}

function extractAssistantContentPartText(part: unknown): string {
  if (part === null || typeof part !== "object") {
    return "";
  }

  try {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export function resolveAssistantTextLimit(maxTokens: number): number {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError("assistant maxTokens must be a positive safe integer");
  }

  return Math.min(
    MAX_ASSISTANT_TEXT_CHARS,
    Math.max(MIN_ASSISTANT_TEXT_CHARS, maxTokens * MAX_ASSISTANT_TEXT_CHARS_PER_TOKEN),
  );
}

function assertAssistantTextWithinLimit(text: string, maxChars: number | undefined): void {
  if (maxChars === undefined || text.length <= maxChars) {
    return;
  }

  throw new RayError("The backend returned assistant text above the configured size limit", {
    code: "provider_invalid_response",
    status: 502,
    details: {
      maxChars,
      actualChars: text.length,
    },
  });
}

function assertStringLength(value: string, label: string, maximum: number): void {
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters`);
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertSafeRecordKey(key: string, label: string): void {
  if (unsafeAdapterRecordKeys.has(key)) {
    throw new TypeError(`${label} must not contain unsafe key "${key}"`);
  }
}

export function assertNonEmptyStringAtMost(value: string, label: string, maximum: number): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  assertStringLength(value, label, maximum);
}

export function assertPositiveSafeIntegerAtMost(
  value: number,
  label: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertOptionalString(value: string | undefined, label: string, maximum: number): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string when provided`);
  }

  assertStringLength(value, label, maximum);
}

function assertOptionalEnvironmentVariableName(value: string | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  assertOptionalString(value, label, MAX_ADAPTER_ENV_NAME_CHARS);

  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(value) || unsafeAdapterRecordKeys.has(value)) {
    throw new TypeError(`${label} must be a valid environment variable name`);
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

function assertHttpBaseUrl(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  assertStringLength(value, label, MAX_ADAPTER_URL_CHARS);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP or HTTPS URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use the http or https scheme`);
  }

  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not include credentials`);
  }

  if (parsed.search || parsed.hash) {
    throw new TypeError(`${label} must not include a query string or fragment`);
  }
}

function assertAdapterPathname(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\0-\x20\x7f]/.test(value)
  ) {
    throw new TypeError(
      "adapter.pathname must be an absolute path starting with / and contain no control characters",
    );
  }

  if (value.length > MAX_ADAPTER_PATHNAME_CHARS) {
    throw new RangeError(
      `adapter.pathname must be at most ${MAX_ADAPTER_PATHNAME_CHARS} characters`,
    );
  }
}

function assertHeaderRecord(value: Record<string, string> | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object of string values`);
  }

  const entries = objectEntries(value, label);

  if (entries.length > MAX_ADAPTER_HEADERS) {
    throw new RangeError(`${label} must contain at most ${MAX_ADAPTER_HEADERS} entries`);
  }

  const seenHeaderNames = new Set<string>();
  for (const [key, entry] of entries) {
    assertSafeRecordKey(key, label);

    if (typeof entry !== "string") {
      throw new TypeError(`${label} must be an object of string values`);
    }

    if (
      key.length === 0 ||
      key.length > MAX_ADAPTER_HEADER_KEY_CHARS ||
      !HTTP_HEADER_NAME_PATTERN.test(key)
    ) {
      throw new TypeError(`${label} names must be valid bounded HTTP token strings`);
    }

    const normalizedKey = key.toLowerCase();
    if (seenHeaderNames.has(normalizedKey)) {
      throw new TypeError(`${label} must not contain duplicate header name "${key}"`);
    }
    seenHeaderNames.add(normalizedKey);

    if (reservedAdapterHeaderNames.has(normalizedKey)) {
      throw new TypeError(`${label}.${key} must not use a transport-controlled header name`);
    }

    if (/[\0\r\n]/.test(entry)) {
      throw new TypeError(`${label}.${key} must not contain NUL, CR, or LF characters`);
    }

    assertStringLength(key, `${label} keys`, MAX_ADAPTER_HEADER_KEY_CHARS);
    assertStringLength(entry, `${label}.${key}`, MAX_ADAPTER_HEADER_VALUE_CHARS);
  }
}

function normalizeHeaderInit(value: RequestInit["headers"], label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const headers: Record<string, string> = {};

    for (const [key, entry] of value.entries()) {
      headers[key] = entry;
    }

    assertHeaderRecord(headers, label);
    return headers;
  }

  if (Array.isArray(value)) {
    const headers: Record<string, string> = {};
    const seen = new Set<string>();

    if (value.length > MAX_ADAPTER_HEADERS) {
      throw new RangeError(`${label} must contain at most ${MAX_ADAPTER_HEADERS} entries`);
    }

    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError(`${label} must be an object or array of string header pairs`);
      }

      const [key, headerValue] = entry;

      if (typeof key !== "string" || typeof headerValue !== "string") {
        throw new TypeError(`${label} must be an object or array of string header pairs`);
      }

      const normalizedKey = key.toLowerCase();
      if (seen.has(normalizedKey)) {
        throw new TypeError(`${label} must not contain duplicate header name "${key}"`);
      }

      seen.add(normalizedKey);
      headers[key] = headerValue;
    }

    assertHeaderRecord(headers, label);
    return headers;
  }

  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object or array of string header pairs`);
  }

  assertHeaderRecord(value as Record<string, string>, label);
  return { ...(value as Record<string, string>) };
}

function assertAdapterApiKey(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ADAPTER_API_KEY_CHARS ||
    /\s|[\0\r\n]/.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded bearer token string without whitespace`);
  }
}

function assertStopSequences(value: string[] | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of strings`);
  }

  if (value.length > MAX_ADAPTER_WARMUP_STOP_SEQUENCES) {
    throw new RangeError(
      `${label} must contain at most ${MAX_ADAPTER_WARMUP_STOP_SEQUENCES} entries`,
    );
  }

  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }

    assertStringLength(entry, `${label} entries`, MAX_ADAPTER_WARMUP_STOP_SEQUENCE_CHARS);
  }
}

function assertTemplateVariables(
  value: Record<string, PromptTemplateVariableValue> | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object of template variable values`);
  }

  const entries = objectEntries(value, label);

  if (entries.length > MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLES) {
    throw new RangeError(
      `${label} must contain at most ${MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLES} entries`,
    );
  }

  for (const [key, entry] of entries) {
    assertSafeRecordKey(key, label);

    assertNonEmptyStringAtMost(
      key,
      `${label} keys`,
      MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLE_KEY_CHARS,
    );

    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new TypeError(`${label}.${key} must be a string, number, or boolean`);
    }

    assertStringLength(
      String(entry),
      `${label}.${key}`,
      MAX_ADAPTER_WARMUP_TEMPLATE_VARIABLE_VALUE_CHARS,
    );
  }
}

function assertResponseFormat(
  value: WarmupInferenceRequest["responseFormat"] | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }

  if (
    value === null ||
    typeof value !== "object" ||
    (value.type !== "text" && value.type !== "json_object")
  ) {
    throw new TypeError(`${label}.type must be 'text' or 'json_object'`);
  }
}

function assertWarmupRequest(
  request: WarmupInferenceRequest,
  label: string,
  maxOutputTokens: number,
): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError(`${label} must be an object`);
  }

  for (const [key] of objectEntries(request, label)) {
    assertSafeRecordKey(key, label);
  }

  if (typeof request.templateId === "string" && request.templateId.trim().length > 0) {
    assertNonEmptyStringAtMost(
      request.templateId,
      `${label}.templateId`,
      MAX_ADAPTER_HEADER_KEY_CHARS,
    );

    if (request.input !== undefined) {
      throw new TypeError(`${label}.input must be omitted when templateId is provided`);
    }

    assertTemplateVariables(request.templateVariables, `${label}.templateVariables`);
  } else {
    assertNonEmptyStringAtMost(
      request.input ?? "",
      `${label}.input`,
      MAX_ADAPTER_WARMUP_TEXT_CHARS,
    );
  }

  if (request.system !== undefined) {
    assertNonEmptyStringAtMost(request.system, `${label}.system`, MAX_ADAPTER_WARMUP_TEXT_CHARS);
  }

  if (request.maxTokens !== undefined) {
    assertPositiveSafeIntegerAtMost(request.maxTokens, `${label}.maxTokens`, maxOutputTokens);
  }

  if (request.seed !== undefined) {
    assertSafeInteger(request.seed, `${label}.seed`);
  }

  assertStopSequences(request.stop, `${label}.stop`);
  assertResponseFormat(request.responseFormat, `${label}.responseFormat`);
}

export function snapshotAdapterWarmupRequests(
  requests: WarmupInferenceRequest[] | undefined,
  maxOutputTokens: number,
): WarmupInferenceRequest[] | undefined {
  if (requests === undefined) {
    return undefined;
  }

  if (!Array.isArray(requests)) {
    throw new TypeError("adapter.warmupRequests must be an array when provided");
  }

  if (requests.length > MAX_ADAPTER_WARMUP_REQUESTS) {
    throw new RangeError(
      `adapter.warmupRequests must contain at most ${MAX_ADAPTER_WARMUP_REQUESTS} entries`,
    );
  }

  return requests.map((request, index) => {
    assertWarmupRequest(request, `adapter.warmupRequests[${index}]`, maxOutputTokens);

    return {
      ...request,
      ...(request.stop ? { stop: [...request.stop] } : {}),
      ...(request.responseFormat ? { responseFormat: { ...request.responseFormat } } : {}),
      ...(request.templateVariables ? { templateVariables: { ...request.templateVariables } } : {}),
    };
  });
}

export function assertHttpAdapterConfig(adapter: HttpAdapterConfig): void {
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("adapter must be an object");
  }

  for (const [key] of objectEntries(adapter, "adapter")) {
    assertSafeRecordKey(key, "adapter");
  }

  assertHttpBaseUrl(adapter.baseUrl, "adapter.baseUrl");
  assertPositiveSafeIntegerAtMost(adapter.timeoutMs, "adapter.timeoutMs", MAX_ADAPTER_TIMEOUT_MS);
  assertOptionalEnvironmentVariableName(adapter.apiKeyEnv, "adapter.apiKeyEnv");
  assertHeaderRecord(adapter.headers, "adapter.headers");
}

export function snapshotHttpAdapterConfig<T extends HttpAdapterConfig>(adapter: T): T {
  assertHttpAdapterConfig(adapter);

  return {
    ...adapter,
    ...(adapter.headers ? { headers: { ...adapter.headers } } : {}),
  };
}

export function buildAdapterHeaders(adapter: HttpAdapterConfig): Record<string, string> {
  assertHttpAdapterConfig(adapter);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(adapter.headers ?? {}),
  };

  if (adapter.apiKeyEnv) {
    const apiKey = process.env[adapter.apiKeyEnv];
    if (apiKey !== undefined) {
      assertAdapterApiKey(apiKey, adapter.apiKeyEnv);
      headers.authorization = `Bearer ${apiKey}`;
    }
  }

  return headers;
}

export async function readResponseBodyLimited(
  response: Response,
  limitBytes: number,
): Promise<LimitedResponseBody> {
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.from(text);
    const truncated = bytes.byteLength > limitBytes;
    const body = truncated ? bytes.subarray(0, limitBytes).toString("utf8") : text;

    return {
      body,
      truncated,
      bytesRead: truncated ? limitBytes : bytes.byteLength,
      limitBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
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

      const chunk = Buffer.from(value);
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
    body: Buffer.concat(chunks, bytesRead).toString("utf8"),
    truncated,
    bytesRead,
    limitBytes,
  };
}

export function assertResponseBodyWithinLimit(
  body: LimitedResponseBody,
  contentType: string,
): void {
  if (!body.truncated) {
    return;
  }

  throw new RayError("The backend response body exceeded the configured size limit", {
    code: "provider_response_too_large",
    status: 502,
    details: {
      contentType,
      bytesRead: body.bytesRead,
      limitBytes: body.limitBytes,
    },
  });
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

function getRequestBodyLength(body: RequestInit["body"]): number | undefined {
  if (body === undefined || body === null) {
    return 0;
  }

  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }

  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString(), "utf8");
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.size;
  }

  return undefined;
}

function describeRequestBody(body: RequestInit["body"]): string {
  if (body === undefined || body === null) {
    return "empty";
  }

  if (typeof body === "string") {
    return "string";
  }

  if (body instanceof ArrayBuffer) {
    return "ArrayBuffer";
  }

  if (ArrayBuffer.isView(body)) {
    return body.constructor.name;
  }

  if (body instanceof URLSearchParams) {
    return "URLSearchParams";
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return "Blob";
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "FormData";
  }

  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return "ReadableStream";
  }

  return typeof body;
}

export function assertRequestBodyWithinLimit(
  init: RequestInit,
  limitBytes = BACKEND_REQUEST_BODY_LIMIT_BYTES,
): void {
  const bodyLength = getRequestBodyLength(init.body);

  if (bodyLength === undefined) {
    throw new RayError("The backend request body must have a known byte length", {
      code: "provider_request_body_unbounded",
      status: 413,
      details: {
        bodyType: describeRequestBody(init.body),
        limitBytes,
      },
    });
  }

  if (bodyLength <= limitBytes) {
    return;
  }

  throw new RayError("The backend request body exceeded the configured size limit", {
    code: "provider_request_too_large",
    status: 413,
    details: {
      bodyBytes: bodyLength,
      limitBytes,
    },
  });
}

export async function assertDeclaredResponseBodyWithinLimit(
  response: Response,
  limitBytes: number,
  contentType: string,
): Promise<void> {
  const declaredContentLength = getDeclaredContentLength(response);

  if (declaredContentLength === undefined || declaredContentLength <= limitBytes) {
    return;
  }

  await response.body?.cancel().catch(() => undefined);

  throw new RayError("The backend response body exceeded the configured size limit", {
    code: "provider_response_too_large",
    status: 502,
    details: {
      contentType,
      bytesRead: 0,
      limitBytes,
      declaredContentLength,
    },
  });
}

function parseBackendJsonResponse(body: string, contentType: string, pathname: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new RayError("The backend returned invalid JSON", {
      code: "provider_invalid_response",
      status: 502,
      details: {
        pathname,
        contentType,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        error: toErrorMessage(error),
      },
    });
  }
}

function redactJsonStackFields(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactJsonStackFields(entry, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.toLowerCase() === "stack") {
        continue;
      }

      output[key] = redactJsonStackFields(nested, seen);
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function formatBackendErrorBody(body: string, contentType: string): string {
  if (!body || !isJsonContentType(contentType)) {
    return body;
  }

  try {
    return JSON.stringify(redactJsonStackFields(JSON.parse(body))) ?? "null";
  } catch {
    return body;
  }
}

export async function adapterRequest(
  adapter: HttpAdapterConfig,
  pathname: string,
  init: RequestInit,
  timeoutMs = adapter.timeoutMs,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  assertHttpAdapterConfig(adapter);
  assertAdapterPathname(pathname);
  assertPositiveSafeIntegerAtMost(timeoutMs, "adapter.timeoutMs", MAX_ADAPTER_TIMEOUT_MS);
  assertRequestBodyWithinLimit(init);
  const requestHeaders = normalizeHeaderInit(init.headers, "adapter.request.headers");

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new RayError(`The backend did not respond within ${timeoutMs}ms`, {
        code: "provider_timeout",
        status: 504,
        details: {
          pathname,
          timeoutMs,
        },
      }),
    );
  }, timeoutMs);

  const abortFromParent = () => {
    controller.abort(
      parentSignal?.reason instanceof RayError
        ? parentSignal.reason
        : new RayError("The inference request was aborted before the backend replied", {
            code: "request_aborted",
            status: 504,
            details: {
              pathname,
              reason: parentSignal?.reason,
            },
          }),
    );
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(adapter.baseUrl)}${pathname}`, {
      ...init,
      headers: {
        ...buildAdapterHeaders(adapter),
        ...requestHeaders,
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = await readResponseBodyLimited(response, BACKEND_ERROR_BODY_LIMIT_BYTES);
      throw new RayError(`The backend rejected the request with ${response.status}`, {
        code: "provider_upstream_error",
        status: 502,
        details: {
          ...body,
          body: formatBackendErrorBody(body.body, contentType),
          contentType,
          pathname,
          upstreamStatus: response.status,
        },
      });
    }

    if (response.status === 204) {
      return undefined;
    }

    const contentType = response.headers.get("content-type") ?? "";
    await assertDeclaredResponseBodyWithinLimit(
      response,
      BACKEND_RESPONSE_BODY_LIMIT_BYTES,
      contentType,
    );
    const body = await readResponseBodyLimited(response, BACKEND_RESPONSE_BODY_LIMIT_BYTES);
    assertResponseBodyWithinLimit(body, contentType);

    if (isJsonContentType(contentType)) {
      return parseBackendJsonResponse(body.body, contentType, pathname);
    }

    return body.body;
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof RayError) {
        throw reason;
      }
    }

    if (error instanceof RayError) {
      throw error;
    }

    throw new RayError(`The backend request failed: ${toErrorMessage(error)}`, {
      code: "provider_request_failed",
      status: 502,
      details: {
        pathname,
        error,
      },
    });
  } finally {
    clearTimeout(timeout);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }
}

export function extractAssistantText(
  payload: OpenAICompatibleResponse,
  options: { maxChars?: number } = {},
): string {
  const choice = payload.choices?.[0];

  if (!choice) {
    throw new RayError("The backend returned no choices", {
      code: "provider_invalid_response",
      status: 502,
    });
  }

  if (typeof choice.text === "string" && choice.text.length > 0) {
    assertAssistantTextWithinLimit(choice.text, options.maxChars);
    return choice.text;
  }

  const content = choice.message?.content;

  if (typeof content === "string" && content.length > 0) {
    assertAssistantTextWithinLimit(content, options.maxChars);
    return content;
  }

  if (Array.isArray(content)) {
    if (content.length > MAX_ASSISTANT_CONTENT_PARTS) {
      throw new RayError("The backend returned too many assistant content parts", {
        code: "provider_invalid_response",
        status: 502,
        details: {
          maxParts: MAX_ASSISTANT_CONTENT_PARTS,
          actualParts: content.length,
        },
      });
    }

    let text = "";

    for (const part of content) {
      text += extractAssistantContentPartText(part);
    }

    text = text.trim();

    if (text.length > 0) {
      assertAssistantTextWithinLimit(text, options.maxChars);
      return text;
    }
  }

  throw new RayError("The backend returned an empty response body", {
    code: "provider_invalid_response",
    status: 502,
  });
}
