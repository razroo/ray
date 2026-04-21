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
  type HealthSnapshot,
  type InferenceRequest,
  type InferenceResponse,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type ProviderHealthSnapshot,
  type ProviderResult,
  type RayConfig,
  type RuntimeMetricsSnapshot,
  type SchedulerSnapshot,
  type UsageBreakdown,
  type UsageStats,
} from "@ray/core";

interface CachedInferencePayload {
  model: string;
  output: string;
  usage: UsageStats;
  degraded: boolean;
}

type WarmState = "idle" | "warming" | "ready" | "failed";

interface CachedProviderHealth {
  checkedAtMs: number;
  snapshot: ProviderHealthSnapshot;
}

export interface CreateRayRuntimeOptions {
  provider?: ModelProvider;
  logger?: Logger;
  metrics?: RuntimeMetrics;
  scheduler?: RequestScheduler<ProviderResult>;
  cache?: TtlCache<CachedInferencePayload>;
}

function normalizeRequest(config: RayConfig, request: InferenceRequest): NormalizedInferenceRequest {
  if (!isNonEmptyString(request.input)) {
    throw new RayError("input must be a non-empty string", {
      code: "invalid_request",
      status: 400,
    });
  }

  const normalized: NormalizedInferenceRequest = {
    input: request.input.trim(),
    maxTokens: clamp(Math.floor(request.maxTokens ?? config.model.maxOutputTokens), 1, config.model.maxOutputTokens),
    temperature: clamp(request.temperature ?? 0.2, 0, 2),
    topP: clamp(request.topP ?? 0.95, 0.1, 1),
    cache: request.cache ?? true,
    metadata: request.metadata ?? {},
  };

  if (isNonEmptyString(request.system)) {
    normalized.system = request.system.trim();
  }

  if (isNonEmptyString(request.dedupeKey)) {
    normalized.dedupeKey = request.dedupeKey;
  }

  return normalized;
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
        }
      : {
          model: config.model.id,
          input: request.input,
          system: request.system ?? "",
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          topP: request.topP,
        };

  return hashValue(payload);
}

function buildUsageBreakdown(partial: Partial<UsageBreakdown> | undefined, fallback: UsageBreakdown): UsageBreakdown {
  const prompt = partial?.prompt ?? fallback.prompt;
  const completion = partial?.completion ?? fallback.completion;

  return {
    prompt,
    completion,
    total: partial?.total ?? prompt + completion,
  };
}

function computeUsage(request: NormalizedInferenceRequest, result: ProviderResult): UsageStats {
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
      prompt: 0,
      completion: 0,
      total: 0,
    });
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
    createdAt: new Date().toISOString(),
  };
}

export class RayRuntime {
  readonly logger: Logger;
  readonly metrics: RuntimeMetrics;
  readonly provider: ModelProvider;
  readonly scheduler: RequestScheduler<ProviderResult>;
  readonly cache: TtlCache<CachedInferencePayload>;
  private readonly startedAt = Date.now();
  private warmState: WarmState = "idle";
  private lastWarmError: string | undefined;
  private providerHealthCache: CachedProviderHealth | undefined;

  constructor(
    readonly config: RayConfig,
    options: CreateRayRuntimeOptions = {},
  ) {
    this.provider = options.provider ?? createModelProvider(config.model);
    this.logger = options.logger ?? new Logger(config.telemetry.serviceName, config.telemetry.logLevel);
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
    const normalized = normalizeRequest(this.config, request);
    const prepared = applyGracefulDegradation(this.config, normalized, queueSnapshot.queueDepth);
    const cacheKey =
      this.config.cache.enabled && prepared.request.cache ? buildCacheKey(this.config, prepared.request) : undefined;

    this.metrics.gauge("queue.depth", queueSnapshot.queueDepth);
    this.metrics.gauge("inference.in_flight", queueSnapshot.inFlight);

    if (cacheKey) {
      const cached = this.cache.get(cacheKey);

      if (cached) {
        const latencyMs = Date.now() - startedAt;
        this.metrics.recordRequest(latencyMs, {
          cached: true,
          degraded: cached.degraded,
        });

        return buildResponse(cached, requestId, latencyMs, 0, true, false);
      }
    }

    try {
      const handler = (signal: AbortSignal) =>
        this.provider.infer(prepared.request, {
          signal,
          requestId,
          config: this.config,
          startedAt,
        });
      const dedupeKey = prepared.request.dedupeKey ?? cacheKey;
      const scheduled = await this.scheduler.schedule(
        dedupeKey
          ? {
              key: dedupeKey,
              handler,
            }
          : {
              handler,
            },
      );

      const payload = this.toCachedPayload(scheduled, prepared.request, prepared.degraded);
      const latencyMs = Date.now() - startedAt;

      if (cacheKey) {
        this.cache.set(cacheKey, payload);
      }

      this.metrics.recordRequest(latencyMs, {
        cached: false,
        degraded: prepared.degraded,
      });
      this.metrics.gauge("queue.depth", this.scheduler.snapshot().queueDepth);
      this.metrics.gauge("inference.in_flight", this.scheduler.snapshot().inFlight);
      this.metrics.gauge("cache.entries", this.cache.size());

      if (latencyMs >= this.config.telemetry.slowRequestThresholdMs) {
        this.logger.warn("slow inference request", {
          requestId,
          latencyMs,
          queueTimeMs: scheduled.queueTimeMs,
          modelId: this.provider.modelId,
        });
      }

      return buildResponse(payload, requestId, latencyMs, scheduled.queueTimeMs, false, scheduled.deduplicated);
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
    const queueDegraded = snapshot.queueDepth >= this.config.gracefulDegradation.queueDepthThreshold;
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
  ): CachedInferencePayload {
    return {
      model: this.provider.modelId,
      output: scheduled.value.output,
      usage: computeUsage(request, scheduled.value),
      degraded,
    };
  }
}

export function createRayRuntime(config: RayConfig, options?: CreateRayRuntimeOptions): RayRuntime {
  return new RayRuntime(config, options);
}
