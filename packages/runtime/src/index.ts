import { open } from "node:fs/promises";
import * as path from "node:path";
import { sanitizeConfig, snapshotRayConfig } from "@ray/config";
import { TtlCache } from "@ray/cache";
import { createModelProvider } from "@ray/models";
import { resolvePromptTemplateRequest } from "@ray/prompts";
import { RequestScheduler, type ScheduledTaskResult } from "@ray/scheduler";
import { Logger, RuntimeMetrics, serializeError } from "@ray/telemetry";
import {
  RayError,
  clamp,
  createRequestId,
  hashValue,
  isNonEmptyString,
  toErrorMessage,
  type AdaptiveTuningDiagnostics,
  type DegradationDiagnostics,
  type HealthSnapshot,
  type InferenceDiagnostics,
  type InferenceRequest,
  type InferenceResponse,
  type LearnedOutputCapDiagnostics,
  type MemoryPressureSource,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type PartialUsageStats,
  type PromptCompilerDiagnostics,
  type ProviderDiagnostics,
  type ProviderDetectedCapabilities,
  type ProviderHealthSnapshot,
  type ProviderRequestPreparation,
  type ProviderResult,
  type RayConfig,
  type RuntimeMetricsSnapshot,
  type RuntimeHealthDiagnostics,
  type ScheduleLane,
  type SchedulerSlotSnapshot,
  type SchedulerSnapshot,
  type TaskRoutingDiagnostics,
  type UsageBreakdown,
  type UsageStats,
} from "@razroo/ray-core";

interface CachedInferencePayload {
  model: string;
  output: string;
  usage: UsageStats;
  degraded: boolean;
  providerDiagnostics?: ProviderDiagnostics;
}

type WarmState = "idle" | "warming" | "ready" | "failed";

interface CachedProviderHealth {
  checkedAtMs: number;
  snapshot: ProviderHealthSnapshot;
}

interface CompiledPrompt {
  request: NormalizedInferenceRequest;
  affinityKey: string;
  lane: ScheduleLane;
  diagnostics: PromptCompilerDiagnostics;
}

interface AdaptiveSample {
  queueTimeMs: number;
  completionTokensPerSecond?: number;
}

interface FamilyCompletionHistory {
  lane: ScheduleLane;
  completionTokens: number[];
}

