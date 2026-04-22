import {
  RayError,
  hashValue,
  toErrorMessage,
  type LlamaCppProviderConfig,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type ProviderContext,
  type ProviderHealthSnapshot,
  type ProviderRequestPreparation,
  type ProviderResult,
  type WarmupInferenceRequest,
} from "@razroo/ray-core";
import {
  adapterRequest,
  buildAdapterHeaders,
  extractAssistantText,
  normalizeBaseUrl,
} from "./http.js";

interface LlamaCppHealthResponse {
  status?: string;
  slots_idle?: number;
  slots_processing?: number;
  slots?: unknown[];
}

interface LlamaCppPropsResponse {
  total_slots?: number;
  chat_template?: string;
  default_generation_settings?: {
    n_ctx?: number;
    model?: string;
  };
}

interface LlamaCppTokenizeResponse {
  tokens?: unknown[];
}

interface LlamaCppApplyTemplateResponse {
  prompt?: string;
}

interface LlamaCppCompletionResponse {
  content?: string;
  truncated?: boolean;
  tokens_cached?: number;
  tokens_evaluated?: number;
  generation_settings?: {
    id_slot?: number;
    n_ctx?: number;
  };
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    prompt_per_second?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
    total_ms?: number;
  };
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    text?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface PreparedPromptState {
  prompt: string;
}

function buildChatMessages(
  request: NormalizedInferenceRequest,
): Array<{ role: string; content: string }> {
  return [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    { role: "user", content: request.input },
  ];
}

function buildChatCompletionPayload(options: {
  modelRef: string;
  request: NormalizedInferenceRequest;
  user: string;
}): Record<string, unknown> {
  return {
    model: options.modelRef,
    stream: false,
    temperature: options.request.temperature,
    top_p: options.request.topP,
    max_tokens: options.request.maxTokens,
    messages: buildChatMessages(options.request),
    ...(options.request.seed !== undefined ? { seed: options.request.seed } : {}),
    ...(options.request.stop ? { stop: options.request.stop } : {}),
    ...(options.request.responseFormat ? { response_format: options.request.responseFormat } : {}),
    user: options.user,
  };
}

function buildCompletionTimings(
  timings: LlamaCppCompletionResponse["timings"],
): ProviderResult["diagnostics"] {
  if (!timings) {
    return undefined;
  }

  const promptMs = timings.prompt_ms;
  const completionMs = timings.predicted_ms;
  const completionTokens = timings.predicted_n;
  const promptTokens = timings.prompt_n;
  const promptTokensPerSecond =
    timings.prompt_per_second ??
    (typeof promptMs === "number" &&
    promptMs > 0 &&
    typeof promptTokens === "number" &&
    promptTokens > 0
      ? (promptTokens / promptMs) * 1_000
      : undefined);
  const completionTokensPerSecond =
    timings.predicted_per_second ??
    (typeof completionMs === "number" &&
    completionMs > 0 &&
    typeof completionTokens === "number" &&
    completionTokens > 0
      ? (completionTokens / completionMs) * 1_000
      : undefined);

  return {
    timings: {
      ...(typeof promptMs === "number" ? { promptMs } : {}),
      ...(typeof completionMs === "number" ? { completionMs } : {}),
      totalMs:
        timings.total_ms ??
        (typeof promptMs === "number" ? promptMs : 0) +
          (typeof completionMs === "number" ? completionMs : 0),
      ...(typeof promptMs === "number"
        ? {
            ttftMs:
              promptMs +
              (typeof completionMs === "number" &&
              typeof completionTokens === "number" &&
              completionTokens > 0
                ? completionMs / completionTokens
                : 0),
          }
        : {}),
      ...(typeof promptTokensPerSecond === "number" ? { promptTokensPerSecond } : {}),
      ...(typeof completionTokensPerSecond === "number" ? { completionTokensPerSecond } : {}),
    },
  };
}

export class LlamaCppProvider implements ModelProvider {
  readonly kind = "llama.cpp";
  readonly modelId: string;
  readonly capabilities = {
    streaming: false,
    quantized: true,
    localBackend: true,
  } as const;
  private readonly preparationCache = new Map<string, ProviderRequestPreparation>();
  private readonly maxPreparationCacheEntries = 256;

