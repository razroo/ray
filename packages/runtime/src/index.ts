import { sanitizeConfig } from "@ray/config";
import { TtlCache } from "@ray/cache";
import { createModelProvider } from "@ray/models";
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
  type HealthSnapshot,
  type InferenceDiagnostics,
  type InferenceRequest,
  type InferenceResponse,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type PromptCompilerDiagnostics,
  type ProviderDiagnostics,
  type ProviderHealthSnapshot,
  type ProviderRequestPreparation,
  type ProviderResult,
  type RayConfig,
  type RuntimeMetricsSnapshot,
  type SchedulerSnapshot,
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
  diagnostics: PromptCompilerDiagnostics;
}

interface AdaptiveSample {
  queueTimeMs: number;
  completionTokensPerSecond?: number;
}

export interface CreateRayRuntimeOptions {
  provider?: ModelProvider;
  logger?: Logger;
  metrics?: RuntimeMetrics;
  scheduler?: RequestScheduler<ProviderResult>;
  cache?: TtlCache<CachedInferencePayload>;
}

export function normalizeInferenceRequest(
  config: RayConfig,
  request: InferenceRequest,
): NormalizedInferenceRequest {
  if (!isNonEmptyString(request.input)) {
    throw new RayError("input must be a non-empty string", {
      code: "invalid_request",
      status: 400,
    });
  }

  const normalized: NormalizedInferenceRequest = {
    input: request.input.trim(),
    maxTokens: clamp(
      Math.floor(request.maxTokens ?? config.model.maxOutputTokens),
      1,
      config.model.maxOutputTokens,
    ),
    temperature: clamp(request.temperature ?? 0.2, 0, 2),
    topP: clamp(request.topP ?? 0.95, 0.1, 1),
    cache: request.cache ?? true,
    metadata: request.metadata ?? {},
  };

  if (isNonEmptyString(request.system)) {
    normalized.system = request.system.trim();
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

    normalized.stop = request.stop.map((value) => {
      if (!isNonEmptyString(value)) {
        throw new RayError("stop entries must be non-empty strings", {
          code: "invalid_request",
          status: 400,
        });
      }

      return value;
    });
  }

  if (request.responseFormat !== undefined) {
    if (
      request.responseFormat === null ||
      typeof request.responseFormat !== "object" ||
      (request.responseFormat.type !== "text" && request.responseFormat.type !== "json_object")
    ) {
      throw new RayError("responseFormat.type must be 'text' or 'json_object' when provided", {
        code: "invalid_request",
        status: 400,
      });
    }

    normalized.responseFormat = request.responseFormat;
  }

  if (isNonEmptyString(request.dedupeKey)) {
    normalized.dedupeKey = request.dedupeKey;
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

function compilePrompt(config: RayConfig, request: NormalizedInferenceRequest): CompiledPrompt {
  const charsBefore = request.input.length + (request.system?.length ?? 0);

  if (!config.promptCompiler.enabled) {
    const familyHint = config.promptCompiler.familyMetadataKeys.find((key) =>
      isNonEmptyString(request.metadata[key]),
    );
    const familySeed =
      (familyHint ? request.metadata[familyHint] : undefined) ??
      derivePromptTemplate(request.input);

    return {
      request,
      affinityKey: hashValue({
        system: request.system ?? "",
        template: familySeed,
      }),
      diagnostics: {
        familyKey: hashValue({
          system: request.system ?? "",
          template: familySeed,
        }),
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
    diagnostics: {
      familyKey,
      charsBefore,
      charsAfter,
      charsSaved: Math.max(0, charsBefore - charsAfter),
    },
  };
}

function applyGracefulDegradation(
  config: RayConfig,
  request: NormalizedInferenceRequest,
  queueDepth: number,
): { request: NormalizedInferenceRequest; degraded: boolean } {
  if (!config.gracefulDegradation.enabled) {
    return { request, degraded: false };
  }

  let degraded = false;
  let input = request.input;
  let maxTokens = request.maxTokens;

  if (input.length > config.gracefulDegradation.maxPromptChars) {
    input = input.slice(0, config.gracefulDegradation.maxPromptChars);
    degraded = true;
  }

  if (
    queueDepth >= config.gracefulDegradation.queueDepthThreshold &&
    maxTokens > config.gracefulDegradation.degradeToMaxTokens
  ) {
    maxTokens = config.gracefulDegradation.degradeToMaxTokens;
    degraded = true;
  }

  if (!degraded) {
    return { request, degraded: false };
  }

  return {
    request: {
      ...request,
      input,
      maxTokens,
    },
    degraded: true,
  };
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

export class RayRuntime {
  readonly logger: Logger;
  readonly metrics: RuntimeMetrics;
  readonly provider: ModelProvider;
  readonly scheduler: RequestScheduler<ProviderResult>;
  readonly cache: TtlCache<CachedInferencePayload>;
  private readonly recentAdaptiveSamples: AdaptiveSample[] = [];
  private readonly startedAt = Date.now();
  private warmState: WarmState = "idle";
  private lastWarmError: string | undefined;
  private providerHealthCache: CachedProviderHealth | undefined;

  constructor(
    readonly config: RayConfig,
    options: CreateRayRuntimeOptions = {},
  ) {
    this.provider = options.provider ?? createModelProvider(config.model);
    this.logger =
      options.logger ?? new Logger(config.telemetry.serviceName, config.telemetry.logLevel);
    this.metrics = options.metrics ?? new RuntimeMetrics();
    this.scheduler = options.scheduler ?? new RequestScheduler<ProviderResult>(config.scheduler);
    this.cache =
      options.cache ??
      new TtlCache<CachedInferencePayload>({
        maxEntries: config.cache.maxEntries,
        ttlMs: config.cache.ttlMs,
      });
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
    const compiled = compilePrompt(this.config, normalized);
    const degraded = applyGracefulDegradation(
      this.config,
      compiled.request,
      queueSnapshot.queueDepth,
    );
    const tuned = applyAdaptiveTuning(this.config, degraded.request, this.recentAdaptiveSamples);
    const runtimeDiagnostics: InferenceDiagnostics = {
      promptCompiler: compiled.diagnostics,
      adaptiveTuning: tuned.diagnostics,
    };
    const cacheKey =
      this.config.cache.enabled && tuned.request.cache
        ? buildCacheKey(this.config, tuned.request)
        : undefined;

    this.metrics.gauge("queue.depth", queueSnapshot.queueDepth);
    this.metrics.gauge("inference.in_flight", queueSnapshot.inFlight);
    this.metrics.gauge("queue.tokens", queueSnapshot.queuedTokens);
    this.metrics.gauge("inference.in_flight_tokens", queueSnapshot.inFlightTokens);
    this.metrics.gauge("prompt.compiler.chars_saved", compiled.diagnostics.charsSaved);
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

        return buildResponse(cached, requestId, latencyMs, 0, true, false, {
          ...runtimeDiagnostics,
          ...(cached.providerDiagnostics ? { provider: cached.providerDiagnostics } : {}),
        });
      }
    }

    try {
      const preparation = await this.prepareRequest(tuned.request, requestId, startedAt);
      const requestForProvider = preparation?.request ?? tuned.request;
      const providerContextBase = {
        requestId,
        config: this.config,
        startedAt,
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
              costTokens: requestCostTokens,
              handler,
            }
          : {
              affinityKey: preparation?.affinityKey ?? compiled.affinityKey,
              costTokens: requestCostTokens,
              handler,
            },
      );

      const payload = this.toCachedPayload(
        scheduled,
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
      this.metrics.gauge("queue.depth", this.scheduler.snapshot().queueDepth);
      this.metrics.gauge("inference.in_flight", this.scheduler.snapshot().inFlight);
      this.metrics.gauge("queue.tokens", this.scheduler.snapshot().queuedTokens);
      this.metrics.gauge("inference.in_flight_tokens", this.scheduler.snapshot().inFlightTokens);
      this.metrics.gauge("cache.entries", this.cache.size());
      this.metrics.gauge(
        "provider.completion_tps",
        scheduled.value.diagnostics?.timings?.completionTokensPerSecond ?? 0,
      );
      this.metrics.gauge("queue.last_delay_ms", scheduled.queueTimeMs);

      this.recordAdaptiveSample(scheduled.queueTimeMs, scheduled.value.diagnostics);

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
    const provider = await this.getProviderHealth();
    const queueDegraded =
      snapshot.queueDepth >= this.config.gracefulDegradation.queueDepthThreshold;
    const status =
      provider.status === "unavailable"
        ? "unavailable"
        : provider.status === "degraded" || provider.status === "warming" || queueDegraded
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
    };
  }

  schedulerSnapshot(): SchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  metricsSnapshot(): RuntimeMetricsSnapshot {
    return this.metrics.snapshot(this.config.telemetry.includeDebugMetrics);
  }

  sanitizedConfig(): Record<string, unknown> {
    return sanitizeConfig(this.config);
  }

  private async getProviderHealth(): Promise<ProviderHealthSnapshot> {
    const now = Date.now();

    if (this.provider.health) {
      if (this.providerHealthCache && now - this.providerHealthCache.checkedAtMs < 1_000) {
        return this.providerHealthCache.snapshot;
      }

      try {
        const snapshot = await this.provider.health();
        this.providerHealthCache = {
          checkedAtMs: now,
          snapshot,
        };
        this.metrics.recordProviderHealth(snapshot.status, snapshot.latencyMs);
        return snapshot;
      } catch (error) {
        const snapshot: ProviderHealthSnapshot = {
          status: "unavailable",
          checkedAt: new Date().toISOString(),
          details: {
            message: toErrorMessage(error),
          },
        };
        this.providerHealthCache = {
          checkedAtMs: now,
          snapshot,
        };
        this.metrics.recordProviderHealth(snapshot.status);
        return snapshot;
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

    this.metrics.recordProviderHealth(snapshot.status, snapshot.latencyMs);
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
  ): Promise<ProviderRequestPreparation | undefined> {
    if (!this.provider.prepare) {
      return undefined;
    }

    const controller = new AbortController();
    return this.provider.prepare(request, {
      signal: controller.signal,
      requestId,
      config: this.config,
      startedAt,
    });
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
}

export function createRayRuntime(config: RayConfig, options?: CreateRayRuntimeOptions): RayRuntime {
  return new RayRuntime(config, options);
}