interface PreparationQueueEntry {
  timeout: NodeJS.Timeout;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

export interface CgroupMemorySnapshot {
  currentMiB: number;
  highMiB?: number;
  limitMiB?: number;
  pressureRatio?: number;
  highEvents?: number;
  maxEvents?: number;
  oomEvents?: number;
  oomKillEvents?: number;
}

export interface CgroupMemoryReaderOptions {
  procSelfCgroupPath?: string;
  cgroupV2Root?: string;
  cgroupV1MemoryRoot?: string;
  readTextFile?: (filePath: string) => Promise<string>;
}

export interface CgroupCpuSnapshot {
  usageUsec?: number;
  userUsec?: number;
  systemUsec?: number;
  quotaUsec?: number;
  periodUsec?: number;
  quotaCores?: number;
  periods?: number;
  throttledPeriods?: number;
  throttledUsec?: number;
  throttledRatio?: number;
}

export interface CgroupCpuReaderOptions {
  procSelfCgroupPath?: string;
  cgroupV2Root?: string;
  cgroupV1CpuRoot?: string;
  readTextFile?: (filePath: string) => Promise<string>;
}

interface CgroupMemoryCandidate {
  currentPath: string;
  highPath?: string;
  limitPath: string;
  eventsPath?: string;
}

interface CgroupCpuCandidate {
  statPath: string;
  statVersion: "v1" | "v2";
  maxPath?: string;
  quotaPath?: string;
  periodPath?: string;
}

interface MemoryPressureSnapshot {
  processRssMiB: number;
  cgroupMemoryCurrentMiB?: number;
  cgroupMemoryHighMiB?: number;
  cgroupMemoryLimitMiB?: number;
  cgroupMemoryPressureRatio?: number;
  cgroupMemoryHighEvents?: number;
  cgroupMemoryMaxEvents?: number;
  cgroupMemoryOomEvents?: number;
  cgroupMemoryOomKillEvents?: number;
}

type PreparationSnapshot = RuntimeHealthDiagnostics["preparation"];

export type CgroupMemoryReader = () =>
  | CgroupMemorySnapshot
  | Promise<CgroupMemorySnapshot | undefined>
  | undefined;

export type CgroupCpuReader = () =>
  | CgroupCpuSnapshot
  | Promise<CgroupCpuSnapshot | undefined>
  | undefined;

const MAX_DEDUPE_KEY_CHARS = 512;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_KEY_CHARS = 128;
const MAX_METADATA_VALUE_CHARS = 1_024;
const MAX_STOP_SEQUENCES = 16;
const MAX_STOP_SEQUENCE_CHARS = 256;
const BYTES_PER_MIB = 1024 * 1024;
const CGROUP_V2_ROOT = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY_ROOT = "/sys/fs/cgroup/memory";
const CGROUP_V1_CPU_ROOT = "/sys/fs/cgroup/cpu";
const PROC_SELF_CGROUP = "/proc/self/cgroup";
const MAX_CGROUP_TEXT_FILE_BYTES = 64 * 1024;
const CGROUP_MEMORY_CACHE_TTL_MS = 250;
const CGROUP_CPU_CACHE_TTL_MS = 250;
const CGROUP_MEMORY_PRESSURE_RATIO = 0.9;
const CGROUP_UNLIMITED_LIMIT_BYTES = 1024 ** 5;
const unsafeMetadataKeys = new Set(["__proto__", "constructor", "prototype"]);
const MAX_LEARNED_FAMILY_HISTORY_KEYS = 512;
const MAX_PROVIDER_PREPARATION_SLOT_SNAPSHOTS = 256;
const MAX_PROVIDER_SLOT_UPDATED_AT_CHARS = 128;
const MAX_PROVIDER_HEALTH_CHECKED_AT_CHARS = 128;
const MAX_PROVIDER_HEALTH_STRING_CHARS = 512;
const MAX_PROVIDER_HEALTH_DETAIL_DEPTH = 6;
const MAX_PROVIDER_HEALTH_DETAIL_OBJECT_KEYS = 64;
const MAX_PROVIDER_HEALTH_DETAIL_ARRAY_ITEMS = 64;
const MAX_PROVIDER_HEALTH_DETAIL_KEY_CHARS = 128;
const MAX_PROVIDER_HEALTH_DETAIL_STRING_CHARS = 8_192;
const MAX_PROVIDER_CAPABILITY_ERRORS = 8;
const providerDiagnosticIntegerFields = [
  "totalSlots",
  "slotId",
  "preferredSlot",
  "tokensCached",
  "tokensEvaluated",
  "contextWindow",
] as const;
const providerTimingFields = [
  "ttftMs",
  "totalMs",
  "promptMs",
  "completionMs",
  "promptTokensPerSecond",
  "completionTokensPerSecond",
] as const;
const providerHealthStatuses = new Set<ProviderHealthSnapshot["status"]>([
  "unknown",
  "ready",
  "warming",
  "degraded",
  "unavailable",
]);

export interface CreateRayRuntimeOptions {
  provider?: ModelProvider;
  logger?: Logger;
  metrics?: RuntimeMetrics;
  scheduler?: RequestScheduler<ProviderResult>;
  cache?: TtlCache<CachedInferencePayload>;
  memoryUsage?: () => NodeJS.MemoryUsage;
  cgroupMemory?: CgroupMemoryReader | false;
  cgroupCpu?: CgroupCpuReader | false;
}

function assertRequestObject(request: InferenceRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new RayError("request body must be a JSON object", {
      code: "invalid_request",
      status: 400,
    });
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new RayError(`${label} must be a finite number when provided`, {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }
}

function assertOptionalBoolean(
  value: unknown,
  label: string,
): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RayError(`${label} must be a boolean when provided`, {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new RayError(`${label} must be a string when provided`, {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }
}

function assertStringLength(value: string, label: string, maxChars: number): void {
  if (value.length > maxChars) {
    throw new RayError(`${label} must be at most ${maxChars} characters`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxChars,
        actualChars: value.length,
      },
    });
  }
}

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch (error) {
    throw new RayError(`${label} must not contain unreadable properties`, {
      code: "invalid_request",
      status: 400,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function assertMetadataRecord(value: unknown): asserts value is Record<string, string> | undefined {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RayError("metadata must be an object of string values when provided", {
      code: "invalid_request",
      status: 400,
      details: { value },
    });
  }

  const entries = objectEntries(value, "metadata");

  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new RayError(`metadata must contain at most ${MAX_METADATA_ENTRIES} entries`, {
      code: "invalid_request",
      status: 400,
      details: {
        maxEntries: MAX_METADATA_ENTRIES,
        actualEntries: entries.length,
      },
    });
  }

  for (const [key, entry] of entries) {
    if (unsafeMetadataKeys.has(key)) {
      throw new RayError(`metadata must not contain unsafe key "${key}"`, {
        code: "invalid_request",
        status: 400,
        details: { key },
      });
    }

    if (!isNonEmptyString(key) || typeof entry !== "string") {
      throw new RayError("metadata must be an object of string values when provided", {
        code: "invalid_request",
        status: 400,
        details: { value },
      });
    }

    assertStringLength(key, "metadata keys", MAX_METADATA_KEY_CHARS);
    assertStringLength(entry, `metadata.${key}`, MAX_METADATA_VALUE_CHARS);
  }
}

export function normalizeInferenceRequest(
  config: RayConfig,
  request: InferenceRequest,
): NormalizedInferenceRequest {
  assertRequestObject(request);
  assertOptionalString(request.input, "input");
  assertOptionalString(request.system, "system");
  assertOptionalString(request.dedupeKey, "dedupeKey");
  assertOptionalString(request.templateId, "templateId");
  assertFiniteNumber(request.maxTokens, "maxTokens");
  assertFiniteNumber(request.temperature, "temperature");
  assertFiniteNumber(request.topP, "topP");
  assertOptionalBoolean(request.cache, "cache");
  assertMetadataRecord(request.metadata);

  if (request.dedupeKey !== undefined) {
    assertStringLength(request.dedupeKey, "dedupeKey", MAX_DEDUPE_KEY_CHARS);
  }

  const resolvedRequest = resolvePromptTemplateRequest(request);

  if (!isNonEmptyString(resolvedRequest.input)) {
    throw new RayError("input must be a non-empty string", {
      code: "invalid_request",
      status: 400,
    });
  }

  const normalized: NormalizedInferenceRequest = {
    input: resolvedRequest.input.trim(),
    maxTokens: clamp(
      Math.floor(resolvedRequest.maxTokens ?? config.model.maxOutputTokens),
      1,
      config.model.maxOutputTokens,
    ),
    temperature: clamp(request.temperature ?? 0.2, 0, 2),
    topP: clamp(request.topP ?? 0.95, 0.1, 1),
    cache: request.cache ?? true,
    metadata: resolvedRequest.metadata,
  };

  if (isNonEmptyString(resolvedRequest.system)) {
    normalized.system = resolvedRequest.system.trim();
  }

  if (request.seed !== undefined) {
    if (!Number.isSafeInteger(request.seed)) {
      throw new RayError("seed must be a safe integer when provided", {
        code: "invalid_request",
        status: 400,
      });
    }

    normalized.seed = request.seed;
  }

  if (request.stop !== undefined) {
    if (!Array.isArray(request.stop) || request.stop.length === 0) {
      throw new RayError("stop must be a non-empty array of strings when provided", {
        code: "invalid_request",
        status: 400,
      });
    }

    if (request.stop.length > MAX_STOP_SEQUENCES) {
      throw new RayError(`stop must contain at most ${MAX_STOP_SEQUENCES} entries`, {
        code: "invalid_request",
        status: 400,
        details: {
          maxEntries: MAX_STOP_SEQUENCES,
          actualEntries: request.stop.length,
        },
      });
    }

    normalized.stop = request.stop.map((value) => {
      if (!isNonEmptyString(value)) {
        throw new RayError("stop entries must be non-empty strings", {
          code: "invalid_request",
          status: 400,
        });
      }

      assertStringLength(value, "stop entries", MAX_STOP_SEQUENCE_CHARS);

      return value;
    });
  }

  if (resolvedRequest.responseFormat !== undefined) {
    if (
      resolvedRequest.responseFormat === null ||
      typeof resolvedRequest.responseFormat !== "object" ||
      (resolvedRequest.responseFormat.type !== "text" &&
        resolvedRequest.responseFormat.type !== "json_object")
    ) {
      throw new RayError("responseFormat.type must be 'text' or 'json_object' when provided", {
        code: "invalid_request",
        status: 400,
      });
    }

    normalized.responseFormat = resolvedRequest.responseFormat;
  }

  if (isNonEmptyString(request.dedupeKey)) {
    normalized.dedupeKey = request.dedupeKey;
  }

  if (isNonEmptyString(resolvedRequest.promptTemplateId)) {
    normalized.promptTemplateId = resolvedRequest.promptTemplateId;
  }

  if (
    resolvedRequest.templateVariables &&
    Object.keys(resolvedRequest.templateVariables).length > 0
  ) {
    normalized.templateVariables = resolvedRequest.templateVariables;
  }

  if (resolvedRequest.promptLane === "short" || resolvedRequest.promptLane === "draft") {
    normalized.promptLane = resolvedRequest.promptLane;
  }

  if (isNonEmptyString(resolvedRequest.promptFamily)) {
    normalized.promptFamily = resolvedRequest.promptFamily;
  }

  return normalized;
}

function normalizePromptText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dedupeLines(value: string): string {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const rawLine of value.split("\n")) {
    const normalized = rawLine.trim().toLowerCase();
    if (normalized.length === 0) {
      output.push("");
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(rawLine);
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeSystemDuplicates(system: string | undefined, input: string): string {
  if (!system) {
    return input;
  }

  const systemLines = new Set(
    system
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 20),
  );

  const nextLines = input.split("\n").filter((line) => {
    const normalized = line.trim().toLowerCase();
    return normalized.length < 20 || !systemLines.has(normalized);
  });

  const next = nextLines.join("\n").trim();
  return next.length > 0 ? next : input;
}

function derivePromptTemplate(value: string): string {
  return normalizePromptText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/"[^"]{1,120}"/g, '"<value>"')
    .replace(/\b[a-f0-9]{8,}\b/gi, "<hex>")
    .slice(0, 240);
}

function resolveScheduleLane(config: RayConfig, request: NormalizedInferenceRequest): ScheduleLane {
  if (request.promptLane === "short" || request.promptLane === "draft") {
    return request.promptLane;
  }

  const metadataLane = request.metadata.promptLane;
  if (metadataLane === "short" || metadataLane === "draft") {
    return metadataLane;
  }

  if (
    request.responseFormat?.type === "json_object" ||
    request.maxTokens <= config.scheduler.shortJobMaxTokens
  ) {
    return "short";
  }

  return "draft";
}

function resolveTaskRoutingDiagnostics(
  config: RayConfig,
  request: NormalizedInferenceRequest,
): TaskRoutingDiagnostics {
  const family = request.promptFamily ?? request.metadata.promptFamily ?? "";
  const promptText = `${request.system ?? ""}\n${request.input}`.toLowerCase();
  const taskKind: TaskRoutingDiagnostics["taskKind"] =
    request.responseFormat?.type === "json_object" || family.includes("classification")
      ? "classification"
      : family.includes("rewrite")
        ? "rewrite"
        : family.includes("email") || promptText.includes("email")
          ? "draft"
          : "unknown";
  const recommendedModelRole: TaskRoutingDiagnostics["recommendedModelRole"] =
    taskKind === "classification" ? "classifier" : taskKind === "unknown" ? "general" : "drafter";
  const activeModelRole = config.tags.modelRole;

  return {
    taskKind,
    recommendedModelRole,
    ...(activeModelRole ? { activeModelRole } : {}),
    matchedActiveRole:
      activeModelRole === undefined ||
      activeModelRole === recommendedModelRole ||
      recommendedModelRole === "general",
  };
}

function compilePrompt(config: RayConfig, request: NormalizedInferenceRequest): CompiledPrompt {
  const charsBefore = request.input.length + (request.system?.length ?? 0);
  const lane = resolveScheduleLane(config, request);

  if (!config.promptCompiler.enabled) {
    const familyHint = config.promptCompiler.familyMetadataKeys.find((key) =>
      isNonEmptyString(request.metadata[key]),
    );
    const familySeed =
      request.promptFamily ??
      (familyHint ? request.metadata[familyHint] : undefined) ??
      derivePromptTemplate(request.input);
    const familyKey = hashValue({
      system: request.system ?? "",
      template: familySeed,
    });

    return {
      request,
      affinityKey: familyKey,
      lane,
      diagnostics: {
        familyKey,
        lane,
        ...(request.promptTemplateId ? { templateId: request.promptTemplateId } : {}),
        charsBefore,
        charsAfter: charsBefore,
        charsSaved: 0,
      },
    };
  }

  let system = request.system;
  let input = request.input;

  if (config.promptCompiler.collapseWhitespace) {
    if (system) {
      system = normalizePromptText(system);
    }
    input = normalizePromptText(input);
  }

  if (config.promptCompiler.dedupeRepeatedLines) {
    if (system) {
      system = dedupeLines(system);
    }
    input = dedupeLines(removeSystemDuplicates(system, input));
  }

  const compiledRequest: NormalizedInferenceRequest = {
    ...request,
    input,
    ...(system ? { system } : {}),
  };
  const familyMetadataKey = config.promptCompiler.familyMetadataKeys.find((key) =>
    isNonEmptyString(compiledRequest.metadata[key]),
  );
  const familySeed =
    compiledRequest.promptFamily ??
    (familyMetadataKey ? compiledRequest.metadata[familyMetadataKey] : undefined) ??
    derivePromptTemplate(compiledRequest.input);
  const familyKey = hashValue({
    system: compiledRequest.system ?? "",
    template: familySeed,
  });
  const charsAfter = compiledRequest.input.length + (compiledRequest.system?.length ?? 0);

  return {
    request: compiledRequest,
    affinityKey: familyKey,
    lane,
    diagnostics: {
      familyKey,
      lane,
      ...(compiledRequest.promptTemplateId ? { templateId: compiledRequest.promptTemplateId } : {}),
      charsBefore,
      charsAfter,
      charsSaved: Math.max(0, charsBefore - charsAfter),
    },
  };
}

function applyPromptLengthDegradation(
  config: RayConfig,
  request: NormalizedInferenceRequest,
): { request: NormalizedInferenceRequest; degraded: boolean } {
  if (!config.gracefulDegradation.enabled) {
    return { request, degraded: false };
  }

  if (request.input.length <= config.gracefulDegradation.maxPromptChars) {
    return { request, degraded: false };
  }

  return {
    request: {
      ...request,
      input: request.input.slice(0, config.gracefulDegradation.maxPromptChars),
    },
    degraded: true,
  };
}

function applyQueueDepthDegradation(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  queueDepth: number,
): { request: NormalizedInferenceRequest; degraded: boolean } {
  if (!config.gracefulDegradation.enabled) {
    return { request, degraded: false };
  }

  if (
    queueDepth < config.gracefulDegradation.queueDepthThreshold ||
    request.maxTokens <= config.gracefulDegradation.degradeToMaxTokens
  ) {
    return { request, degraded: false };
  }

  return {
    request: {
      ...request,
      maxTokens: config.gracefulDegradation.degradeToMaxTokens,
    },
    degraded: true,
  };
}

function applyMemoryPressureDegradation(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  memoryPressureSources: MemoryPressureSource[],
): { request: NormalizedInferenceRequest; degraded: boolean } {
  if (!config.gracefulDegradation.enabled) {
    return { request, degraded: false };
  }

  if (
    memoryPressureSources.length === 0 ||
    request.maxTokens <= config.gracefulDegradation.degradeToMaxTokens
  ) {
    return { request, degraded: false };
  }

  return {
    request: {
      ...request,
      maxTokens: config.gracefulDegradation.degradeToMaxTokens,
    },
    degraded: true,
  };
}

function resolveCgroupCpuPressure(
  config: RayConfig,
  snapshot: CgroupCpuSnapshot | undefined,
): boolean {
  return (
    config.gracefulDegradation.enabled &&
    snapshot?.throttledRatio !== undefined &&
    snapshot.throttledRatio >= config.gracefulDegradation.cpuThrottledRatioThreshold
  );
}

function applyRecentCgroupCpuThrottlingRatio(
  snapshot: CgroupCpuSnapshot | undefined,
  previous: CgroupCpuSnapshot | undefined,
): CgroupCpuSnapshot | undefined {
  if (
    !snapshot ||
    snapshot.periods === undefined ||
    snapshot.throttledPeriods === undefined ||
    previous?.periods === undefined ||
    previous.throttledPeriods === undefined
  ) {
    return snapshot;
  }

  const periodDelta = snapshot.periods - previous.periods;
  const throttledDelta = snapshot.throttledPeriods - previous.throttledPeriods;

  if (periodDelta <= 0 || throttledDelta < 0) {
    return snapshot;
  }

  return {
    ...snapshot,
    throttledRatio: Number((throttledDelta / periodDelta).toFixed(4)),
  };
}

function applyCpuPressureDegradation(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  cgroupCpu: CgroupCpuSnapshot | undefined,
): { request: NormalizedInferenceRequest; degraded: boolean } {
  if (
    !resolveCgroupCpuPressure(config, cgroupCpu) ||
    request.maxTokens <= config.gracefulDegradation.degradeToMaxTokens
  ) {
    return { request, degraded: false };
  }

  return {
    request: {
      ...request,
      maxTokens: config.gracefulDegradation.degradeToMaxTokens,
    },
    degraded: true,
  };
}

function buildDegradationDiagnostics(options: {
  promptLengthDegraded: boolean;
  queueDepthDegraded: boolean;
  memoryPressureDegraded: boolean;
  cpuPressureDegraded: boolean;
  requestedMaxTokens: number;
  appliedMaxTokens: number;
  queueDepth: number;
  queueDepthThreshold: number;
  memoryPressureSources: MemoryPressureSource[];
  memoryPressure: MemoryPressureSnapshot;
  cgroupCpu: CgroupCpuSnapshot | undefined;
  memoryRssThresholdMiB: number;
  cpuThrottledRatioThreshold: number;
}): DegradationDiagnostics {
  const reasons: DegradationDiagnostics["reasons"] = [];

  if (options.promptLengthDegraded) {
    reasons.push("prompt_length");
  }

  if (options.queueDepthDegraded) {
    reasons.push("queue_depth");
  }

  if (options.memoryPressureDegraded) {
    reasons.push("memory_pressure");
  }

  if (options.cpuPressureDegraded) {
    reasons.push("cpu_pressure");
  }

  return {
    applied: reasons.length > 0,
    reasons,
    requestedMaxTokens: options.requestedMaxTokens,
    appliedMaxTokens: options.appliedMaxTokens,
    queueDepth: options.queueDepth,
    queueDepthThreshold: options.queueDepthThreshold,
    ...(options.memoryPressureSources.length > 0
      ? { memoryPressureSources: options.memoryPressureSources }
      : {}),
    processRssMiB: options.memoryPressure.processRssMiB,
    memoryRssThresholdMiB: options.memoryRssThresholdMiB,
    processRssPressureRatio: resolveProcessRssPressureRatio(
      options.memoryPressure.processRssMiB,
      options.memoryRssThresholdMiB,
    ),
    ...(options.memoryPressure.cgroupMemoryCurrentMiB !== undefined
      ? { cgroupMemoryCurrentMiB: options.memoryPressure.cgroupMemoryCurrentMiB }
      : {}),
    ...(options.memoryPressure.cgroupMemoryHighMiB !== undefined
      ? { cgroupMemoryHighMiB: options.memoryPressure.cgroupMemoryHighMiB }
      : {}),
    ...(options.memoryPressure.cgroupMemoryLimitMiB !== undefined
      ? { cgroupMemoryLimitMiB: options.memoryPressure.cgroupMemoryLimitMiB }
      : {}),
    ...(options.memoryPressure.cgroupMemoryPressureRatio !== undefined
      ? { cgroupMemoryPressureRatio: options.memoryPressure.cgroupMemoryPressureRatio }
      : {}),
    ...(options.memoryPressure.cgroupMemoryHighEvents !== undefined
      ? { cgroupMemoryHighEvents: options.memoryPressure.cgroupMemoryHighEvents }
      : {}),
    ...(options.memoryPressure.cgroupMemoryMaxEvents !== undefined
      ? { cgroupMemoryMaxEvents: options.memoryPressure.cgroupMemoryMaxEvents }
      : {}),
    ...(options.memoryPressure.cgroupMemoryOomEvents !== undefined
      ? { cgroupMemoryOomEvents: options.memoryPressure.cgroupMemoryOomEvents }
      : {}),
    ...(options.memoryPressure.cgroupMemoryOomKillEvents !== undefined
      ? { cgroupMemoryOomKillEvents: options.memoryPressure.cgroupMemoryOomKillEvents }
      : {}),
    ...(options.cgroupCpu?.throttledRatio !== undefined
      ? {
          cgroupCpuThrottledRatio: options.cgroupCpu.throttledRatio,
          cgroupCpuThrottledThreshold: options.cpuThrottledRatioThreshold,
        }
      : {}),
  };
}

function buildRuntimeHealthDiagnostics(options: {
  queueDegraded: boolean;
  queueSnapshot: SchedulerSnapshot;
  queueDepthThreshold: number;
  preparationSnapshot: PreparationSnapshot;
  memoryPressureSources: MemoryPressureSource[];
  memoryPressure: MemoryPressureSnapshot;
  memoryRssThresholdMiB: number;
  cpuDegraded: boolean;
  cpuThrottledRatioThreshold: number;
  cgroupCpu: CgroupCpuSnapshot | undefined;
}): RuntimeHealthDiagnostics {
  return {
    queue: {
      degraded: options.queueDegraded,
      depth: options.queueSnapshot.queueDepth,
      depthRatio: resolveSaturationRatio(
        options.queueSnapshot.queueDepth,
        options.queueSnapshot.maxQueue,
      ),
      shortDepth: options.queueSnapshot.shortQueueDepth,
      draftDepth: options.queueSnapshot.draftQueueDepth,
      threshold: options.queueDepthThreshold,
      maxQueue: options.queueSnapshot.maxQueue,
      inFlight: options.queueSnapshot.inFlight,
      inFlightRatio: resolveSaturationRatio(
        options.queueSnapshot.inFlight,
        options.queueSnapshot.concurrency,
      ),
      concurrency: options.queueSnapshot.concurrency,
      queuedTokens: options.queueSnapshot.queuedTokens,
      queuedTokensRatio: resolveSaturationRatio(
        options.queueSnapshot.queuedTokens,
        options.queueSnapshot.maxQueuedTokens,
      ),
      maxQueuedTokens: options.queueSnapshot.maxQueuedTokens,
      inFlightTokens: options.queueSnapshot.inFlightTokens,
      inFlightTokensRatio: resolveSaturationRatio(
        options.queueSnapshot.inFlightTokens,
        options.queueSnapshot.maxInflightTokens,
      ),
      maxInflightTokens: options.queueSnapshot.maxInflightTokens,
    },
    preparation: options.preparationSnapshot,
    memory: {
      degraded: options.memoryPressureSources.length > 0,
      sources: options.memoryPressureSources,
      processRssMiB: options.memoryPressure.processRssMiB,
      memoryRssThresholdMiB: options.memoryRssThresholdMiB,
      processRssPressureRatio: resolveProcessRssPressureRatio(
        options.memoryPressure.processRssMiB,
        options.memoryRssThresholdMiB,
      ),
      ...(options.memoryPressure.cgroupMemoryCurrentMiB !== undefined
        ? { cgroupMemoryCurrentMiB: options.memoryPressure.cgroupMemoryCurrentMiB }
        : {}),
      ...(options.memoryPressure.cgroupMemoryHighMiB !== undefined
        ? { cgroupMemoryHighMiB: options.memoryPressure.cgroupMemoryHighMiB }
        : {}),
      ...(options.memoryPressure.cgroupMemoryLimitMiB !== undefined
        ? { cgroupMemoryLimitMiB: options.memoryPressure.cgroupMemoryLimitMiB }
        : {}),
      ...(options.memoryPressure.cgroupMemoryPressureRatio !== undefined
        ? { cgroupMemoryPressureRatio: options.memoryPressure.cgroupMemoryPressureRatio }
        : {}),
      ...(options.memoryPressure.cgroupMemoryHighEvents !== undefined
        ? { cgroupMemoryHighEvents: options.memoryPressure.cgroupMemoryHighEvents }
        : {}),
      ...(options.memoryPressure.cgroupMemoryMaxEvents !== undefined
        ? { cgroupMemoryMaxEvents: options.memoryPressure.cgroupMemoryMaxEvents }
        : {}),
      ...(options.memoryPressure.cgroupMemoryOomEvents !== undefined
        ? { cgroupMemoryOomEvents: options.memoryPressure.cgroupMemoryOomEvents }
        : {}),
      ...(options.memoryPressure.cgroupMemoryOomKillEvents !== undefined
        ? { cgroupMemoryOomKillEvents: options.memoryPressure.cgroupMemoryOomKillEvents }
        : {}),
    },
    ...(options.cgroupCpu
      ? {
          cpu: {
            degraded: options.cpuDegraded,
            ...(options.cgroupCpu.usageUsec !== undefined
              ? { cgroupCpuUsageUsec: options.cgroupCpu.usageUsec }
              : {}),
            ...(options.cgroupCpu.userUsec !== undefined
              ? { cgroupCpuUserUsec: options.cgroupCpu.userUsec }
              : {}),
            ...(options.cgroupCpu.systemUsec !== undefined
              ? { cgroupCpuSystemUsec: options.cgroupCpu.systemUsec }
              : {}),
            ...(options.cgroupCpu.quotaUsec !== undefined
              ? { cgroupCpuQuotaUsec: options.cgroupCpu.quotaUsec }
              : {}),
            ...(options.cgroupCpu.periodUsec !== undefined
              ? { cgroupCpuPeriodUsec: options.cgroupCpu.periodUsec }
              : {}),
            ...(options.cgroupCpu.quotaCores !== undefined
              ? { cgroupCpuQuotaCores: options.cgroupCpu.quotaCores }
              : {}),
            ...(options.cgroupCpu.periods !== undefined
              ? { cgroupCpuPeriods: options.cgroupCpu.periods }
              : {}),
            ...(options.cgroupCpu.throttledPeriods !== undefined
              ? { cgroupCpuThrottledPeriods: options.cgroupCpu.throttledPeriods }
              : {}),
            ...(options.cgroupCpu.throttledUsec !== undefined
              ? { cgroupCpuThrottledUsec: options.cgroupCpu.throttledUsec }
              : {}),
            ...(options.cgroupCpu.throttledRatio !== undefined
              ? {
                  cgroupCpuThrottledRatio: options.cgroupCpu.throttledRatio,
                  cgroupCpuThrottledThreshold: options.cpuThrottledRatioThreshold,
                }
              : {}),
          },
        }
      : {}),
  };
}

function bytesToMiB(value: number): number {
  return Number((value / BYTES_PER_MIB).toFixed(2));
}

function resolveProcessRssPressureRatio(processRssMiB: number, thresholdMiB: number): number {
  return Number((processRssMiB / Math.max(1, thresholdMiB)).toFixed(4));
}

function resolveSaturationRatio(value: number, capacity: number): number {
  return Number((value / Math.max(1, capacity)).toFixed(4));
}

async function readTextFileBounded(filePath: string, maxBytes: number): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await fileHandle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }

    if (offset > maxBytes) {
      throw new Error(`cgroup text file must be at most ${maxBytes} bytes: ${filePath}`);
    }

    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

async function defaultReadTextFile(filePath: string): Promise<string> {
  return await readTextFileBounded(filePath, MAX_CGROUP_TEXT_FILE_BYTES);
}

function parseCgroupByteValue(raw: string, options: { allowMax: boolean }): number | undefined {
  const value = raw.trim();

  if (options.allowMax && value === "max") {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }

  if (options.allowMax && bytes >= CGROUP_UNLIMITED_LIMIT_BYTES) {
    return undefined;
  }

  return bytes;
}

function parseCgroupMemoryEvents(raw: string): {
  highEvents?: number;
  maxEvents?: number;
  oomEvents?: number;
  oomKillEvents?: number;
} {
  const events: {
    highEvents?: number;
    maxEvents?: number;
    oomEvents?: number;
    oomKillEvents?: number;
  } = {};
  const keys = {
    high: "highEvents",
    max: "maxEvents",
    oom: "oomEvents",
    oom_kill: "oomKillEvents",
  } as const;

  for (const line of raw.split(/\r?\n/)) {
    const match = /^([a-z_]+)\s+(\d+)$/.exec(line.trim());

    if (!match) {
      continue;
    }

    const key = keys[match[1] as keyof typeof keys];
    const value = Number(match[2]);

    if (!key || !Number.isSafeInteger(value) || value < 0) {
      continue;
    }

    events[key] = value;
  }

  return events;
}

function parseCgroupCpuStat(raw: string, statVersion: "v1" | "v2"): CgroupCpuSnapshot | undefined {
  const values = new Map<string, number>();

  for (const line of raw.split(/\r?\n/)) {
    const match = /^([a-z_]+)\s+(\d+)$/.exec(line.trim());

    if (!match) {
      continue;
    }

    const value = Number(match[2]);

    if (!Number.isSafeInteger(value) || value < 0) {
      continue;
    }

    values.set(match[1] ?? "", value);
  }

  const usageUsec = values.get("usage_usec");
  const userUsec = values.get("user_usec");
  const systemUsec = values.get("system_usec");
  const periods = values.get("nr_periods");
  const throttledPeriods = values.get("nr_throttled");
  const throttledUsec =
    statVersion === "v2" ? values.get("throttled_usec") : values.get("throttled_time");
  const snapshot: CgroupCpuSnapshot = {
    ...(usageUsec !== undefined ? { usageUsec } : {}),
    ...(userUsec !== undefined ? { userUsec } : {}),
    ...(systemUsec !== undefined ? { systemUsec } : {}),
    ...(periods !== undefined ? { periods } : {}),
    ...(throttledPeriods !== undefined ? { throttledPeriods } : {}),
    ...(throttledUsec !== undefined
      ? { throttledUsec: statVersion === "v2" ? throttledUsec : Math.round(throttledUsec / 1000) }
      : {}),
  };

  if (periods !== undefined && periods > 0 && throttledPeriods !== undefined) {
    snapshot.throttledRatio = Number((throttledPeriods / periods).toFixed(4));
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function parsePositiveCgroupInteger(raw: string): number | undefined {
  const value = raw.trim();

  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildCgroupCpuQuotaSnapshot(
  quotaUsec: number | undefined,
  periodUsec: number | undefined,
): CgroupCpuSnapshot | undefined {
  const snapshot: CgroupCpuSnapshot = {
    ...(quotaUsec !== undefined ? { quotaUsec } : {}),
    ...(periodUsec !== undefined ? { periodUsec } : {}),
  };

  if (quotaUsec !== undefined && periodUsec !== undefined && periodUsec > 0) {
    snapshot.quotaCores = Number((quotaUsec / periodUsec).toFixed(4));
  }

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function parseCgroupCpuMax(raw: string): CgroupCpuSnapshot | undefined {
  const parts = raw.trim().split(/\s+/);

  if (parts.length < 2) {
    return undefined;
  }

  const quotaUsec = parts[0] === "max" ? undefined : parsePositiveCgroupInteger(parts[0] ?? "");
  const periodUsec = parsePositiveCgroupInteger(parts[1] ?? "");

  return buildCgroupCpuQuotaSnapshot(quotaUsec, periodUsec);
}

function parseCgroupCpuCfsQuota(raw: string): number | undefined {
  const value = raw.trim();

  if (value === "-1") {
    return undefined;
  }

  return parsePositiveCgroupInteger(value);
}

function resolveCgroupFile(root: string, cgroupPath: string, fileName: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const relativeCgroupPath = cgroupPath === "/" ? "" : cgroupPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(resolvedRoot, relativeCgroupPath, fileName);

  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return undefined;
  }

  return resolvedPath;
}

function resolveCgroupMemoryCandidates(
  procCgroup: string,
  options: Required<Pick<CgroupMemoryReaderOptions, "cgroupV2Root" | "cgroupV1MemoryRoot">>,
): CgroupMemoryCandidate[] {
  const candidates: CgroupMemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const line of procCgroup.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parts = line.split(":");

    if (parts.length < 3) {
      continue;
    }

    const hierarchy = parts[0] ?? "";
    const controllers = parts[1] ?? "";
    const cgroupPath = parts.slice(2).join(":") || "/";
    const isUnifiedCgroup = hierarchy === "0" && controllers === "";
    const isMemoryController = controllers.split(",").includes("memory");
    const root = isUnifiedCgroup
      ? options.cgroupV2Root
      : isMemoryController
        ? options.cgroupV1MemoryRoot
        : undefined;

    if (!root) {
      continue;
    }

    const currentPath = resolveCgroupFile(
      root,
      cgroupPath,
      isUnifiedCgroup ? "memory.current" : "memory.usage_in_bytes",
    );
    const limitPath = resolveCgroupFile(
      root,
      cgroupPath,
      isUnifiedCgroup ? "memory.max" : "memory.limit_in_bytes",
    );
    const highPath = isUnifiedCgroup
      ? resolveCgroupFile(root, cgroupPath, "memory.high")
      : undefined;
    const eventsPath = isUnifiedCgroup
      ? resolveCgroupFile(root, cgroupPath, "memory.events")
      : undefined;

    if (!currentPath || !limitPath) {
      continue;
    }

    const key = `${currentPath}\n${highPath ?? ""}\n${limitPath}\n${eventsPath ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push({
      currentPath,
      ...(highPath ? { highPath } : {}),
      limitPath,
      ...(eventsPath ? { eventsPath } : {}),
    });
  }

  return candidates;
}

function resolveCgroupCpuCandidates(
  procCgroup: string,
  options: Required<Pick<CgroupCpuReaderOptions, "cgroupV2Root" | "cgroupV1CpuRoot">>,
): CgroupCpuCandidate[] {
  const candidates: CgroupCpuCandidate[] = [];
  const seen = new Set<string>();

  for (const line of procCgroup.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parts = line.split(":");

    if (parts.length < 3) {
      continue;
    }

    const hierarchy = parts[0] ?? "";
    const controllers = parts[1] ?? "";
    const cgroupPath = parts.slice(2).join(":") || "/";
    const isUnifiedCgroup = hierarchy === "0" && controllers === "";
    const hasCpuController = controllers.split(",").includes("cpu");
    const root = isUnifiedCgroup
      ? options.cgroupV2Root
      : hasCpuController
        ? options.cgroupV1CpuRoot
        : undefined;

    if (!root) {
      continue;
    }

    const statPath = resolveCgroupFile(root, cgroupPath, "cpu.stat");
    const maxPath = isUnifiedCgroup ? resolveCgroupFile(root, cgroupPath, "cpu.max") : undefined;
    const quotaPath = isUnifiedCgroup
      ? undefined
      : resolveCgroupFile(root, cgroupPath, "cpu.cfs_quota_us");
    const periodPath = isUnifiedCgroup
      ? undefined
      : resolveCgroupFile(root, cgroupPath, "cpu.cfs_period_us");

    if (!statPath || seen.has(statPath)) {
      continue;
    }

    seen.add(statPath);
    candidates.push({
      statPath,
      statVersion: isUnifiedCgroup ? "v2" : "v1",
      ...(maxPath ? { maxPath } : {}),
      ...(quotaPath ? { quotaPath } : {}),
      ...(periodPath ? { periodPath } : {}),
    });
  }

  return candidates;
}

export async function readCgroupMemorySnapshot(
  options: CgroupMemoryReaderOptions = {},
): Promise<CgroupMemorySnapshot | undefined> {
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  let procCgroup: string;

  try {
    procCgroup = await readTextFile(options.procSelfCgroupPath ?? PROC_SELF_CGROUP);
  } catch {
    return undefined;
  }

  const candidates = resolveCgroupMemoryCandidates(procCgroup, {
    cgroupV2Root: options.cgroupV2Root ?? CGROUP_V2_ROOT,
    cgroupV1MemoryRoot: options.cgroupV1MemoryRoot ?? CGROUP_V1_MEMORY_ROOT,
  });

  for (const candidate of candidates) {
    try {
      const currentRaw = await readTextFile(candidate.currentPath);
      const currentBytes = parseCgroupByteValue(currentRaw, { allowMax: false });

      if (currentBytes === undefined) {
        continue;
      }

      const limitRaw = await readTextFile(candidate.limitPath).catch(() => undefined);
      const limitBytes =
        limitRaw === undefined ? undefined : parseCgroupByteValue(limitRaw, { allowMax: true });
      const highRaw = candidate.highPath
        ? await readTextFile(candidate.highPath).catch(() => undefined)
        : undefined;
      const highBytes =
        highRaw === undefined ? undefined : parseCgroupByteValue(highRaw, { allowMax: true });
      const eventsRaw = candidate.eventsPath
        ? await readTextFile(candidate.eventsPath).catch(() => undefined)
        : undefined;
      const events = eventsRaw === undefined ? undefined : parseCgroupMemoryEvents(eventsRaw);
      const snapshot: CgroupMemorySnapshot = {
        currentMiB: bytesToMiB(currentBytes),
      };

      if (highBytes !== undefined && highBytes > 0) {
        snapshot.highMiB = bytesToMiB(highBytes);
      }

      if (limitBytes !== undefined && limitBytes > 0) {
        snapshot.limitMiB = bytesToMiB(limitBytes);
      }

      const pressureLimitBytes = highBytes !== undefined && highBytes > 0 ? highBytes : limitBytes;
      if (pressureLimitBytes !== undefined && pressureLimitBytes > 0) {
        snapshot.pressureRatio = Number((currentBytes / pressureLimitBytes).toFixed(4));
      }

      if (events?.highEvents !== undefined) {
        snapshot.highEvents = events.highEvents;
      }

      if (events?.maxEvents !== undefined) {
        snapshot.maxEvents = events.maxEvents;
      }

      if (events?.oomEvents !== undefined) {
        snapshot.oomEvents = events.oomEvents;
      }

      if (events?.oomKillEvents !== undefined) {
        snapshot.oomKillEvents = events.oomKillEvents;
      }

      return snapshot;
    } catch {
      continue;
    }
  }

  return undefined;
}

export async function readCgroupCpuSnapshot(
  options: CgroupCpuReaderOptions = {},
): Promise<CgroupCpuSnapshot | undefined> {
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  let procCgroup: string;

  try {
    procCgroup = await readTextFile(options.procSelfCgroupPath ?? PROC_SELF_CGROUP);
  } catch {
    return undefined;
  }

  const candidates = resolveCgroupCpuCandidates(procCgroup, {
    cgroupV2Root: options.cgroupV2Root ?? CGROUP_V2_ROOT,
    cgroupV1CpuRoot: options.cgroupV1CpuRoot ?? CGROUP_V1_CPU_ROOT,
  });

  for (const candidate of candidates) {
    try {
      const statRaw = await readTextFile(candidate.statPath).catch(() => undefined);
      const statSnapshot =
        statRaw === undefined ? undefined : parseCgroupCpuStat(statRaw, candidate.statVersion);
      const quotaSnapshot =
        candidate.statVersion === "v2"
          ? candidate.maxPath
            ? parseCgroupCpuMax(await readTextFile(candidate.maxPath).catch(() => ""))
            : undefined
          : buildCgroupCpuQuotaSnapshot(
              candidate.quotaPath
                ? parseCgroupCpuCfsQuota(await readTextFile(candidate.quotaPath).catch(() => ""))
                : undefined,
              candidate.periodPath
                ? parsePositiveCgroupInteger(
                    await readTextFile(candidate.periodPath).catch(() => ""),
                  )
                : undefined,
            );
      const snapshot = {
        ...(statSnapshot ?? {}),
        ...(quotaSnapshot ?? {}),
      };

      if (Object.keys(snapshot).length > 0) {
        return snapshot;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function resolveMemoryPressureSources(
  config: RayConfig,
  snapshot: MemoryPressureSnapshot,
): MemoryPressureSource[] {
  if (!config.gracefulDegradation.enabled) {
    return [];
  }

  const sources: MemoryPressureSource[] = [];

  if (snapshot.processRssMiB >= config.gracefulDegradation.memoryRssThresholdMiB) {
    sources.push("process_rss");
  }

  if (
    snapshot.cgroupMemoryPressureRatio !== undefined &&
    snapshot.cgroupMemoryPressureRatio >= CGROUP_MEMORY_PRESSURE_RATIO
  ) {
    sources.push("cgroup");
  }

  return sources;
}

function buildCacheKey(config: RayConfig, request: NormalizedInferenceRequest): string {
  const payload =
    config.cache.keyStrategy === "input"
      ? {
          model: config.model.id,
          input: request.input,
          system: request.system ?? "",
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...(request.stop ? { stop: request.stop } : {}),
          ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
        }
      : {
          model: config.model.id,
          input: request.input,
          system: request.system ?? "",
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          topP: request.topP,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...(request.stop ? { stop: request.stop } : {}),
          ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
        };

  return hashValue(payload);
}

function estimateRequestTokens(request: NormalizedInferenceRequest): number {
  const promptChars = request.input.length + (request.system?.length ?? 0);
  const promptTokensEstimate = Math.max(1, Math.ceil(promptChars / 4));
  return promptTokensEstimate + request.maxTokens;
}

function applyAdaptiveTuning(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  recentSamples: AdaptiveSample[],
): {
  request: NormalizedInferenceRequest;
  diagnostics: AdaptiveTuningDiagnostics;
} {
  if (!config.adaptiveTuning.enabled || recentSamples.length === 0) {
    return {
      request,
      diagnostics: {
        reduced: false,
        requestedMaxTokens: request.maxTokens,
        appliedMaxTokens: request.maxTokens,
        reductionRatio: 0,
      },
    };
  }

  const averageQueueTimeMs =
    recentSamples.reduce((sum, sample) => sum + sample.queueTimeMs, 0) / recentSamples.length;
  const throughputSamples = recentSamples
    .map((sample) => sample.completionTokensPerSecond)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const averageCompletionTokensPerSecond =
    throughputSamples.length > 0
      ? throughputSamples.reduce((sum, value) => sum + value, 0) / throughputSamples.length
      : undefined;

  let reductionRatio = 0;
  let reason: string | undefined;

  if (averageQueueTimeMs > config.adaptiveTuning.queueLatencyThresholdMs) {
    reductionRatio = clamp(
      (averageQueueTimeMs / config.adaptiveTuning.queueLatencyThresholdMs - 1) * 0.25,
      reductionRatio,
      config.adaptiveTuning.maxOutputReductionRatio,
    );
    reason = "queue_latency";
  }

  if (
    averageCompletionTokensPerSecond !== undefined &&
    averageCompletionTokensPerSecond < config.adaptiveTuning.minCompletionTokensPerSecond
  ) {
    reductionRatio = clamp(
      Math.max(
        reductionRatio,
        (config.adaptiveTuning.minCompletionTokensPerSecond / averageCompletionTokensPerSecond -
          1) *
          0.25,
      ),
      0,
      config.adaptiveTuning.maxOutputReductionRatio,
    );
    reason = reason ? `${reason}+throughput` : "throughput";
  }

  if (reductionRatio <= 0) {
    return {
      request,
      diagnostics: {
        reduced: false,
        requestedMaxTokens: request.maxTokens,
        appliedMaxTokens: request.maxTokens,
        reductionRatio: 0,
      },
    };
  }

  const appliedMaxTokens = clamp(
    Math.floor(request.maxTokens * (1 - reductionRatio)),
    config.adaptiveTuning.minOutputTokens,
    request.maxTokens,
  );

  if (appliedMaxTokens >= request.maxTokens) {
    return {
      request,
      diagnostics: {
        reduced: false,
        requestedMaxTokens: request.maxTokens,
        appliedMaxTokens: request.maxTokens,
        reductionRatio: 0,
      },
    };
  }

  return {
    request: {
      ...request,
      maxTokens: appliedMaxTokens,
    },
    diagnostics: {
      reduced: true,
      requestedMaxTokens: request.maxTokens,
      appliedMaxTokens,
      reductionRatio,
      ...(reason ? { reason } : {}),
    },
  };
}

function applyLearnedOutputCap(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  familyKey: string,
  lane: ScheduleLane,
  familyHistory: FamilyCompletionHistory | undefined,
): {
  request: NormalizedInferenceRequest;
  diagnostics: LearnedOutputCapDiagnostics;
} {
  const sampleCount = familyHistory?.completionTokens.length ?? 0;
  const percentile =
    lane === "short"
      ? config.adaptiveTuning.shortPercentile
      : config.adaptiveTuning.draftPercentile;

  if (
    !config.adaptiveTuning.learnedFamilyCapEnabled ||
    !familyHistory ||
    sampleCount < config.adaptiveTuning.learnedCapMinSamples
  ) {
    return {
      request,
      diagnostics: {
        applied: false,
        familyKey,
        lane,
        requestedMaxTokens: request.maxTokens,
        appliedMaxTokens: request.maxTokens,
        sampleCount,
        percentile,
      },
    };
  }

  const ordered = [...familyHistory.completionTokens].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * percentile)),
  );
  const learnedCapTokens =
    (ordered[index] ?? request.maxTokens) + config.adaptiveTuning.learnedCapHeadroomTokens;
  const appliedMaxTokens = clamp(
    learnedCapTokens,
    config.adaptiveTuning.minOutputTokens,
    request.maxTokens,
  );

  if (appliedMaxTokens >= request.maxTokens) {
    return {
      request,
      diagnostics: {
        applied: false,
        familyKey,
        lane,
        requestedMaxTokens: request.maxTokens,
        appliedMaxTokens: request.maxTokens,
        learnedCapTokens,
        sampleCount,
        percentile,
      },
    };
  }

  return {
    request: {
      ...request,
      maxTokens: appliedMaxTokens,
    },
    diagnostics: {
      applied: true,
      familyKey,
      lane,
      requestedMaxTokens: request.maxTokens,
      appliedMaxTokens,
      learnedCapTokens,
      sampleCount,
      percentile,
    },
  };
}

function buildUsageBreakdown(
  partial: Partial<UsageBreakdown> | undefined,
  fallback: UsageBreakdown,
): UsageBreakdown {
  const prompt = partial?.prompt ?? fallback.prompt;
  const completion = partial?.completion ?? fallback.completion;

  return {
    prompt,
    completion,
    total: partial?.total ?? prompt + completion,
  };
}

function computeUsage(
  request: NormalizedInferenceRequest,
  result: ProviderResult,
  preparation?: ProviderRequestPreparation,
): UsageStats {
  const fallbackChars = {
    prompt: request.input.length + (request.system?.length ?? 0),
    completion: result.output.length,
    total: request.input.length + (request.system?.length ?? 0) + result.output.length,
  };

  const usage: UsageStats = {
    chars: buildUsageBreakdown(result.usage?.chars, fallbackChars),
  };

  if (result.usage?.tokens) {
    usage.tokens = buildUsageBreakdown(result.usage.tokens, {
      prompt: preparation?.promptTokens ?? 0,
      completion: 0,
      total: 0,
    });
  } else if (preparation?.promptTokens !== undefined) {
    usage.tokens = {
      prompt: preparation.promptTokens,
      completion: 0,
      total: preparation.promptTokens,
    };
  }

  return usage;
}

function buildResponse(
  payload: CachedInferencePayload,
  requestId: string,
  latencyMs: number,
  queueTimeMs: number,
  cached: boolean,
  deduplicated: boolean,
  diagnostics?: InferenceDiagnostics,
): InferenceResponse {
  return {
    id: requestId,
    model: payload.model,
    output: payload.output,
    usage: payload.usage,
    cached,
    deduplicated,
    queueTimeMs,
    latencyMs,
    degraded: payload.degraded,
    ...(diagnostics ? { diagnostics } : {}),
    createdAt: new Date().toISOString(),
  };
}

function createPreparationTimeoutError(timeoutMs: number): RayError {
  return new RayError("The inference request exceeded the preparation timeout", {
    code: "request_timeout",
    status: 504,
    details: {
      phase: "prepare",
      timeoutMs,
    },
  });
}

function createProviderPreparationError(
  message: string,
  details?: Record<string, unknown>,
): RayError {
  return new RayError(`Invalid provider preparation: ${message}`, {
    code: "provider_preparation_invalid",
    status: 502,
    ...(details ? { details } : {}),
  });
}

function assertOptionalPositiveSafeInteger(
  value: unknown,
  field: string,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw createProviderPreparationError(`${field} must be a positive safe integer`, { field });
  }
}

function assertOptionalNonNegativeSafeInteger(
  value: unknown,
  field: string,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw createProviderPreparationError(`${field} must be a non-negative safe integer`, {
      field,
    });
  }
}

function assertProviderPreparationLane(value: unknown): asserts value is ScheduleLane | undefined {
  if (value === undefined) {
    return;
  }

  if (value !== "short" && value !== "draft") {
    throw createProviderPreparationError("lane must be short or draft", { field: "lane" });
  }
}

function assertProviderSlotSnapshots(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw createProviderPreparationError("slotSnapshots must be an array", {
      field: "slotSnapshots",
    });
  }

  if (value.length > MAX_PROVIDER_PREPARATION_SLOT_SNAPSHOTS) {
    throw createProviderPreparationError(
      `slotSnapshots must contain at most ${MAX_PROVIDER_PREPARATION_SLOT_SNAPSHOTS} entries`,
      {
        field: "slotSnapshots",
        maxEntries: MAX_PROVIDER_PREPARATION_SLOT_SNAPSHOTS,
        actualEntries: value.length,
      },
    );
  }

  for (const [index, slot] of value.entries()) {
    if (slot === null || typeof slot !== "object" || Array.isArray(slot)) {
      throw createProviderPreparationError(`slotSnapshots[${index}] must be an object`, {
        field: `slotSnapshots[${index}]`,
      });
    }

    const snapshot = slot as Partial<SchedulerSlotSnapshot>;
    assertOptionalNonNegativeSafeInteger(snapshot.id, `slotSnapshots[${index}].id`);
    if (snapshot.id === undefined) {
      throw createProviderPreparationError(`slotSnapshots[${index}].id is required`, {
        field: `slotSnapshots[${index}].id`,
      });
    }

    if (typeof snapshot.isProcessing !== "boolean") {
      throw createProviderPreparationError(
        `slotSnapshots[${index}].isProcessing must be a boolean`,
        {
          field: `slotSnapshots[${index}].isProcessing`,
        },
      );
    }

    if (
      typeof snapshot.updatedAt !== "string" ||
      snapshot.updatedAt.length === 0 ||
      snapshot.updatedAt.length > MAX_PROVIDER_SLOT_UPDATED_AT_CHARS
    ) {
      throw createProviderPreparationError(
        `slotSnapshots[${index}].updatedAt must be a bounded non-empty string`,
        {
          field: `slotSnapshots[${index}].updatedAt`,
          maxChars: MAX_PROVIDER_SLOT_UPDATED_AT_CHARS,
        },
      );
    }

    assertOptionalNonNegativeSafeInteger(snapshot.taskId, `slotSnapshots[${index}].taskId`);
    assertOptionalNonNegativeSafeInteger(
      snapshot.contextWindow,
      `slotSnapshots[${index}].contextWindow`,
    );
    assertOptionalNonNegativeSafeInteger(
      snapshot.promptTokens,
      `slotSnapshots[${index}].promptTokens`,
    );
    assertOptionalNonNegativeSafeInteger(
      snapshot.cacheTokens,
      `slotSnapshots[${index}].cacheTokens`,
    );
  }
}

function normalizeProviderRequestPreparation(
  value: ProviderRequestPreparation | undefined,
): ProviderRequestPreparation | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderPreparationError("prepare() must return an object");
  }

  assertOptionalPositiveSafeInteger(value.promptTokens, "promptTokens");
  assertProviderPreparationLane(value.lane);
  assertOptionalNonNegativeSafeInteger(value.preferredSlot, "preferredSlot");
  assertProviderSlotSnapshots(value.slotSnapshots);

  return value;
}

function createProviderResultError(message: string, details?: Record<string, unknown>): RayError {
  return new RayError(`Invalid provider result: ${message}`, {
    code: "provider_result_invalid",
    status: 502,
    ...(details ? { details } : {}),
  });
}

function assertOptionalProviderResultInteger(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw createProviderResultError(`${field} must be a non-negative safe integer`, { field });
  }
}

function assertOptionalProviderResultNumber(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw createProviderResultError(`${field} must be a non-negative finite number`, { field });
  }
}

function assertProviderUsageBreakdown(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderResultError(`${field} must be an object`, { field });
  }

  const breakdown = value as Partial<UsageBreakdown>;
  assertOptionalProviderResultNumber(breakdown.prompt, `${field}.prompt`);
  assertOptionalProviderResultNumber(breakdown.completion, `${field}.completion`);
  assertOptionalProviderResultNumber(breakdown.total, `${field}.total`);
}

function assertProviderUsage(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderResultError("usage must be an object", { field: "usage" });
  }

  const usage = value as PartialUsageStats;
  assertProviderUsageBreakdown(usage.chars, "usage.chars");
  assertProviderUsageBreakdown(usage.tokens, "usage.tokens");
}

function assertProviderDiagnostics(value: unknown): void {
  if (value === undefined) {
    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderResultError("diagnostics must be an object", { field: "diagnostics" });
  }

  const diagnostics = value as ProviderDiagnostics;
  for (const field of providerDiagnosticIntegerFields) {
    assertOptionalProviderResultInteger(diagnostics[field], `diagnostics.${field}`);
  }

  if (diagnostics.timings !== undefined) {
    if (
      diagnostics.timings === null ||
      typeof diagnostics.timings !== "object" ||
      Array.isArray(diagnostics.timings)
    ) {
      throw createProviderResultError("diagnostics.timings must be an object", {
        field: "diagnostics.timings",
      });
    }

    for (const field of providerTimingFields) {
      assertOptionalProviderResultNumber(
        diagnostics.timings[field],
        `diagnostics.timings.${field}`,
      );
    }
  }
}

function normalizeProviderResult(value: ProviderResult): ProviderResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderResultError("provider infer() must return an object");
  }

  if (typeof value.output !== "string") {
    throw createProviderResultError("output must be a string", { field: "output" });
  }

  assertProviderUsage(value.usage);
  assertProviderDiagnostics(value.diagnostics);

  return value;
}

function createProviderHealthError(message: string, details?: Record<string, unknown>): RayError {
  return new RayError(`Invalid provider health: ${message}`, {
    code: "provider_health_invalid",
    status: 502,
    ...(details ? { details } : {}),
  });
}

function truncateProviderHealthString(
  value: string,
  maxChars = MAX_PROVIDER_HEALTH_DETAIL_STRING_CHARS,
): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function truncateProviderHealthKey(value: string): string {
  if (value.length <= MAX_PROVIDER_HEALTH_DETAIL_KEY_CHARS) {
    return value;
  }

  let headChars = MAX_PROVIDER_HEALTH_DETAIL_KEY_CHARS;

  for (;;) {
    const omittedChars = value.length - headChars;
    const suffix = `...[truncated ${omittedChars} chars]`;
    const nextHeadChars = MAX_PROVIDER_HEALTH_DETAIL_KEY_CHARS - suffix.length;

    if (nextHeadChars <= 0) {
      return suffix.slice(0, MAX_PROVIDER_HEALTH_DETAIL_KEY_CHARS);
    }

    if (nextHeadChars === headChars) {
      return `${value.slice(0, headChars)}${suffix}`;
    }

    headChars = nextHeadChars;
  }
}

function assertProviderHealthString(
  value: unknown,
  field: string,
  maxChars: number,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw createProviderHealthError(`${field} must be a bounded non-empty string`, {
      field,
      maxChars,
    });
  }
}

function normalizeProviderHealthStatus(value: unknown): ProviderHealthSnapshot["status"] {
  if (
    typeof value === "string" &&
    providerHealthStatuses.has(value as ProviderHealthSnapshot["status"])
  ) {
    return value as ProviderHealthSnapshot["status"];
  }

  throw createProviderHealthError("status must be a valid provider health status", {
    field: "status",
  });
}

function normalizeProviderHealthLatency(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw createProviderHealthError("latencyMs must be a non-negative finite number", {
      field: "latencyMs",
    });
  }

  return value;
}

function normalizeProviderHealthInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw createProviderHealthError(`${field} must be a non-negative safe integer`, { field });
  }

  return value;
}

function normalizeProviderCapabilityStatus(
  value: unknown,
  field: string,
): ProviderDetectedCapabilities["applyTemplate"] {
  if (value === "available" || value === "unavailable" || value === "unknown") {
    return value;
  }

  throw createProviderHealthError(`${field} must be available, unavailable, or unknown`, {
    field,
  });
}

function normalizeOptionalProviderHealthString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw createProviderHealthError(`${field} must be a bounded non-empty string`, {
      field,
      maxChars: MAX_PROVIDER_HEALTH_STRING_CHARS,
    });
  }

  return truncateProviderHealthString(value, MAX_PROVIDER_HEALTH_STRING_CHARS);
}

function snapshotProviderHealthDetail(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateProviderHealthString(value);
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

  if (depth >= MAX_PROVIDER_HEALTH_DETAIL_DEPTH) {
    return "[Truncated]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (value instanceof Error) {
    const snapshot: Record<string, unknown> = {
      name: truncateProviderHealthString(value.name),
      message: truncateProviderHealthString(value.message),
    };

    if (value.stack) {
      snapshot.stack = truncateProviderHealthString(value.stack);
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
        .slice(0, MAX_PROVIDER_HEALTH_DETAIL_ARRAY_ITEMS)
        .map((entry) => snapshotProviderHealthDetail(entry, seen, depth + 1));

      if (value.length > MAX_PROVIDER_HEALTH_DETAIL_ARRAY_ITEMS) {
        items.push(`[Truncated ${value.length - MAX_PROVIDER_HEALTH_DETAIL_ARRAY_ITEMS} items]`);
      }

      return items;
    }

    const output: Record<string, unknown> = {};
    let keys: string[];

    try {
      keys = Object.keys(value);
    } catch (error) {
      return `[Unserializable object: ${truncateProviderHealthString(toErrorMessage(error))}]`;
    }

    for (const key of keys.slice(0, MAX_PROVIDER_HEALTH_DETAIL_OBJECT_KEYS)) {
      const safeKey = truncateProviderHealthKey(key);

      try {
        output[safeKey] = snapshotProviderHealthDetail(
          (value as Record<string, unknown>)[key],
          seen,
          depth + 1,
        );
      } catch (error) {
        output[safeKey] = `[Thrown: ${truncateProviderHealthString(toErrorMessage(error))}]`;
      }
    }

    if (keys.length > MAX_PROVIDER_HEALTH_DETAIL_OBJECT_KEYS) {
      output.__truncatedKeys = keys.length - MAX_PROVIDER_HEALTH_DETAIL_OBJECT_KEYS;
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function snapshotProviderHealthDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const snapshot = snapshotProviderHealthDetail(value, new WeakSet());

  if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    return snapshot as Record<string, unknown>;
  }

  return { value: snapshot };
}

function normalizeProviderCapabilityErrors(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value).slice(0, MAX_PROVIDER_CAPABILITY_ERRORS);
  } catch {
    return undefined;
  }

  if (entries.length === 0) {
    return undefined;
  }

  const errors: Record<string, string> = {};

  for (const [key, entry] of entries) {
    if (typeof entry !== "string") {
      continue;
    }

    errors[truncateProviderHealthKey(key)] = truncateProviderHealthString(entry);
  }

  return Object.keys(errors).length > 0 ? errors : undefined;
}

function normalizeProviderDetectedCapabilities(
  value: unknown,
): ProviderDetectedCapabilities | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderHealthError("detectedCapabilities must be an object", {
      field: "detectedCapabilities",
    });
  }

  const capabilities = value as Partial<ProviderDetectedCapabilities>;
  const promptFormatPreference = capabilities.promptFormatPreference;

  if (
    promptFormatPreference !== undefined &&
    promptFormatPreference !== "native-template" &&
    promptFormatPreference !== "openai-chat" &&
    promptFormatPreference !== "plain-completion"
  ) {
    throw createProviderHealthError(
      "detectedCapabilities.promptFormatPreference must be a supported prompt format",
      { field: "detectedCapabilities.promptFormatPreference" },
    );
  }

  const errors = normalizeProviderCapabilityErrors(capabilities.errors);
  const modelRef = normalizeOptionalProviderHealthString(
    capabilities.modelRef,
    "detectedCapabilities.modelRef",
  );
  const backendModel = normalizeOptionalProviderHealthString(
    capabilities.backendModel,
    "detectedCapabilities.backendModel",
  );
  const launchPreset = normalizeOptionalProviderHealthString(
    capabilities.launchPreset,
    "detectedCapabilities.launchPreset",
  );
  const contextWindow = normalizeProviderHealthInteger(
    capabilities.contextWindow,
    "detectedCapabilities.contextWindow",
  );
  const totalSlots = normalizeProviderHealthInteger(
    capabilities.totalSlots,
    "detectedCapabilities.totalSlots",
  );

  return {
    applyTemplate: normalizeProviderCapabilityStatus(
      capabilities.applyTemplate,
      "detectedCapabilities.applyTemplate",
    ),
    chatTemplate: normalizeProviderCapabilityStatus(
      capabilities.chatTemplate,
      "detectedCapabilities.chatTemplate",
    ),
    jsonMode: normalizeProviderCapabilityStatus(
      capabilities.jsonMode,
      "detectedCapabilities.jsonMode",
    ),
    ...(modelRef !== undefined ? { modelRef } : {}),
    ...(backendModel !== undefined ? { backendModel } : {}),
    ...(launchPreset !== undefined ? { launchPreset } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(totalSlots !== undefined ? { totalSlots } : {}),
    ...(promptFormatPreference !== undefined ? { promptFormatPreference } : {}),
    ...(errors ? { errors } : {}),
  };
}

function normalizeProviderHealthSnapshot(value: unknown): ProviderHealthSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw createProviderHealthError("provider health() must return an object");
  }

  const snapshot = value as Partial<ProviderHealthSnapshot>;
  assertProviderHealthString(snapshot.checkedAt, "checkedAt", MAX_PROVIDER_HEALTH_CHECKED_AT_CHARS);

  const latencyMs = normalizeProviderHealthLatency(snapshot.latencyMs);
  const detectedCapabilities = normalizeProviderDetectedCapabilities(snapshot.detectedCapabilities);
  const details = snapshotProviderHealthDetails(snapshot.details);

  return {
    status: normalizeProviderHealthStatus(snapshot.status),
    checkedAt: snapshot.checkedAt,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(detectedCapabilities ? { detectedCapabilities } : {}),
    ...(details ? { details } : {}),
  };
}

export class RayRuntime {
  readonly logger: Logger;
  readonly metrics: RuntimeMetrics;
  readonly provider: ModelProvider;
  readonly scheduler: RequestScheduler<ProviderResult>;
  readonly cache: TtlCache<CachedInferencePayload>;
  private readonly recentAdaptiveSamples: AdaptiveSample[] = [];
  private readonly familyCompletionHistory = new Map<string, FamilyCompletionHistory>();
  private readonly startedAt = Date.now();
  private warmState: WarmState = "idle";
  private lastWarmError: string | undefined;
  private providerHealthCache: CachedProviderHealth | undefined;
  private providerHealthInFlight: Promise<ProviderHealthSnapshot> | undefined;
  private activePreparations = 0;
  private readonly preparationQueue: PreparationQueueEntry[] = [];
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly cgroupMemory: CgroupMemoryReader | undefined;
  private readonly cgroupCpu: CgroupCpuReader | undefined;
  private cgroupMemoryCache:
    | {
        checkedAtMs: number;
        snapshot: CgroupMemorySnapshot | undefined;
      }
    | undefined;
  private cgroupCpuCache:
    | {
        checkedAtMs: number;
        snapshot: CgroupCpuSnapshot | undefined;
      }
    | undefined;

  readonly config: RayConfig;

  constructor(config: RayConfig, options: CreateRayRuntimeOptions = {}) {
    this.config = snapshotRayConfig(config);
    this.provider = options.provider ?? createModelProvider(this.config.model);
    this.logger =
      options.logger ??
      new Logger(this.config.telemetry.serviceName, this.config.telemetry.logLevel);
    this.metrics = options.metrics ?? new RuntimeMetrics();
    this.scheduler =
      options.scheduler ?? new RequestScheduler<ProviderResult>(this.config.scheduler);
    this.cache =
      options.cache ??
      new TtlCache<CachedInferencePayload>({
        maxEntries: this.config.cache.maxEntries,
        ttlMs: this.config.cache.ttlMs,
      });
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage;
    this.cgroupMemory =
      options.cgroupMemory === false
        ? undefined
        : (options.cgroupMemory ?? (() => readCgroupMemorySnapshot()));
    this.cgroupCpu =
      options.cgroupCpu === false
        ? undefined
        : (options.cgroupCpu ?? (() => readCgroupCpuSnapshot()));
  }

  async warm(): Promise<void> {
    if (!this.config.model.warmOnBoot || !this.provider.warm) {
      this.warmState = "ready";
      return;
    }

    this.warmState = "warming";

    try {
      await this.provider.warm();
      this.warmState = "ready";
      this.lastWarmError = undefined;
      this.providerHealthCache = {
        checkedAtMs: Date.now(),
        snapshot: {
          status: "ready",
          checkedAt: new Date().toISOString(),
          details: {
            source: "warm",
          },
        },
      };

      this.logger.info("provider warmed", {
        modelId: this.provider.modelId,
      });
    } catch (error) {
      this.warmState = "failed";
      this.lastWarmError = toErrorMessage(error);
      this.providerHealthCache = {
        checkedAtMs: Date.now(),
        snapshot: {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          details: {
            source: "warm",
            message: this.lastWarmError,
          },
        },
      };
      throw error;
    }
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const startedAt = Date.now();
    const requestId = createRequestId("req");
    const queueSnapshot = this.scheduler.snapshot();
    const normalized = normalizeInferenceRequest(this.config, request);
    const promptLengthDegraded = applyPromptLengthDegradation(this.config, normalized);
    const compiled = compilePrompt(this.config, promptLengthDegraded.request);
    const learnedCap = applyLearnedOutputCap(
      this.config,
      compiled.request,
      compiled.affinityKey,
      compiled.lane,
      this.familyCompletionHistory.get(compiled.affinityKey),
    );
    const queueDepthDegraded = applyQueueDepthDegradation(
      this.config,
      learnedCap.request,
      queueSnapshot.queueDepth,
    );
    const [memoryPressure, cgroupCpu] = await Promise.all([
      this.getMemoryPressureSnapshot(),
      this.getCgroupCpuSnapshot(),
    ]);
    const memoryPressureSources = resolveMemoryPressureSources(this.config, memoryPressure);
    const memoryPressureDegraded = applyMemoryPressureDegradation(
      this.config,
      queueDepthDegraded.request,
      memoryPressureSources,
    );
    const cpuPressureDegraded = applyCpuPressureDegradation(
      this.config,
      memoryPressureDegraded.request,
      cgroupCpu,
    );
    const degraded = {
      request: cpuPressureDegraded.request,
      degraded:
        promptLengthDegraded.degraded ||
        queueDepthDegraded.degraded ||
        memoryPressureDegraded.degraded ||
        cpuPressureDegraded.degraded,
    };
    const tuned = applyAdaptiveTuning(this.config, degraded.request, this.recentAdaptiveSamples);
    const runtimeDiagnostics: InferenceDiagnostics = {
      degradation: buildDegradationDiagnostics({
        promptLengthDegraded: promptLengthDegraded.degraded,
        queueDepthDegraded: queueDepthDegraded.degraded,
        memoryPressureDegraded: memoryPressureDegraded.degraded,
        cpuPressureDegraded: cpuPressureDegraded.degraded,
        requestedMaxTokens: learnedCap.request.maxTokens,
        appliedMaxTokens: degraded.request.maxTokens,
        queueDepth: queueSnapshot.queueDepth,
        queueDepthThreshold: this.config.gracefulDegradation.queueDepthThreshold,
        memoryPressureSources,
        memoryPressure,
        cgroupCpu,
        memoryRssThresholdMiB: this.config.gracefulDegradation.memoryRssThresholdMiB,
        cpuThrottledRatioThreshold: this.config.gracefulDegradation.cpuThrottledRatioThreshold,
      }),
      promptCompiler: compiled.diagnostics,
      learnedOutputCap: learnedCap.diagnostics,
      adaptiveTuning: tuned.diagnostics,
      taskRouting: resolveTaskRoutingDiagnostics(this.config, tuned.request),
    };
    const cacheKey =
      this.config.cache.enabled && tuned.request.cache
        ? buildCacheKey(this.config, tuned.request)
        : undefined;

    this.recordSchedulerMetrics(queueSnapshot);
    this.recordMemoryPressureMetrics(memoryPressure, memoryPressureSources);
    this.recordCgroupCpuMetrics(cgroupCpu);
    this.metrics.gauge("prompt.compiler.chars_saved", compiled.diagnostics.charsSaved);
    this.metrics.gauge(
      "learned_output_cap.max_tokens_ratio",
      learnedCap.request.maxTokens / Math.max(1, learnedCap.diagnostics.requestedMaxTokens),
    );
    this.metrics.gauge(
      "adaptive.max_tokens_ratio",
      tuned.request.maxTokens / Math.max(1, tuned.diagnostics.requestedMaxTokens),
    );

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);

      if (cached) {
        const latencyMs = Date.now() - startedAt;
        this.metrics.recordRequest(latencyMs, {
          cached: true,
          degraded: cached.degraded,
        });
        this.recordCacheMetrics();

        return buildResponse(cached, requestId, latencyMs, 0, true, false, {
          ...runtimeDiagnostics,
          ...(cached.providerDiagnostics ? { provider: cached.providerDiagnostics } : {}),
        });
      }
    }

    try {
      const preparation = await this.prepareRequest(
        tuned.request,
        requestId,
        startedAt,
        compiled.affinityKey,
        compiled.lane,
      );

      if (preparation?.slotSnapshots) {
        this.scheduler.updateBackendSlots(preparation.slotSnapshots);
        this.recordProviderMetrics(undefined, preparation.promptTokens, preparation.slotSnapshots);
      }

      const requestForProvider = preparation?.request ?? tuned.request;
      const providerContextBase = {
        requestId,
        config: this.config,
        startedAt,
        affinityKey: compiled.affinityKey,
        lane: preparation?.lane ?? compiled.lane,
        ...(preparation ? { preparation } : {}),
      };
      const handler = (signal: AbortSignal) =>
        this.provider.infer(requestForProvider, {
          signal,
          ...providerContextBase,
        });
      const promptTokens =
        preparation?.promptTokens ??
        Math.max(1, estimateRequestTokens(requestForProvider) - requestForProvider.maxTokens);
      const requestCostTokens = promptTokens + requestForProvider.maxTokens;
      const dedupeKey = requestForProvider.dedupeKey ?? cacheKey;
      const scheduled = await this.scheduler.schedule(
        dedupeKey
          ? {
              key: dedupeKey,
              affinityKey: preparation?.affinityKey ?? compiled.affinityKey,
              lane: preparation?.lane ?? compiled.lane,
              costTokens: requestCostTokens,
              handler,
              ...(preparation?.preferredSlot !== undefined
                ? { preferredSlot: preparation.preferredSlot }
                : {}),
            }
          : {
              affinityKey: preparation?.affinityKey ?? compiled.affinityKey,
              lane: preparation?.lane ?? compiled.lane,
              costTokens: requestCostTokens,
              handler,
              ...(preparation?.preferredSlot !== undefined
                ? { preferredSlot: preparation.preferredSlot }
                : {}),
            },
      );
      const providerResult = normalizeProviderResult(scheduled.value);
      const normalizedScheduled = {
        ...scheduled,
        value: providerResult,
      };

      const payload = this.toCachedPayload(
        normalizedScheduled,
        requestForProvider,
        degraded.degraded,
        preparation,
      );
      const latencyMs = Date.now() - startedAt;

      if (cacheKey) {
        this.cache.set(cacheKey, payload);
      }

      this.metrics.recordRequest(latencyMs, {
        cached: false,
        degraded: degraded.degraded,
      });
      const currentSnapshot = this.scheduler.snapshot();
      this.recordSchedulerMetrics(currentSnapshot);
      this.recordCacheMetrics();
      this.recordProviderMetrics(
        payload.providerDiagnostics,
        payload.usage.tokens?.prompt ?? preparation?.promptTokens,
        preparation?.slotSnapshots,
      );
      this.metrics.gauge("queue.last_delay_ms", scheduled.queueTimeMs);

      this.recordAdaptiveSample(scheduled.queueTimeMs, providerResult.diagnostics);
      this.recordFamilyCompletion(
        compiled.affinityKey,
        compiled.lane,
        this.resolveCompletionTokens(payload.usage),
      );

      if (latencyMs >= this.config.telemetry.slowRequestThresholdMs) {
        this.logger.warn("slow inference request", {
          requestId,
          latencyMs,
          queueTimeMs: scheduled.queueTimeMs,
          modelId: this.provider.modelId,
        });
      }

      return buildResponse(
        payload,
        requestId,
        latencyMs,
        scheduled.queueTimeMs,
        false,
        scheduled.deduplicated,
        {
          ...runtimeDiagnostics,
          ...(payload.providerDiagnostics ? { provider: payload.providerDiagnostics } : {}),
        },
      );
    } catch (error) {
      this.metrics.recordError();
      this.logger.error("inference failed", {
        requestId,
        error: serializeError(error),
      });

      throw error;
    }
  }

  async health(): Promise<HealthSnapshot> {
    const snapshot = this.scheduler.snapshot();
    const preparationSnapshot = this.preparationSnapshot();
    const [provider, memoryPressure, cgroupCpu] = await Promise.all([
      this.getProviderHealth(),
      this.getMemoryPressureSnapshot(),
      this.getCgroupCpuSnapshot(),
    ]);
    const memoryPressureSources = resolveMemoryPressureSources(this.config, memoryPressure);
    const queueDegraded =
      snapshot.queueDepth >= this.config.gracefulDegradation.queueDepthThreshold;
    const memoryDegraded = memoryPressureSources.length > 0;
    const cpuDegraded = resolveCgroupCpuPressure(this.config, cgroupCpu);
    const runtimeHealth = buildRuntimeHealthDiagnostics({
      queueDegraded,
      queueSnapshot: snapshot,
      queueDepthThreshold: this.config.gracefulDegradation.queueDepthThreshold,
      preparationSnapshot,
      memoryPressureSources,
      memoryPressure,
      memoryRssThresholdMiB: this.config.gracefulDegradation.memoryRssThresholdMiB,
      cpuDegraded,
      cpuThrottledRatioThreshold: this.config.gracefulDegradation.cpuThrottledRatioThreshold,
      cgroupCpu,
    });
    this.recordMemoryPressureMetrics(memoryPressure, memoryPressureSources);
    this.recordCgroupCpuMetrics(cgroupCpu);
    const status =
      provider.status === "unavailable"
        ? "unavailable"
        : provider.status === "degraded" ||
            provider.status === "warming" ||
            queueDegraded ||
            memoryDegraded ||
            cpuDegraded
          ? "degraded"
          : "ok";

    return {
      status,
      uptimeMs: Date.now() - this.startedAt,
      queueDepth: snapshot.queueDepth,
      inFlight: snapshot.inFlight,
      cacheEntries: this.cache.size(),
      profile: this.config.profile,
      modelId: this.provider.modelId,
      provider,
      runtime: runtimeHealth,
    };
  }

  schedulerSnapshot(): SchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  async collectMetricsSnapshot(): Promise<RuntimeMetricsSnapshot> {
    const queueSnapshot = this.scheduler.snapshot();
    const preparationSnapshot = this.preparationSnapshot();
    const [memoryPressure, cgroupCpu] = await Promise.all([
      this.getMemoryPressureSnapshot(),
      this.getCgroupCpuSnapshot(),
    ]);
    const memoryPressureSources = resolveMemoryPressureSources(this.config, memoryPressure);

    this.recordSchedulerMetrics(queueSnapshot);
    this.recordPreparationMetrics(preparationSnapshot);
    this.recordMemoryPressureMetrics(memoryPressure, memoryPressureSources);
    this.recordCgroupCpuMetrics(cgroupCpu);
    this.recordCacheMetrics();

    return this.metricsSnapshot();
  }

  metricsSnapshot(): RuntimeMetricsSnapshot {
    return this.metrics.snapshot(this.config.telemetry.includeDebugMetrics);
  }

  sanitizedConfig(): Record<string, unknown> {
    return sanitizeConfig(this.config);
  }

  private preparationSnapshot(): PreparationSnapshot {
    return {
      active: this.activePreparations,
      concurrency: this.config.scheduler.concurrency,
      activeRatio: resolveSaturationRatio(
        this.activePreparations,
        this.config.scheduler.concurrency,
      ),
      queued: this.preparationQueue.length,
      maxQueue: this.config.scheduler.maxQueue,
      queuedRatio: resolveSaturationRatio(
        this.preparationQueue.length,
        this.config.scheduler.maxQueue,
      ),
    };
  }

  private async getProviderHealth(): Promise<ProviderHealthSnapshot> {
    const now = Date.now();

    if (this.provider.health) {
      if (this.providerHealthCache && now - this.providerHealthCache.checkedAtMs < 1_000) {
        return this.providerHealthCache.snapshot;
      }

      if (this.providerHealthInFlight) {
        return this.providerHealthInFlight;
      }

      const healthPromise = this.refreshProviderHealth();
      this.providerHealthInFlight = healthPromise;

      try {
        return await healthPromise;
      } finally {
        if (this.providerHealthInFlight === healthPromise) {
          this.providerHealthInFlight = undefined;
        }
      }
    }

    const snapshot: ProviderHealthSnapshot =
      this.warmState === "failed"
        ? {
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            ...(this.lastWarmError
              ? {
                  details: {
                    message: this.lastWarmError,
                  },
                }
              : {}),
          }
        : this.warmState === "warming"
          ? {
              status: "warming",
              checkedAt: new Date().toISOString(),
            }
          : this.warmState === "ready"
            ? {
                status: "ready",
                checkedAt: new Date().toISOString(),
              }
            : {
                status: "unknown",
                checkedAt: new Date().toISOString(),
              };

    this.metrics.recordProviderHealth(snapshot);
    return snapshot;
  }

  private async refreshProviderHealth(): Promise<ProviderHealthSnapshot> {
    try {
      const rawSnapshot = await this.provider.health?.();

      if (rawSnapshot) {
        const snapshot = normalizeProviderHealthSnapshot(rawSnapshot);
        this.providerHealthCache = {
          checkedAtMs: Date.now(),
          snapshot,
        };
        this.metrics.recordProviderHealth(snapshot);
        return snapshot;
      }
    } catch (error) {
      const snapshot: ProviderHealthSnapshot = {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        details: {
          message: toErrorMessage(error),
        },
      };
      this.providerHealthCache = {
        checkedAtMs: Date.now(),
        snapshot,
      };
      this.metrics.recordProviderHealth(snapshot);
      return snapshot;
    }

    const snapshot: ProviderHealthSnapshot = {
      status: "unknown",
      checkedAt: new Date().toISOString(),
    };
    this.providerHealthCache = {
      checkedAtMs: Date.now(),
      snapshot,
    };
    this.metrics.recordProviderHealth(snapshot);
    return snapshot;
  }

  private toCachedPayload(
    scheduled: ScheduledTaskResult<ProviderResult>,
    request: NormalizedInferenceRequest,
    degraded: boolean,
    preparation?: ProviderRequestPreparation,
  ): CachedInferencePayload {
    return {
      model: this.provider.modelId,
      output: scheduled.value.output,
      usage: computeUsage(request, scheduled.value, preparation),
      degraded,
      ...(scheduled.value.diagnostics ? { providerDiagnostics: scheduled.value.diagnostics } : {}),
    };
  }

  private async prepareRequest(
    request: NormalizedInferenceRequest,
    requestId: string,
    startedAt: number,
    affinityKey: string,
    lane: ScheduleLane,
  ): Promise<ProviderRequestPreparation | undefined> {
    if (!this.provider.prepare) {
      return undefined;
    }

    const releasePreparationSlot = await this.acquirePreparationSlot(startedAt);
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;

    try {
      const remainingTimeoutMs = this.config.scheduler.requestTimeoutMs - (Date.now() - startedAt);

      if (remainingTimeoutMs <= 0) {
        throw createPreparationTimeoutError(this.config.scheduler.requestTimeoutMs);
      }

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = createPreparationTimeoutError(this.config.scheduler.requestTimeoutMs);
          controller.abort(error);
          reject(error);
        }, remainingTimeoutMs);
      });
      const preparationPromise = this.provider.prepare(request, {
        signal: controller.signal,
        requestId,
        config: this.config,
        startedAt,
        affinityKey,
        lane,
      });

      void preparationPromise.catch(() => undefined);

      return normalizeProviderRequestPreparation(
        await Promise.race([preparationPromise, timeoutPromise]),
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      releasePreparationSlot();
    }
  }

  private async acquirePreparationSlot(startedAt: number): Promise<() => void> {
    const remainingTimeoutMs = this.config.scheduler.requestTimeoutMs - (Date.now() - startedAt);

    if (remainingTimeoutMs <= 0) {
      throw createPreparationTimeoutError(this.config.scheduler.requestTimeoutMs);
    }

    if (this.activePreparations < this.config.scheduler.concurrency) {
      this.activePreparations += 1;
      return this.createPreparationRelease();
    }

    if (this.preparationQueue.length >= this.config.scheduler.maxQueue) {
      throw new RayError("The preparation queue is full", {
        code: "queue_full",
        status: 503,
        details: {
          phase: "prepare",
          activePreparations: this.activePreparations,
          queuedPreparations: this.preparationQueue.length,
          concurrency: this.config.scheduler.concurrency,
          maxQueue: this.config.scheduler.maxQueue,
        },
      });
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: PreparationQueueEntry = {
        timeout: setTimeout(() => {
          const index = this.preparationQueue.indexOf(entry);
          if (index !== -1) {
            this.preparationQueue.splice(index, 1);
          }

          reject(createPreparationTimeoutError(this.config.scheduler.requestTimeoutMs));
        }, remainingTimeoutMs),
        resolve,
        reject,
      };
      this.preparationQueue.push(entry);
    });
  }

  private createPreparationRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.activePreparations -= 1;
      this.drainPreparationQueue();
    };
  }

  private drainPreparationQueue(): void {
    while (
      this.activePreparations < this.config.scheduler.concurrency &&
      this.preparationQueue.length > 0
    ) {
      const entry = this.preparationQueue.shift();
      if (!entry) {
        return;
      }

      clearTimeout(entry.timeout);
      this.activePreparations += 1;
      entry.resolve(this.createPreparationRelease());
    }
  }

  private recordAdaptiveSample(
    queueTimeMs: number,
    diagnostics: ProviderDiagnostics | undefined,
  ): void {
    this.recentAdaptiveSamples.push({
      queueTimeMs,
      ...(typeof diagnostics?.timings?.completionTokensPerSecond === "number"
        ? { completionTokensPerSecond: diagnostics.timings.completionTokensPerSecond }
        : {}),
    });

    while (this.recentAdaptiveSamples.length > this.config.adaptiveTuning.sampleSize) {
      this.recentAdaptiveSamples.shift();
    }
  }

  private recordFamilyCompletion(
    familyKey: string,
    lane: ScheduleLane,
    completionTokens: number,
  ): void {
    if (!Number.isFinite(completionTokens) || completionTokens <= 0) {
      return;
    }

    const existing = this.familyCompletionHistory.get(familyKey) ?? {
      lane,
      completionTokens: [],
    };
    existing.lane = lane;
    existing.completionTokens.push(completionTokens);

    while (existing.completionTokens.length > this.config.adaptiveTuning.familyHistorySize) {
      existing.completionTokens.shift();
    }

    this.familyCompletionHistory.delete(familyKey);
    this.familyCompletionHistory.set(familyKey, existing);

    while (this.familyCompletionHistory.size > MAX_LEARNED_FAMILY_HISTORY_KEYS) {
      const oldestFamilyKey = this.familyCompletionHistory.keys().next().value;

      if (oldestFamilyKey === undefined) {
        break;
      }

      this.familyCompletionHistory.delete(oldestFamilyKey);
    }
  }

  private resolveCompletionTokens(usage: UsageStats): number {
    if (typeof usage.tokens?.completion === "number" && usage.tokens.completion > 0) {
      return usage.tokens.completion;
    }

    return Math.max(1, Math.ceil(usage.chars.completion / 4));
  }

  private recordSchedulerMetrics(snapshot: SchedulerSnapshot): void {
    this.metrics.gauge("queue.depth", snapshot.queueDepth);
    this.metrics.gauge("queue.short_depth", snapshot.shortQueueDepth);
    this.metrics.gauge("queue.draft_depth", snapshot.draftQueueDepth);
    this.metrics.gauge("queue.max_depth", snapshot.maxQueue);
    this.metrics.gauge("queue.depth_ratio", snapshot.queueDepth / Math.max(1, snapshot.maxQueue));
    this.metrics.gauge("inference.in_flight", snapshot.inFlight);
    this.metrics.gauge("inference.concurrency", snapshot.concurrency);
    this.metrics.gauge(
      "inference.in_flight_ratio",
      snapshot.inFlight / Math.max(1, snapshot.concurrency),
    );
    this.metrics.gauge("queue.tokens", snapshot.queuedTokens);
    this.metrics.gauge("queue.max_tokens", snapshot.maxQueuedTokens);
    this.metrics.gauge(
      "queue.tokens_ratio",
      snapshot.queuedTokens / Math.max(1, snapshot.maxQueuedTokens),
    );
    this.metrics.gauge("inference.in_flight_tokens", snapshot.inFlightTokens);
    this.metrics.gauge("inference.max_inflight_tokens", snapshot.maxInflightTokens);
    this.metrics.gauge(
      "inference.in_flight_tokens_ratio",
      snapshot.inFlightTokens / Math.max(1, snapshot.maxInflightTokens),
    );
  }

  private recordPreparationMetrics(snapshot: PreparationSnapshot): void {
    this.metrics.gauge("preparation.active", snapshot.active);
    this.metrics.gauge("preparation.concurrency", snapshot.concurrency);
    this.metrics.gauge("preparation.active_ratio", snapshot.activeRatio);
    this.metrics.gauge("preparation.queued", snapshot.queued);
    this.metrics.gauge("preparation.max_queue", snapshot.maxQueue);
    this.metrics.gauge("preparation.queued_ratio", snapshot.queuedRatio);
  }

  private recordCacheMetrics(): void {
    const entries = this.cache.size();
    const maxEntries = this.config.cache.maxEntries;

    this.metrics.gauge("cache.entries", entries);
    this.metrics.gauge("cache.max_entries", maxEntries);
    this.metrics.gauge("cache.entries_ratio", entries / Math.max(1, maxEntries));
  }

  private getProcessRssMiB(): number {
    try {
      const rss = this.memoryUsage().rss;
      return Number.isFinite(rss) && rss > 0 ? bytesToMiB(rss) : 0;
    } catch {
      return 0;
    }
  }

  private async getMemoryPressureSnapshot(): Promise<MemoryPressureSnapshot> {
    const processRssMiB = this.getProcessRssMiB();
    const cgroupMemory = await this.getCgroupMemorySnapshot();

    return {
      processRssMiB,
      ...(cgroupMemory
        ? {
            cgroupMemoryCurrentMiB: cgroupMemory.currentMiB,
            ...(cgroupMemory.highMiB !== undefined
              ? { cgroupMemoryHighMiB: cgroupMemory.highMiB }
              : {}),
            ...(cgroupMemory.limitMiB !== undefined
              ? { cgroupMemoryLimitMiB: cgroupMemory.limitMiB }
              : {}),
            ...(cgroupMemory.pressureRatio !== undefined
              ? { cgroupMemoryPressureRatio: cgroupMemory.pressureRatio }
              : {}),
            ...(cgroupMemory.highEvents !== undefined
              ? { cgroupMemoryHighEvents: cgroupMemory.highEvents }
              : {}),
            ...(cgroupMemory.maxEvents !== undefined
              ? { cgroupMemoryMaxEvents: cgroupMemory.maxEvents }
              : {}),
            ...(cgroupMemory.oomEvents !== undefined
              ? { cgroupMemoryOomEvents: cgroupMemory.oomEvents }
              : {}),
            ...(cgroupMemory.oomKillEvents !== undefined
              ? { cgroupMemoryOomKillEvents: cgroupMemory.oomKillEvents }
              : {}),
          }
        : {}),
    };
  }

  private async getCgroupMemorySnapshot(): Promise<CgroupMemorySnapshot | undefined> {
    if (!this.cgroupMemory) {
      return undefined;
    }

    const now = Date.now();

    if (
      this.cgroupMemoryCache &&
      now - this.cgroupMemoryCache.checkedAtMs < CGROUP_MEMORY_CACHE_TTL_MS
    ) {
      return this.cgroupMemoryCache.snapshot;
    }

    try {
      const snapshot = await this.cgroupMemory();
      this.cgroupMemoryCache = {
        checkedAtMs: now,
        snapshot,
      };
      return snapshot;
    } catch {
      this.cgroupMemoryCache = {
        checkedAtMs: now,
        snapshot: undefined,
      };
      return undefined;
    }
  }

  private async getCgroupCpuSnapshot(): Promise<CgroupCpuSnapshot | undefined> {
    if (!this.cgroupCpu) {
      return undefined;
    }

    const now = Date.now();

    if (this.cgroupCpuCache && now - this.cgroupCpuCache.checkedAtMs < CGROUP_CPU_CACHE_TTL_MS) {
      return this.cgroupCpuCache.snapshot;
    }

    try {
      const snapshot = applyRecentCgroupCpuThrottlingRatio(
        await this.cgroupCpu(),
        this.cgroupCpuCache?.snapshot,
      );
      this.cgroupCpuCache = {
        checkedAtMs: now,
        snapshot,
      };
      return snapshot;
    } catch {
      this.cgroupCpuCache = {
        checkedAtMs: now,
        snapshot: undefined,
      };
      return undefined;
    }
  }

  private recordCgroupCpuMetrics(snapshot: CgroupCpuSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }

    if (snapshot.usageUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_usage_usec", snapshot.usageUsec);
    }
    if (snapshot.userUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_user_usec", snapshot.userUsec);
    }
    if (snapshot.systemUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_system_usec", snapshot.systemUsec);
    }
    if (snapshot.quotaUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_quota_usec", snapshot.quotaUsec);
    }
    if (snapshot.periodUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_period_usec", snapshot.periodUsec);
    }
    if (snapshot.quotaCores !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_quota_cores", snapshot.quotaCores);
    }
    if (snapshot.periods !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_periods", snapshot.periods);
    }
    if (snapshot.throttledPeriods !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_throttled_periods", snapshot.throttledPeriods);
    }
    if (snapshot.throttledUsec !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_throttled_usec", snapshot.throttledUsec);
    }
    if (snapshot.throttledRatio !== undefined) {
      this.metrics.gauge("process.cpu.cgroup_throttled_ratio", snapshot.throttledRatio);
      this.metrics.gauge(
        "process.cpu.cgroup_throttled_threshold",
        this.config.gracefulDegradation.cpuThrottledRatioThreshold,
      );
      this.metrics.gauge(
        "process.cpu.pressure",
        resolveCgroupCpuPressure(this.config, snapshot) ? 1 : 0,
      );
    }
  }

  private recordMemoryPressureMetrics(
    memoryPressure: MemoryPressureSnapshot,
    memoryPressureSources: MemoryPressureSource[],
  ): void {
    this.metrics.gauge("process.memory.rss_mib", memoryPressure.processRssMiB);
    this.metrics.gauge(
      "process.memory.rss_threshold_mib",
      this.config.gracefulDegradation.memoryRssThresholdMiB,
    );
    this.metrics.gauge(
      "process.memory.rss_pressure_ratio",
      resolveProcessRssPressureRatio(
        memoryPressure.processRssMiB,
        this.config.gracefulDegradation.memoryRssThresholdMiB,
      ),
    );
    if (memoryPressure.cgroupMemoryCurrentMiB !== undefined) {
      this.metrics.gauge(
        "process.memory.cgroup_current_mib",
        memoryPressure.cgroupMemoryCurrentMiB,
      );
    }
    if (memoryPressure.cgroupMemoryHighMiB !== undefined) {
      this.metrics.gauge("process.memory.cgroup_high_mib", memoryPressure.cgroupMemoryHighMiB);
    }
    if (memoryPressure.cgroupMemoryLimitMiB !== undefined) {
      this.metrics.gauge("process.memory.cgroup_limit_mib", memoryPressure.cgroupMemoryLimitMiB);
    }
    if (memoryPressure.cgroupMemoryPressureRatio !== undefined) {
      this.metrics.gauge(
        "process.memory.cgroup_pressure_ratio",
        memoryPressure.cgroupMemoryPressureRatio,
      );
      this.metrics.gauge(
        "process.memory.cgroup_pressure",
        memoryPressure.cgroupMemoryPressureRatio >= CGROUP_MEMORY_PRESSURE_RATIO ? 1 : 0,
      );
    }
    if (memoryPressure.cgroupMemoryHighEvents !== undefined) {
      this.metrics.gauge(
        "process.memory.cgroup_high_events",
        memoryPressure.cgroupMemoryHighEvents,
      );
    }
    if (memoryPressure.cgroupMemoryMaxEvents !== undefined) {
      this.metrics.gauge("process.memory.cgroup_max_events", memoryPressure.cgroupMemoryMaxEvents);
    }
    if (memoryPressure.cgroupMemoryOomEvents !== undefined) {
      this.metrics.gauge("process.memory.cgroup_oom_events", memoryPressure.cgroupMemoryOomEvents);
    }
    if (memoryPressure.cgroupMemoryOomKillEvents !== undefined) {
      this.metrics.gauge(
        "process.memory.cgroup_oom_kill_events",
        memoryPressure.cgroupMemoryOomKillEvents,
      );
    }
    this.metrics.gauge(
      "process.memory.pressure",
      this.config.gracefulDegradation.enabled && memoryPressureSources.length > 0 ? 1 : 0,
    );
  }

  private recordProviderMetrics(
    diagnostics: ProviderDiagnostics | undefined,
    promptTokens?: number,
    slotSnapshots?: SchedulerSlotSnapshot[],
  ): void {
    const result: {
      diagnostics?: ProviderDiagnostics;
      promptTokens?: number;
      slotSnapshots?: SchedulerSlotSnapshot[];
    } = {};

    if (diagnostics) {
      result.diagnostics = diagnostics;
    }

    if (typeof promptTokens === "number") {
      result.promptTokens = promptTokens;
    }

    if (slotSnapshots) {
      result.slotSnapshots = slotSnapshots;
    }

    this.metrics.recordProviderResult(result);
    this.metrics.gauge(
      "provider.completion_tps",
      diagnostics?.timings?.completionTokensPerSecond ?? 0,
    );
  }
}

export function createRayRuntime(config: RayConfig, options?: CreateRayRuntimeOptions): RayRuntime {
  return new RayRuntime(config, options);
}