  constructor(
    private readonly model: ModelConfig,
    private readonly adapter: LlamaCppProviderConfig,
  ) {
    this.modelId = model.id;
  }

  async warm(): Promise<void> {
    const warmupRequests =
      this.adapter.warmupRequests && this.adapter.warmupRequests.length > 0
        ? this.adapter.warmupRequests
        : [{ input: "ping" } satisfies WarmupInferenceRequest];

    for (const request of warmupRequests) {
      const normalized: NormalizedInferenceRequest = {
        input: request.input,
        ...(request.system ? { system: request.system } : {}),
        maxTokens: request.maxTokens ?? 1,
        temperature: 0,
        topP: 1,
        cache: false,
        metadata: {},
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.stop ? { stop: request.stop } : {}),
        ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
      };
      const preparation = await this.prepare(normalized, this.createWarmContext());
      await this.infer(normalized, {
        ...this.createWarmContext(),
        preparation,
      });
    }
  }

  async health(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();

    try {
      const [healthProbe, propsProbe] = await Promise.allSettled([
        this.fetchHealthPayload(),
        this.request("/props", { method: "GET" }, Math.min(this.adapter.timeoutMs, 5_000)),
      ]);

      const checkedAt = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      const healthPayload =
        healthProbe.status === "fulfilled" ? healthProbe.value.payload : undefined;
      const propsPayload =
        propsProbe.status === "fulfilled" ? (propsProbe.value as LlamaCppPropsResponse) : undefined;
      const healthStatus = healthPayload?.status?.toLowerCase() ?? "unknown";
      let status: ProviderHealthSnapshot["status"] = "unknown";

      if (healthStatus.includes("loading")) {
        status = "warming";
      } else if (healthStatus.includes("no slot")) {
        status = "degraded";
      } else if (healthStatus.includes("ok")) {
        status = "ready";
      } else if (healthProbe.status === "fulfilled" || propsProbe.status === "fulfilled") {
        status = "ready";
      } else {
        status = "unavailable";
      }

      return {
        status,
        checkedAt,
        latencyMs,
        details: {
          probe: "/health + /props",
          modelRef: this.adapter.modelRef,
          slotsIdle: healthPayload?.slots_idle,
          slotsProcessing: healthPayload?.slots_processing,
          slots: healthPayload?.slots,
          totalSlots: propsPayload?.total_slots,
          chatTemplate:
            typeof propsPayload?.chat_template === "string"
              ? propsPayload.chat_template.slice(0, 120)
              : undefined,
          contextWindow:
            propsPayload?.default_generation_settings?.n_ctx ?? this.model.contextWindow,
          backendModel: propsPayload?.default_generation_settings?.model,
          ...(healthProbe.status === "rejected"
            ? {
                healthError: toErrorMessage(healthProbe.reason),
              }
            : {}),
          ...(propsProbe.status === "rejected"
            ? {
                propsError: toErrorMessage(propsProbe.reason),
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: {
          message: toErrorMessage(error),
        },
      };
    }
  }

  async prepare(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderRequestPreparation> {
    const cacheKey = this.buildPreparationCacheKey(request);
    const cached = this.preparationCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        request,
      };
    }

    const prompt = await this.applyTemplate(request, context.signal);
    const promptTokens = await this.tokenize(prompt, context.signal);
    const preparation: ProviderRequestPreparation = {
      request,
      promptTokens,
      providerState: {
        prompt,
      } satisfies PreparedPromptState,
      diagnostics: {
        requestShape:
          request.responseFormat?.type === "json_object" ? "openai-chat" : "llama.cpp-completion",
        contextWindow: this.model.contextWindow,
      },
    };

    this.setPreparationCache(cacheKey, preparation);
    return preparation;
  }

  async infer(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const preparation =
      context.preparation?.request.input === request.input &&
      context.preparation.request.system === request.system
        ? context.preparation
        : await this.prepare(request, context);

    if (request.responseFormat?.type === "json_object") {
      return this.inferViaChatCompletions(request, context, preparation);
    }

    return this.inferViaCompletion(request, context, preparation);
  }

  private async inferViaChatCompletions(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
    preparation: ProviderRequestPreparation,
  ): Promise<ProviderResult> {
    const payload = (await this.request(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          buildChatCompletionPayload({
            modelRef: this.adapter.modelRef,
            request,
            user: context.requestId,
          }),
        ),
      },
      this.adapter.timeoutMs,
      context.signal,
    )) as OpenAICompatibleResponse;

    const output = extractAssistantText(payload);
    const prompt = payload.usage?.prompt_tokens ?? preparation.promptTokens ?? 0;
    const completion = payload.usage?.completion_tokens ?? 0;
    const usage =
      payload.usage || preparation.promptTokens !== undefined
        ? {
            tokens: {
              prompt,
              completion,
              total: payload.usage?.total_tokens ?? prompt + completion,
            },
          }
        : undefined;

    return {
      output,
      ...(usage ? { usage } : {}),
      diagnostics: {
        requestShape: "openai-chat",
        ...(typeof preparation.diagnostics?.contextWindow === "number"
          ? { contextWindow: preparation.diagnostics.contextWindow }
          : {}),
      },
      raw: payload,
    };
  }

  private async inferViaCompletion(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
    preparation: ProviderRequestPreparation,
  ): Promise<ProviderResult> {
    const preparedState = preparation.providerState as PreparedPromptState | undefined;
    const prompt = preparedState?.prompt;

    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new RayError("Missing llama.cpp prepared prompt", {
        code: "provider_invalid_response",
        status: 500,
      });
    }

    const payload = (await this.request(
      "/completion",
      {
        method: "POST",
        body: JSON.stringify({
          prompt,
          temperature: request.temperature,
          top_p: request.topP,
          n_predict: request.maxTokens,
          stream: false,
          cache_prompt: this.adapter.cachePrompt ?? true,
          id_slot: this.adapter.slotId ?? -1,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...(request.stop ? { stop: request.stop } : {}),
        }),
      },
      this.adapter.timeoutMs,
      context.signal,
    )) as LlamaCppCompletionResponse;

    if (typeof payload.content !== "string") {
      throw new RayError("The llama.cpp backend returned an empty response body", {
        code: "provider_invalid_response",
        status: 502,
      });
    }

    const promptTokens =
      preparation.promptTokens ?? payload.timings?.prompt_n ?? payload.tokens_evaluated ?? 0;
    const completionTokens = payload.timings?.predicted_n ?? 0;
    const timingDiagnostics = buildCompletionTimings(payload.timings);
    const tokensEvaluated = payload.tokens_evaluated ?? payload.timings?.prompt_n;

    return {
      output: payload.content,
      usage: {
        tokens: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
      },
      diagnostics: {
        requestShape: "llama.cpp-completion",
        ...((payload.generation_settings?.id_slot ?? this.adapter.slotId) !== undefined
          ? { slotId: payload.generation_settings?.id_slot ?? this.adapter.slotId }
          : {}),
        ...(payload.tokens_cached !== undefined ? { tokensCached: payload.tokens_cached } : {}),
        ...(typeof tokensEvaluated === "number" ? { tokensEvaluated } : {}),
        ...(payload.truncated !== undefined ? { truncated: payload.truncated } : {}),
        contextWindow: payload.generation_settings?.n_ctx ?? this.model.contextWindow,
        ...timingDiagnostics,
      },
      raw: payload,
    };
  }

  private async applyTemplate(
    request: NormalizedInferenceRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const payload = (await this.request(
      "/apply-template",
      {
        method: "POST",
        body: JSON.stringify({
          messages: buildChatMessages(request),
        }),
      },
      this.adapter.timeoutMs,
      signal,
    )) as LlamaCppApplyTemplateResponse;

    if (typeof payload.prompt !== "string" || payload.prompt.length === 0) {
      throw new RayError("The llama.cpp template endpoint returned an empty prompt", {
        code: "provider_invalid_response",
        status: 502,
      });
    }

    return payload.prompt;
  }

  private async tokenize(content: string, signal?: AbortSignal): Promise<number> {
    const payload = (await this.request(
      "/tokenize",
      {
        method: "POST",
        body: JSON.stringify({
          content,
          add_special: false,
        }),
      },
      Math.min(this.adapter.timeoutMs, 10_000),
      signal,
    )) as LlamaCppTokenizeResponse;

    if (!Array.isArray(payload.tokens)) {
      throw new RayError("The llama.cpp tokenize endpoint returned an invalid payload", {
        code: "provider_invalid_response",
        status: 502,
      });
    }

    return payload.tokens.length;
  }

  private buildPreparationCacheKey(request: NormalizedInferenceRequest): string {
    return hashValue({
      model: this.adapter.modelRef,
      input: request.input,
      system: request.system ?? "",
      responseFormat: request.responseFormat?.type ?? "text",
    });
  }

  private setPreparationCache(key: string, preparation: ProviderRequestPreparation): void {
    if (this.preparationCache.has(key)) {
      this.preparationCache.delete(key);
    }

    this.preparationCache.set(key, preparation);

    while (this.preparationCache.size > this.maxPreparationCacheEntries) {
      const oldestKey = this.preparationCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.preparationCache.delete(oldestKey);
    }
  }

  private async fetchHealthPayload(): Promise<{
    statusCode: number;
    payload?: LlamaCppHealthResponse;
  }> {
    const controller = new AbortController();
    const timeoutMs = Math.min(this.adapter.timeoutMs, 5_000);
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(
        `${normalizeBaseUrl(this.adapter.baseUrl)}/health?include_slots=1`,
        {
          method: "GET",
          headers: buildAdapterHeaders(this.adapter),
          signal: controller.signal,
        },
      );
      const payload = (await response.json()) as LlamaCppHealthResponse;
      return {
        statusCode: response.status,
        payload,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private createWarmContext(): ProviderContext {
    return {
      signal: new AbortController().signal,
      requestId: "ray_warmup",
      config: {
        profile: "tiny",
        server: {
          host: "127.0.0.1",
          port: 0,
          requestBodyLimitBytes: 0,
        },
        model: this.model,
        scheduler: {
          concurrency: 1,
          maxQueue: 1,
          maxQueuedTokens: 1,
          maxInflightTokens: 1,
          requestTimeoutMs: 1,
          dedupeInflight: false,
          batchWindowMs: 0,
          affinityLookahead: 1,
        },
        asyncQueue: {
          enabled: false,
          storageDir: "",
          pollIntervalMs: 1,
          dispatchConcurrency: 1,
          maxAttempts: 1,
          callbackTimeoutMs: 1,
          maxCallbackAttempts: 1,
        },
        cache: {
          enabled: false,
          maxEntries: 1,
          ttlMs: 1,
          keyStrategy: "input",
        },
        telemetry: {
          serviceName: "ray",
          logLevel: "error",
          includeDebugMetrics: false,
          slowRequestThresholdMs: 1,
        },
        gracefulDegradation: {
          enabled: false,
          queueDepthThreshold: 1,
          maxPromptChars: 1,
          degradeToMaxTokens: 1,
        },
        promptCompiler: {
          enabled: false,
          collapseWhitespace: false,
          dedupeRepeatedLines: false,
          familyMetadataKeys: [],
        },
        adaptiveTuning: {
          enabled: false,
          sampleSize: 1,
          queueLatencyThresholdMs: 1,
          minCompletionTokensPerSecond: 1,
          maxOutputReductionRatio: 0,
          minOutputTokens: 1,
        },
        auth: {
          enabled: false,
        },
        rateLimit: {
          enabled: false,
          windowMs: 1,
          maxRequests: 1,
          keyStrategy: "ip",
          trustProxyHeaders: false,
        },
        tags: {},
      },
      startedAt: Date.now(),
    };
  }

  private async request(
    pathname: string,
    init: RequestInit,
    timeoutMs = this.adapter.timeoutMs,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    return adapterRequest(this.adapter, pathname, init, timeoutMs, parentSignal);
  }
}
