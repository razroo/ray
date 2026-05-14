import {
  RayError,
  hashValue,
  type PromptTemplateVariables,
  type ResponseFormatType,
} from "@razroo/ray-core";

interface CacheEntry {
  value: PromptScaffold;
  expiresAt: number;
  sizeBytes: number;
}

export interface PromptScaffold {
  segments: string[];
  variableOrder: string[];
  templateId?: string;
  templateVersion?: string;
  family?: string;
}

export interface PromptScaffoldCacheKeyOptions {
  modelRef: string;
  templateId: string;
  responseFormatType?: ResponseFormatType;
  promptFormat?: string;
}

export interface CreatePromptScaffoldOptions {
  prompt: string;
  variableOrder: readonly string[];
  sentinelVariables: Record<string, string>;
  templateId?: string;
  templateVersion?: string;
  family?: string;
}

export interface PromptScaffoldCacheOptions {
  maxEntries: number;
  ttlMs: number;
  maxBytes?: number;
}

export interface PromptScaffoldCacheSnapshot {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  evictions: number;
  expirations: number;
  droppedOversizedEntries: number;
  hits: number;
  misses: number;
}

const MAX_PROMPT_SCAFFOLD_ENTRIES = 4_096;
const MAX_PROMPT_SCAFFOLD_TTL_MS = 86_400_000;
const MAX_PROMPT_SCAFFOLD_BYTES = 32 * 1024 * 1024;
const DEFAULT_PROMPT_SCAFFOLD_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_SCAFFOLD_FIELD_CHARS = 4_096;
const MAX_PROMPT_SCAFFOLD_PROMPT_CHARS = 262_144;
const MAX_PROMPT_SCAFFOLD_VARIABLES = 64;
const unsafePromptCacheKeys = new Set(["__proto__", "constructor", "prototype"]);
const promptScaffoldCacheOptionKeys = new Set(["maxEntries", "ttlMs", "maxBytes"]);
const promptScaffoldCacheKeyOptionKeys = new Set([
  "modelRef",
  "templateId",
  "responseFormatType",
  "promptFormat",
]);

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownObjectKeys(value: object, label: string, allowedKeys: ReadonlySet<string>) {
  for (const [key] of objectEntries(value, label)) {
    if (unsafePromptCacheKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsafe key "${key}"`);
    }

    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsupported key "${key}"`);
    }
  }
}

function assertCacheKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("prompt scaffold cache key must be a non-empty string");
  }

  if (value.length > MAX_PROMPT_SCAFFOLD_FIELD_CHARS) {
    throw new RangeError(
      `prompt scaffold cache key must be at most ${MAX_PROMPT_SCAFFOLD_FIELD_CHARS} characters`,
    );
  }
}

function assertPositiveSafeIntegerAtMost(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }

  return value;
}

function assertBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new RangeError(`${label} must be at most ${maxChars} characters`);
  }

  return value;
}

function assertResponseFormatType(value: unknown): ResponseFormatType {
  if (value === undefined) {
    return "text";
  }

  if (value !== "text" && value !== "json_object") {
    throw new TypeError("responseFormatType must be text or json_object");
  }

  return value;
}

function assertVariableOrder(value: readonly string[]): void {
  if (!Array.isArray(value)) {
    throw new TypeError("variableOrder must be an array");
  }

  if (value.length > MAX_PROMPT_SCAFFOLD_VARIABLES) {
    throw new RangeError(
      `variableOrder must contain at most ${MAX_PROMPT_SCAFFOLD_VARIABLES} entries`,
    );
  }

  for (const [index, variable] of value.entries()) {
    assertBoundedString(variable, `variableOrder[${index}]`, MAX_PROMPT_SCAFFOLD_FIELD_CHARS);
  }
}

function cloneScaffold(scaffold: PromptScaffold): PromptScaffold {
  return {
    segments: [...scaffold.segments],
    variableOrder: [...scaffold.variableOrder],
    ...(scaffold.templateId ? { templateId: scaffold.templateId } : {}),
    ...(scaffold.templateVersion ? { templateVersion: scaffold.templateVersion } : {}),
    ...(scaffold.family ? { family: scaffold.family } : {}),
  };
}

function estimatePromptScaffoldBytes(scaffold: PromptScaffold, key: string): number {
  let bytes = Buffer.byteLength(key, "utf8");
  for (const segment of scaffold.segments) {
    bytes += Buffer.byteLength(segment, "utf8");
  }
  for (const variable of scaffold.variableOrder) {
    bytes += Buffer.byteLength(variable, "utf8");
  }
  bytes += Buffer.byteLength(scaffold.templateId ?? "", "utf8");
  bytes += Buffer.byteLength(scaffold.templateVersion ?? "", "utf8");
  bytes += Buffer.byteLength(scaffold.family ?? "", "utf8");
  return bytes;
}

export function buildPromptScaffoldCacheKey(options: PromptScaffoldCacheKeyOptions): string {
  assertRecord(options, "prompt scaffold cache key options");
  assertKnownObjectKeys(
    options,
    "prompt scaffold cache key options",
    promptScaffoldCacheKeyOptionKeys,
  );

  return hashValue({
    modelRef: assertBoundedString(
      options.modelRef,
      "prompt scaffold cache key modelRef",
      MAX_PROMPT_SCAFFOLD_FIELD_CHARS,
    ),
    templateId: assertBoundedString(
      options.templateId,
      "prompt scaffold cache key templateId",
      MAX_PROMPT_SCAFFOLD_FIELD_CHARS,
    ),
    responseFormatType: assertResponseFormatType(options.responseFormatType),
    promptFormat:
      options.promptFormat === undefined
        ? "llama.cpp-template"
        : assertBoundedString(
            options.promptFormat,
            "prompt scaffold cache key promptFormat",
            MAX_PROMPT_SCAFFOLD_FIELD_CHARS,
          ),
  });
}

