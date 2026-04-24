import {
  RayError,
  hashValue,
  toErrorMessage,
  type LlamaCppProviderConfig,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type ProviderDetectedCapabilities,
  type ProviderContext,
  type ProviderHealthSnapshot,
  type ProviderRequestPreparation,
  type ProviderResult,
  type SchedulerSlotSnapshot,
  type WarmupInferenceRequest,
} from "@razroo/ray-core";
import {
  renderPromptTemplate,
  requirePromptTemplate,
  resolvePromptTemplateRequest,
} from "@ray/prompts";
import {
  adapterRequest,
  buildAdapterHeaders,
  extractAssistantText,
  normalizeBaseUrl,
} from "./http.js";

const DEFAULT_SLOT_SNAPSHOT_TIMEOUT_MS = 250;
const TOKENIZE_TIMEOUT_MS = 30_000;
const CAPABILITY_CACHE_TTL_MS = 60_000;
const PROMPT_FORMAT_OVERRIDE_METADATA_KEY = "rayPromptFormat";

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

interface ChatCompletionInferenceResult {
  output: string;
  payload: OpenAICompatibleResponse;
  usage?: {
    tokens: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
}

interface LlamaCppSlotResponse {
  id?: number;
  id_slot?: number;
  task_id?: number;
  id_task?: number;
  is_processing?: boolean;
  n_ctx?: number;
  n_keep?: number;
  next_token?: {
    n_past?: number;
    n_decoded?: number;
  };
}

interface PromptScaffold {
  segments: string[];
  variableOrder: string[];
}

interface PreparedPromptState {
  prompt: string;
}

interface PromptPreparation {
  prompt: string;
  diagnostics: {
    promptFormat: "llama.cpp-template" | "prompt-scaffold" | "ray-chat-fallback";
    promptFormatReason: string;
    modelRef?: string;
    backendModel?: string;
    launchPreset?: string;
    totalSlots?: number;
  };
}

interface CachedSlotState {
  checkedAtMs: number;
  slots: SchedulerSlotSnapshot[];
}

interface CachedBackendCapabilities {
  checkedAtMs: number;
  capabilities: ProviderDetectedCapabilities;
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

function isValidJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function resolvePromptFormatOverride(
  request: NormalizedInferenceRequest,
): PromptPreparation["diagnostics"]["promptFormat"] | undefined {
  const override = request.metadata[PROMPT_FORMAT_OVERRIDE_METADATA_KEY];

  if (
    override === "llama.cpp-template" ||
    override === "prompt-scaffold" ||
    override === "ray-chat-fallback"
  ) {
    return override;
  }

  return undefined;
}

function mergeUsage(
  left: ChatCompletionInferenceResult["usage"],
  right: ChatCompletionInferenceResult["usage"],
): ChatCompletionInferenceResult["usage"] {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return {
    tokens: {
      prompt: left.tokens.prompt + right.tokens.prompt,
      completion: left.tokens.completion + right.tokens.completion,
      total: left.tokens.total + right.tokens.total,
    },
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

function parseSlotSnapshots(payload: unknown): SchedulerSlotSnapshot[] {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { slots?: unknown[] }).slots)
      ? (payload as { slots: unknown[] }).slots
      : [];

  const snapshots: SchedulerSlotSnapshot[] = [];

  for (const rawSlot of list) {
    if (rawSlot === null || typeof rawSlot !== "object") {
      continue;
    }

    const slot = rawSlot as LlamaCppSlotResponse;
    const id = slot.id ?? slot.id_slot;
    if (typeof id !== "number") {
      continue;
    }

    snapshots.push({
      id,
      ...(typeof (slot.task_id ?? slot.id_task) === "number"
        ? { taskId: slot.task_id ?? slot.id_task }
        : {}),
      isProcessing: slot.is_processing === true,
      ...(typeof slot.n_ctx === "number" ? { contextWindow: slot.n_ctx } : {}),
      ...(typeof slot.next_token?.n_past === "number"
        ? { promptTokens: slot.next_token.n_past }
        : {}),
      ...(typeof slot.n_keep === "number" ? { cacheTokens: slot.n_keep } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  return snapshots;
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
  private readonly promptTokenCache = new Map<string, number>();
  private readonly promptScaffolds = new Map<string, PromptScaffold>();
  private readonly familyPreferredSlots = new Map<string, number>();
  private readonly slotFamilyAssignments = new Map<number, string>();
  private readonly maxPreparationCacheEntries = 256;
  private readonly maxPromptTokenCacheEntries = 1024;
  private readonly maxPromptScaffoldEntries: number;
  private slotStateCache: CachedSlotState | undefined;
  private backendCapabilitiesCache: CachedBackendCapabilities | undefined;

  constructor(
    private readonly model: ModelConfig,
    private readonly adapter: LlamaCppProviderConfig,
  ) {
    this.modelId = model.id;
    this.maxPromptScaffoldEntries = adapter.promptScaffoldCacheEntries ?? 128;
  }

  async warm(): Promise<void> {
    await this.detectCapabilities(undefined, { force: true, includeJsonProbe: true });

    const warmupRequests =
      this.adapter.warmupRequests && this.adapter.warmupRequests.length > 0
        ? this.adapter.warmupRequests
        : [{ input: "ping" } satisfies WarmupInferenceRequest];

    for (const request of warmupRequests) {
      const resolved = resolvePromptTemplateRequest(request);
      const normalized: NormalizedInferenceRequest = {
        input: resolved.input ?? "ping",
        ...(resolved.system ? { system: resolved.system } : {}),
        maxTokens: resolved.maxTokens ?? 1,
        temperature: 0,
        topP: 1,
        cache: false,
        metadata: resolved.metadata,
        ...(resolved.promptTemplateId ? { promptTemplateId: resolved.promptTemplateId } : {}),
        ...(resolved.templateVariables ? { templateVariables: resolved.templateVariables } : {}),
        ...(resolved.promptLane ? { promptLane: resolved.promptLane } : {}),
        ...(resolved.promptFamily ? { promptFamily: resolved.promptFamily } : {}),
        ...(request.seed !== undefined ? { seed: request.seed } : {}),
        ...(request.stop ? { stop: request.stop } : {}),
        ...(resolved.responseFormat ? { responseFormat: resolved.responseFormat } : {}),
      };
      const preparation = await this.prepare(normalized, this.createWarmContext());
      await this.infer(normalized, {
        ...this.createWarmContext(),
        ...(preparation.affinityKey ? { affinityKey: preparation.affinityKey } : {}),
        ...(preparation.lane ? { lane: preparation.lane } : {}),
        preparation,
      });
    }
  }

  async health(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();

    try {
      const [healthProbe, capabilityProbe, slotProbe] = await Promise.allSettled([
        this.fetchHealthPayload(),
        this.detectCapabilities(undefined, { includeJsonProbe: false }),
        this.getSlotSnapshots(),
      ]);

      const checkedAt = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      const healthPayload =
        healthProbe.status === "fulfilled" ? healthProbe.value.payload : undefined;
      const detectedCapabilities =
        capabilityProbe.status === "fulfilled" ? capabilityProbe.value : undefined;
      const slotSnapshots = slotProbe.status === "fulfilled" ? slotProbe.value : undefined;
      const healthStatus = healthPayload?.status?.toLowerCase() ?? "unknown";
      let status: ProviderHealthSnapshot["status"] = "unknown";

      if (healthStatus.includes("loading")) {
        status = "warming";
      } else if (healthStatus.includes("no slot")) {
        status = "degraded";
      } else if (healthStatus.includes("ok")) {
        status = "ready";
      } else if (
        healthProbe.status === "fulfilled" ||
        capabilityProbe.status === "fulfilled" ||
        slotProbe.status === "fulfilled"
      ) {
        status = "ready";
      } else {
        status = "unavailable";
      }

      return {
        status,
        checkedAt,
        latencyMs,
        ...(detectedCapabilities ? { detectedCapabilities } : {}),
        details: {
          probe: "/health + capabilities + /slots",
          modelRef: this.adapter.modelRef,
          slotsIdle: healthPayload?.slots_idle,
          slotsProcessing: healthPayload?.slots_processing,
          slots: slotSnapshots,
          totalSlots: detectedCapabilities?.totalSlots,
          contextWindow: detectedCapabilities?.contextWindow ?? this.model.contextWindow,
          backendModel: detectedCapabilities?.backendModel,
          applyTemplate: detectedCapabilities?.applyTemplate,
          chatTemplate: detectedCapabilities?.chatTemplate,
          jsonMode: detectedCapabilities?.jsonMode,
          familyPreferredSlots: Object.fromEntries(this.familyPreferredSlots.entries()),
          ...(healthProbe.status === "rejected"
            ? {
                healthError: toErrorMessage(healthProbe.reason),
              }
            : {}),
          ...(capabilityProbe.status === "rejected"
            ? {
                capabilitiesError: toErrorMessage(capabilityProbe.reason),
              }
            : {}),
          ...(slotProbe.status === "rejected"
            ? {
                slotsError: toErrorMessage(slotProbe.reason),
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

  private async detectCapabilities(
    signal?: AbortSignal,
    options: {
      force?: boolean;
      includeJsonProbe?: boolean;
    } = {},
  ): Promise<ProviderDetectedCapabilities> {
    if (
      !options.force &&
      this.backendCapabilitiesCache &&
      Date.now() - this.backendCapabilitiesCache.checkedAtMs < CAPABILITY_CACHE_TTL_MS &&
      (!options.includeJsonProbe ||
        this.backendCapabilitiesCache.capabilities.jsonMode !== "unknown")
    ) {
      return this.backendCapabilitiesCache.capabilities;
    }

    const errors: Record<string, string> = {};
    const [propsProbe, applyTemplateProbe] = await Promise.allSettled([
      this.request("/props", { method: "GET" }, Math.min(this.adapter.timeoutMs, 5_000), signal),
      this.probeApplyTemplate(signal),
    ]);
    const propsPayload =
      propsProbe.status === "fulfilled" ? (propsProbe.value as LlamaCppPropsResponse) : undefined;
    const applyTemplate =
      applyTemplateProbe.status === "fulfilled" && applyTemplateProbe.value
        ? "available"
        : "unavailable";
    const chatTemplate =
      typeof propsPayload?.chat_template === "string" && propsPayload.chat_template.length > 0
        ? "available"
        : propsProbe.status === "fulfilled"
          ? "unavailable"
          : "unknown";
    let jsonMode: ProviderDetectedCapabilities["jsonMode"] =
      this.backendCapabilitiesCache?.capabilities.jsonMode ?? "unknown";

    if (propsProbe.status === "rejected") {
      errors.props = toErrorMessage(propsProbe.reason);
    }

    if (applyTemplateProbe.status === "rejected") {
      errors.applyTemplate = toErrorMessage(applyTemplateProbe.reason);
    }

    if (options.includeJsonProbe) {
      try {
        jsonMode = (await this.probeJsonMode(signal)) ? "available" : "unavailable";
      } catch (error) {
        jsonMode = "unavailable";
        errors.jsonMode = toErrorMessage(error);
      }
    }

    const capabilities: ProviderDetectedCapabilities = {
      modelRef: this.adapter.modelRef,
      ...(this.adapter.launchProfile?.preset
        ? { launchPreset: this.adapter.launchProfile.preset }
        : {}),
      applyTemplate,
      chatTemplate,
      jsonMode,
      ...(typeof propsPayload?.default_generation_settings?.model === "string"
        ? { backendModel: propsPayload.default_generation_settings.model }
        : {}),
      ...(typeof propsPayload?.default_generation_settings?.n_ctx === "number"
        ? { contextWindow: propsPayload.default_generation_settings.n_ctx }
        : { contextWindow: this.model.contextWindow }),
      ...(typeof propsPayload?.total_slots === "number"
        ? { totalSlots: propsPayload.total_slots }
        : {}),
      ...(this.model.operational?.recommendedPromptFormat
        ? { promptFormatPreference: this.model.operational.recommendedPromptFormat }
        : {}),
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };

    this.backendCapabilitiesCache = {
      checkedAtMs: Date.now(),
      capabilities,
    };
    return capabilities;
  }

  private async probeApplyTemplate(signal?: AbortSignal): Promise<boolean> {
    const payload = (await this.request(
      "/apply-template",
      {
        method: "POST",
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are a liveness probe." },
            { role: "user", content: "ping" },
          ],
        }),
      },
      Math.min(this.adapter.timeoutMs, 2_500),
      signal,
    )) as LlamaCppApplyTemplateResponse;

    return typeof payload.prompt === "string" && payload.prompt.length > 0;
  }

  private async probeJsonMode(signal?: AbortSignal): Promise<boolean> {
    const payload = (await this.request(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.adapter.modelRef,
          stream: false,
          temperature: 0,
          max_tokens: 8,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return only compact JSON." },
            { role: "user", content: 'Return {"ok":true}.' },
          ],
        }),
      },
      Math.min(this.adapter.timeoutMs, 5_000),
      signal,
    )) as OpenAICompatibleResponse;
    const output = extractAssistantText(payload);

    try {
      JSON.parse(output);
      return true;
    } catch {
      return false;
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
        ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
        ...(context.lane ? { lane: context.lane } : {}),
      };
    }

    const [slots, detectedCapabilities] = await Promise.all([
      this.getSlotSnapshots(context.signal),
      this.detectCapabilities(context.signal, { includeJsonProbe: false }),
    ]);
    const promptPreparation = await this.preparePrompt(
      request,
      context.signal,
      detectedCapabilities,
    );
    const promptTokens = await this.countPromptTokens(promptPreparation.prompt, context.signal);
    const slotSelection = this.selectPreferredSlot(context.affinityKey, slots);
    const requestShape =
      request.responseFormat?.type === "json_object" ? "openai-chat" : "llama.cpp-completion";
    const preparation: ProviderRequestPreparation = {
      request,
      promptTokens,
      ...(context.affinityKey ? { affinityKey: context.affinityKey } : {}),
      ...(context.lane ? { lane: context.lane } : {}),
      ...(slotSelection.preferredSlot !== undefined
        ? { preferredSlot: slotSelection.preferredSlot }
        : {}),
      ...(slots.length > 0 ? { slotSnapshots: slots } : {}),
      providerState: {
        prompt: promptPreparation.prompt,
      } satisfies PreparedPromptState,
      diagnostics: {
        requestShape,
        ...promptPreparation.diagnostics,
        ...(detectedCapabilities.contextWindow
          ? { contextWindow: detectedCapabilities.contextWindow }
          : {}),
        ...(slotSelection.preferredSlot !== undefined
          ? { preferredSlot: slotSelection.preferredSlot }
          : {}),
        ...(slotSelection.routeReason ? { slotRouteReason: slotSelection.routeReason } : {}),
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
    const initial = await this.requestChatCompletion(
      buildChatCompletionPayload({
        modelRef: this.adapter.modelRef,
        request,
        user: context.requestId,
      }),
      context,
      preparation.promptTokens,
    );
    let output = initial.output;
    let usage = initial.usage;
    let rawPayload = initial.payload;
    let jsonRepairAttempted = false;
    let jsonRepairSucceeded = false;

    if (request.responseFormat?.type === "json_object" && !isValidJsonObject(output)) {
      jsonRepairAttempted = true;

      const repaired = await this.requestChatCompletion(
        {
          model: this.adapter.modelRef,
          stream: false,
          temperature: 0,
          top_p: 1,
          max_tokens: Math.max(32, Math.min(request.maxTokens, 128)),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Repair the assistant output into one valid compact JSON object. Return only JSON.",
            },
            {
              role: "user",
              content: `Original task:\n${request.input}\n\nAssistant output to repair:\n${output}`,
            },
          ],
          user: context.requestId,
        },
        context,
      );

      if (isValidJsonObject(repaired.output)) {
        output = repaired.output;
        rawPayload = repaired.payload;
        usage = mergeUsage(usage, repaired.usage);
        jsonRepairSucceeded = true;
      } else {
        usage = mergeUsage(usage, repaired.usage);
      }
    }

    return {
      output,
      ...(usage ? { usage } : {}),
      diagnostics: {
        requestShape: "openai-chat",
        ...(jsonRepairAttempted ? { jsonRepairAttempted } : {}),
        ...(jsonRepairAttempted ? { jsonRepairSucceeded } : {}),
        ...(preparation.diagnostics?.promptFormat
          ? { promptFormat: preparation.diagnostics.promptFormat }
          : {}),
        ...(preparation.diagnostics?.promptFormatReason
          ? { promptFormatReason: preparation.diagnostics.promptFormatReason }
          : {}),
        ...(preparation.diagnostics?.modelRef
          ? { modelRef: preparation.diagnostics.modelRef }
          : {}),
        ...(preparation.diagnostics?.backendModel
          ? { backendModel: preparation.diagnostics.backendModel }
          : {}),
        ...(preparation.diagnostics?.launchPreset
          ? { launchPreset: preparation.diagnostics.launchPreset }
          : {}),
        ...(typeof preparation.diagnostics?.totalSlots === "number"
          ? { totalSlots: preparation.diagnostics.totalSlots }
          : {}),
        ...(preparation.preferredSlot !== undefined
          ? { preferredSlot: preparation.preferredSlot }
          : {}),
        ...(preparation.diagnostics?.slotRouteReason
          ? { slotRouteReason: preparation.diagnostics.slotRouteReason }
          : {}),
        ...(typeof preparation.diagnostics?.contextWindow === "number"
          ? { contextWindow: preparation.diagnostics.contextWindow }
          : {}),
      },
      raw: rawPayload,
    };
  }

  private async requestChatCompletion(
    payload: Record<string, unknown>,
    context: ProviderContext,
    fallbackPromptTokens?: number,
  ): Promise<ChatCompletionInferenceResult> {
    const response = (await this.request(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      this.adapter.timeoutMs,
      context.signal,
    )) as OpenAICompatibleResponse;
    const output = extractAssistantText(response);
    const prompt = response.usage?.prompt_tokens ?? fallbackPromptTokens ?? 0;
    const completion = response.usage?.completion_tokens ?? 0;
    const usage =
      response.usage || fallbackPromptTokens !== undefined
        ? {
            tokens: {
              prompt,
              completion,
              total: response.usage?.total_tokens ?? prompt + completion,
            },
          }
        : undefined;

    return {
      output,
      payload: response,
      ...(usage ? { usage } : {}),
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

    const requestedSlot = preparation.preferredSlot ?? this.adapter.slotId ?? -1;
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
          id_slot: requestedSlot,
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
    const slotId = payload.generation_settings?.id_slot ?? preparation.preferredSlot;

    if (typeof slotId === "number" && context.affinityKey) {
      this.familyPreferredSlots.set(context.affinityKey, slotId);
      this.slotFamilyAssignments.set(slotId, context.affinityKey);
    }

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
        ...(preparation.diagnostics?.promptFormat
          ? { promptFormat: preparation.diagnostics.promptFormat }
          : {}),
        ...(preparation.diagnostics?.promptFormatReason
          ? { promptFormatReason: preparation.diagnostics.promptFormatReason }
          : {}),
        ...(preparation.diagnostics?.modelRef
          ? { modelRef: preparation.diagnostics.modelRef }
          : {}),
        ...(preparation.diagnostics?.backendModel
          ? { backendModel: preparation.diagnostics.backendModel }
          : {}),
        ...(preparation.diagnostics?.launchPreset
          ? { launchPreset: preparation.diagnostics.launchPreset }
          : {}),
        ...(typeof preparation.diagnostics?.totalSlots === "number"
          ? { totalSlots: preparation.diagnostics.totalSlots }
          : {}),
        ...(slotId !== undefined ? { slotId } : {}),
        ...(preparation.preferredSlot !== undefined
          ? { preferredSlot: preparation.preferredSlot }
          : {}),
        ...(payload.tokens_cached !== undefined ? { tokensCached: payload.tokens_cached } : {}),
        ...(typeof tokensEvaluated === "number" ? { tokensEvaluated } : {}),
        ...(payload.truncated !== undefined ? { truncated: payload.truncated } : {}),
        ...(preparation.diagnostics?.slotRouteReason
          ? { slotRouteReason: preparation.diagnostics.slotRouteReason }
          : {}),
        contextWindow: payload.generation_settings?.n_ctx ?? this.model.contextWindow,
        ...timingDiagnostics,
      },
      raw: payload,
    };
  }

  private async preparePrompt(
    request: NormalizedInferenceRequest,
    signal?: AbortSignal,
    detectedCapabilities?: ProviderDetectedCapabilities,
  ): Promise<PromptPreparation> {
    const capabilities =
      detectedCapabilities ?? (await this.detectCapabilities(signal, { includeJsonProbe: false }));
    const baseDiagnostics = {
      modelRef: this.adapter.modelRef,
      ...(capabilities.backendModel ? { backendModel: capabilities.backendModel } : {}),
      ...(this.adapter.launchProfile?.preset
        ? { launchPreset: this.adapter.launchProfile.preset }
        : {}),
      ...(typeof capabilities.totalSlots === "number"
        ? { totalSlots: capabilities.totalSlots }
        : {}),
    };
    const preferredFormat = this.model.operational?.recommendedPromptFormat;
    const promptFormatOverride = resolvePromptFormatOverride(request);

    if (
      promptFormatOverride === "ray-chat-fallback" ||
      preferredFormat === "plain-completion" ||
      (promptFormatOverride !== "llama.cpp-template" &&
        (capabilities.applyTemplate === "unavailable" ||
          capabilities.chatTemplate === "unavailable"))
    ) {
      return {
        prompt: this.buildFallbackPrompt(request),
        diagnostics: {
          promptFormat: "ray-chat-fallback",
          promptFormatReason:
            promptFormatOverride === "ray-chat-fallback"
              ? "metadata forced ray fallback prompt"
              : preferredFormat === "plain-completion"
                ? "model prefers plain completion"
                : capabilities.applyTemplate === "unavailable"
                  ? "llama.cpp /apply-template unavailable"
                  : "llama.cpp chat template unavailable",
          ...baseDiagnostics,
        },
      };
    }

    if (
      request.promptTemplateId &&
      request.templateVariables &&
      promptFormatOverride !== "llama.cpp-template"
    ) {
      try {
        const scaffold = await this.getPromptScaffold(
          request.promptTemplateId,
          request.responseFormat?.type ?? "text",
          signal,
        );
        return {
          prompt: this.renderPromptFromScaffold(scaffold, request.templateVariables),
          diagnostics: {
            promptFormat: "prompt-scaffold",
            promptFormatReason:
              promptFormatOverride === "prompt-scaffold"
                ? "metadata forced prompt scaffold"
                : "template request reused cached llama.cpp scaffold",
            ...baseDiagnostics,
          },
        };
      } catch (error) {
        if (this.canFallbackPrompt(error) && promptFormatOverride !== "prompt-scaffold") {
          return {
            prompt: this.buildFallbackPrompt(request),
            diagnostics: {
              promptFormat: "ray-chat-fallback",
              promptFormatReason: `prompt scaffold failed: ${toErrorMessage(error)}`,
              ...baseDiagnostics,
            },
          };
        }

        throw error;
      }
    }

    try {
      return {
        prompt: await this.applyTemplate(request, signal),
        diagnostics: {
          promptFormat: "llama.cpp-template",
          promptFormatReason: "llama.cpp native template applied",
          ...baseDiagnostics,
        },
      };
    } catch (error) {
      if (this.canFallbackPrompt(error)) {
        return {
          prompt: this.buildFallbackPrompt(request),
          diagnostics: {
            promptFormat: "ray-chat-fallback",
            promptFormatReason: `native template failed: ${toErrorMessage(error)}`,
            ...baseDiagnostics,
          },
        };
      }

      throw error;
    }
  }

  private canFallbackPrompt(error: unknown): boolean {
    return (
      error instanceof RayError &&
      (error.code === "provider_upstream_error" ||
        error.code === "provider_invalid_response" ||
        error.code === "provider_request_failed")
    );
  }

  private buildFallbackPrompt(request: NormalizedInferenceRequest): string {
    const format = this.model.operational?.recommendedPromptFormat;

    if (format === "plain-completion") {
      return [request.system, request.input].filter((part) => part && part.length > 0).join("\n\n");
    }

    return [
      ...(request.system ? [`System:\n${request.system}`] : []),
      `User:\n${request.input}`,
      "Assistant:",
    ].join("\n\n");
  }

  private async countPromptTokens(prompt: string, signal?: AbortSignal): Promise<number> {
    const cacheKey = hashValue({
      model: this.adapter.modelRef,
      prompt,
    });
    const cached = this.promptTokenCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const promptTokens = await this.tokenize(prompt, signal);
    this.setPromptTokenCache(cacheKey, promptTokens);
    return promptTokens;
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
      Math.min(this.adapter.timeoutMs, TOKENIZE_TIMEOUT_MS),
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

  private async getPromptScaffold(
    templateId: string,
    responseFormatType: "text" | "json_object",
    signal?: AbortSignal,
  ): Promise<PromptScaffold> {
    const cacheKey = hashValue({
      model: this.adapter.modelRef,
      templateId,
      responseFormatType,
    });
    const cached = this.promptScaffolds.get(cacheKey);
    if (cached) {
      return cached;
    }

    const template = requirePromptTemplate(templateId);
    const sentinelVariables = Object.fromEntries(
      template.variables.map((variable: string, index: number) => [
        variable,
        `__RAY_PROMPT_VAR_${index}__`,
      ]),
    );
    const rendered = renderPromptTemplate(template.id, sentinelVariables);
    const prompt = await this.applyTemplate(
      {
        input: rendered.input,
        ...(rendered.system ? { system: rendered.system } : {}),
        maxTokens: rendered.maxTokens ?? 1,
        temperature: 0,
        topP: 1,
        cache: false,
        metadata: rendered.metadata,
        promptTemplateId: rendered.id,
        templateVariables: rendered.templateVariables,
        promptLane: rendered.lane,
        promptFamily: rendered.family,
        ...(rendered.responseFormat ? { responseFormat: rendered.responseFormat } : {}),
      },
      signal,
    );
    const segments: string[] = [];
    let cursor = 0;

    for (const variable of template.variables) {
      const sentinel = sentinelVariables[variable];
      if (!sentinel) {
        throw new RayError(`Prompt scaffold marker "${variable}" is missing`, {
          code: "provider_invalid_response",
          status: 500,
        });
      }
      const position = prompt.indexOf(sentinel, cursor);

      if (position === -1) {
        throw new RayError(
          `Prompt scaffold marker "${variable}" was not found in rendered prompt`,
          {
            code: "provider_invalid_response",
            status: 500,
          },
        );
      }

      segments.push(prompt.slice(cursor, position));
      cursor = position + sentinel.length;
    }

    segments.push(prompt.slice(cursor));
    const scaffold: PromptScaffold = {
      segments,
      variableOrder: [...template.variables],
    };
    this.setPromptScaffold(cacheKey, scaffold);
    return scaffold;
  }

  private renderPromptFromScaffold(
    scaffold: PromptScaffold,
    templateVariables: Record<string, string>,
  ): string {
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

  private async getSlotSnapshots(signal?: AbortSignal): Promise<SchedulerSlotSnapshot[]> {
    const now = Date.now();
    const ttlMs = this.adapter.slotStateTtlMs ?? 250;

    if (this.slotStateCache && now - this.slotStateCache.checkedAtMs < ttlMs) {
      return this.slotStateCache.slots;
    }

    let snapshots: SchedulerSlotSnapshot[] = [];

    try {
      const payload = await this.request(
        "/slots",
        { method: "GET" },
        Math.min(
          this.adapter.timeoutMs,
          this.adapter.slotSnapshotTimeoutMs ?? DEFAULT_SLOT_SNAPSHOT_TIMEOUT_MS,
        ),
        signal,
      );
      snapshots = parseSlotSnapshots(payload);
    } catch (error) {
      if (error instanceof RayError) {
        if (error.code === "provider_upstream_error" && /\b404\b/.test(error.message)) {
          this.slotStateCache = {
            checkedAtMs: now,
            slots: [],
          };
          return [];
        }

        // Slot snapshots improve affinity and queueing, but inference can still
        // proceed safely without them on small single-node backends.
        if (error.code === "provider_timeout" || error.code === "provider_request_failed") {
          const fallbackSlots = this.slotStateCache?.slots ?? [];
          this.slotStateCache = {
            checkedAtMs: now,
            slots: fallbackSlots,
          };
          return fallbackSlots;
        }
      }
      throw error;
    }

    this.slotStateCache = {
      checkedAtMs: now,
      slots: snapshots,
    };
    return snapshots;
  }

  private selectPreferredSlot(
    affinityKey: string | undefined,
    slots: SchedulerSlotSnapshot[],
  ): { preferredSlot?: number; routeReason?: string } {
    if (!affinityKey || slots.length === 0) {
      return {};
    }

    const mappedSlotId = this.familyPreferredSlots.get(affinityKey);
    if (mappedSlotId !== undefined) {
      const mappedSlot = slots.find((slot) => slot.id === mappedSlotId);
      if (mappedSlot) {
        return {
          preferredSlot: mappedSlot.id,
          routeReason: mappedSlot.isProcessing ? "family_hot_busy" : "family_hot_idle",
        };
      }
    }

    const assignedIdleSlot = slots.find(
      (slot) => !slot.isProcessing && this.slotFamilyAssignments.get(slot.id) === affinityKey,
    );
    if (assignedIdleSlot) {
      return {
        preferredSlot: assignedIdleSlot.id,
        routeReason: "family_recent_idle",
      };
    }

    const idleUnassignedSlot = slots.find(
      (slot) => !slot.isProcessing && !this.slotFamilyAssignments.has(slot.id),
    );
    if (idleUnassignedSlot) {
      return {
        preferredSlot: idleUnassignedSlot.id,
        routeReason: "idle_slot",
      };
    }

    const firstIdleSlot = slots.find((slot) => !slot.isProcessing);
    if (firstIdleSlot) {
      return {
        preferredSlot: firstIdleSlot.id,
        routeReason: "idle_fallback",
      };
    }

    return mappedSlotId !== undefined
      ? {
          preferredSlot: mappedSlotId,
          routeReason: "family_hot_busy",
        }
      : {};
  }

  private buildPreparationCacheKey(request: NormalizedInferenceRequest): string {
    return hashValue({
      model: this.adapter.modelRef,
      input: request.input,
      system: request.system ?? "",
      responseFormat: request.responseFormat?.type ?? "text",
      promptTemplateId: request.promptTemplateId ?? "",
      templateVariables: request.templateVariables ?? {},
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

  private setPromptTokenCache(key: string, tokenCount: number): void {
    if (this.promptTokenCache.has(key)) {
      this.promptTokenCache.delete(key);
    }

    this.promptTokenCache.set(key, tokenCount);

    while (this.promptTokenCache.size > this.maxPromptTokenCacheEntries) {
      const oldestKey = this.promptTokenCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.promptTokenCache.delete(oldestKey);
    }
  }

  private setPromptScaffold(key: string, scaffold: PromptScaffold): void {
    if (this.promptScaffolds.has(key)) {
      this.promptScaffolds.delete(key);
    }

    this.promptScaffolds.set(key, scaffold);

    while (this.promptScaffolds.size > this.maxPromptScaffoldEntries) {
      const oldestKey = this.promptScaffolds.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.promptScaffolds.delete(oldestKey);
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
          shortJobMaxTokens: 1,
        },
        asyncQueue: {
          enabled: false,
          storageDir: "",
          pollIntervalMs: 1,
          dispatchConcurrency: 1,
          maxAttempts: 1,
          callbackTimeoutMs: 1,
          maxCallbackAttempts: 1,
          callbackAllowPrivateNetwork: false,
          callbackAllowedHosts: [],
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
          learnedFamilyCapEnabled: false,
          familyHistorySize: 1,
          learnedCapMinSamples: 1,
          draftPercentile: 1,
          shortPercentile: 1,
          learnedCapHeadroomTokens: 1,
        },
        auth: {
          enabled: false,
        },
        rateLimit: {
          enabled: false,
          windowMs: 1,
          maxRequests: 1,
          maxKeys: 1,
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