export function createSentinelTemplateVariables(
  variableOrder: readonly string[],
): Record<string, string> {
  assertVariableOrder(variableOrder);
  return Object.fromEntries(
    variableOrder.map((variable, index) => [variable, `__RAY_PROMPT_VAR_${index}__`]),
  );
}

export function createPromptScaffold(options: CreatePromptScaffoldOptions): PromptScaffold {
  assertRecord(options, "prompt scaffold options");
  const prompt = assertBoundedString(
    options.prompt,
    "prompt scaffold prompt",
    MAX_PROMPT_SCAFFOLD_PROMPT_CHARS,
  );
  assertVariableOrder(options.variableOrder);
  assertRecord(options.sentinelVariables, "prompt scaffold sentinelVariables");

  const segments: string[] = [];
  let cursor = 0;

  for (const variable of options.variableOrder) {
    const sentinel = options.sentinelVariables[variable];
    if (typeof sentinel !== "string" || sentinel.length === 0) {
      throw new RayError(`Prompt scaffold marker "${variable}" is missing`, {
        code: "provider_invalid_response",
        status: 500,
      });
    }

    const position = prompt.indexOf(sentinel, cursor);
    if (position === -1) {
      throw new RayError(`Prompt scaffold marker "${variable}" was not found in rendered prompt`, {
        code: "provider_invalid_response",
        status: 500,
      });
    }

    segments.push(prompt.slice(cursor, position));
    cursor = position + sentinel.length;
  }

  segments.push(prompt.slice(cursor));
  return {
    segments,
    variableOrder: [...options.variableOrder],
    ...(options.templateId ? { templateId: options.templateId } : {}),
    ...(options.templateVersion ? { templateVersion: options.templateVersion } : {}),
    ...(options.family ? { family: options.family } : {}),
  };
}

export function renderPromptFromScaffold(
  scaffold: PromptScaffold,
  templateVariables: Record<string, string>,
): string {
  assertRecord(scaffold, "prompt scaffold");
  assertVariableOrder(scaffold.variableOrder);
  assertRecord(templateVariables, "prompt scaffold templateVariables");

  let prompt = scaffold.segments[0] ?? "";
  for (let index = 0; index < scaffold.variableOrder.length; index += 1) {
    const variableName = scaffold.variableOrder[index];
    if (!variableName) {
      continue;
    }

    const value = templateVariables[variableName];
    if (value === undefined) {
      throw new RayError(`Missing template variable "${variableName}" for prompt scaffold`, {
        code: "invalid_request",
        status: 400,
      });
    }

    prompt += value;
    prompt += scaffold.segments[index + 1] ?? "";
  }

  return prompt;
}

export class PromptScaffoldCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private droppedOversizedEntries = 0;

  constructor(options: PromptScaffoldCacheOptions) {
    assertRecord(options, "prompt scaffold cache options");
    assertKnownObjectKeys(options, "prompt scaffold cache options", promptScaffoldCacheOptionKeys);

    this.maxEntries = assertPositiveSafeIntegerAtMost(
      options.maxEntries,
      "prompt scaffold cache maxEntries",
      MAX_PROMPT_SCAFFOLD_ENTRIES,
    );
    this.ttlMs = assertPositiveSafeIntegerAtMost(
      options.ttlMs,
      "prompt scaffold cache ttlMs",
      MAX_PROMPT_SCAFFOLD_TTL_MS,
    );
    this.maxBytes =
      options.maxBytes === undefined
        ? DEFAULT_PROMPT_SCAFFOLD_BYTES
        : assertPositiveSafeIntegerAtMost(
            options.maxBytes,
            "prompt scaffold cache maxBytes",
            MAX_PROMPT_SCAFFOLD_BYTES,
          );
  }

  get(key: string): PromptScaffold | undefined {
    assertCacheKey(key);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.deleteEntry(key, "expired");
      this.misses += 1;
      return undefined;
    }

    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return cloneScaffold(entry.value);
  }

  set(key: string, scaffold: PromptScaffold): void {
    assertCacheKey(key);
    this.purgeExpired();

    const value = cloneScaffold(scaffold);
    const sizeBytes = estimatePromptScaffoldBytes(value, key);
    if (sizeBytes > this.maxBytes) {
      this.droppedOversizedEntries += 1;
      return;
    }

    if (this.store.has(key)) {
      this.deleteEntry(key);
    }

    while (this.store.size >= this.maxEntries || this.bytes + sizeBytes > this.maxBytes) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.deleteEntry(oldestKey, "evicted");
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      sizeBytes,
    });
    this.bytes += sizeBytes;
  }

  snapshot(): PromptScaffoldCacheSnapshot {
    this.purgeExpired();
    return {
      entries: this.store.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      evictions: this.evictions,
      expirations: this.expirations,
      droppedOversizedEntries: this.droppedOversizedEntries,
      hits: this.hits,
      misses: this.misses,
    };
  }

  clear(): void {
    this.store.clear();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(key, "expired");
      }
    }
  }

  private deleteEntry(key: string, reason?: "evicted" | "expired"): boolean {
    const entry = this.store.get(key);
    if (!entry) {
      return false;
    }

    this.bytes -= entry.sizeBytes;
    this.store.delete(key);
    if (reason === "evicted") {
      this.evictions += 1;
    } else if (reason === "expired") {
      this.expirations += 1;
    }
    return true;
  }
}

export type { PromptTemplateVariables };
