import {
  RayError,
  toErrorMessage,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type OpenAICompatibleProviderConfig,
  type ProviderContext,
  type ProviderHealthSnapshot,
  type ProviderResult,
  type WarmupInferenceRequest,
} from "@razroo/ray-core";
import { resolvePromptTemplateRequest } from "@ray/prompts";
import {
  MAX_ADAPTER_MODEL_REF_CHARS,
  adapterRequest,
  assertKnownObjectKeys,
  assertNonEmptyStringAtMost,
  extractAssistantText,
  normalizeOpenAICompatibleTokenUsage,
  resolveAssistantTextLimit,
  snapshotAdapterWarmupRequests,
  snapshotHttpAdapterConfig,
} from "./http.js";

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

interface OpenAICompatibleModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

const MAX_DISCOVERED_MODEL_ENTRIES = 4_096;
const MAX_DISCOVERED_MODEL_IDS = 64;
const MAX_DISCOVERED_MODEL_ID_CHARS = MAX_ADAPTER_MODEL_REF_CHARS;
const MAX_HEALTH_DETAIL_MODEL_IDS = 10;
const openAIAdapterKeys = new Set([
  "kind",
  "baseUrl",
  "modelRef",
  "apiKeyEnv",
  "timeoutMs",
  "headers",
  "warmupRequests",
]);

interface OpenAICompatibleModelIdsSnapshot {
  ids: string[];
  foundModelRef: boolean;
  scannedAllEntries: boolean;
  validModelCount: number;
}

function buildChatCompletionPayload(options: {
  modelRef: string;
  input: string;
  system?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  seed?: number;
  stop?: string[];
  responseFormat?: WarmupInferenceRequest["responseFormat"];
  user: string;
}): Record<string, unknown> {
  return {
    model: options.modelRef,
    stream: false,
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens,
    messages: [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      { role: "user", content: options.input },
    ],
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    user: options.user,
  };
}

function readModelId(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }

  try {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 && id.length <= MAX_DISCOVERED_MODEL_ID_CHARS
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

function extractModelIds(
  payload: unknown,
  modelRef: string,
): OpenAICompatibleModelIdsSnapshot | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }

  let data: unknown;

  try {
    data = (payload as OpenAICompatibleModelsResponse).data;
  } catch {
    return undefined;
  }

  if (!Array.isArray(data)) {
    return undefined;
  }

  const ids: string[] = [];
  let foundModelRef = false;
  let validModelCount = 0;
  const entriesToScan = Math.min(data.length, MAX_DISCOVERED_MODEL_ENTRIES);

  for (let index = 0; index < entriesToScan; index += 1) {
    const id = readModelId(data[index]);

    if (id === undefined) {
      continue;
    }

    if (id === modelRef) {
      foundModelRef = true;
    }

    validModelCount += 1;

    if (ids.length < MAX_DISCOVERED_MODEL_IDS) {
      ids.push(id);
    }
  }

  return {
    ids,
    foundModelRef,
    scannedAllEntries: entriesToScan === data.length,
    validModelCount,
  };
}

function snapshotOpenAIAdapter(
  adapter: OpenAICompatibleProviderConfig,
  maxOutputTokens: number,
): OpenAICompatibleProviderConfig {
  assertKnownObjectKeys(adapter, "adapter", openAIAdapterKeys);
  const snapshot = snapshotHttpAdapterConfig(adapter);
  assertNonEmptyStringAtMost(snapshot.modelRef, "adapter.modelRef", MAX_ADAPTER_MODEL_REF_CHARS);
  const warmupRequests = snapshotAdapterWarmupRequests(snapshot.warmupRequests, maxOutputTokens);
  const next: OpenAICompatibleProviderConfig = { ...snapshot };

  if (warmupRequests !== undefined) {
    next.warmupRequests = warmupRequests;
  }

  return next;
}

function describeAdapterBaseUrlPath(baseUrl: string): string | undefined {
  const pathname = new URL(baseUrl).pathname;
  return pathname === "/" ? undefined : pathname;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = "openai-compatible";
  readonly modelId: string;
  readonly capabilities = {
    streaming: false,
    quantized: true,
    localBackend: true,
  } as const;
  private readonly adapter: OpenAICompatibleProviderConfig;

  constructor(model: ModelConfig, adapter: OpenAICompatibleProviderConfig) {
    this.modelId = model.id;
    this.adapter = snapshotOpenAIAdapter(adapter, model.maxOutputTokens);
  }

  async warm(): Promise<void> {
    const warmupRequests =
      this.adapter.warmupRequests && this.adapter.warmupRequests.length > 0
        ? this.adapter.warmupRequests
        : [{ input: "ping" } satisfies WarmupInferenceRequest];

    for (const request of warmupRequests) {
      const resolved = resolvePromptTemplateRequest(request);
      await this.request("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(
          buildChatCompletionPayload({
            modelRef: this.adapter.modelRef,
            input: resolved.input ?? "ping",
            ...(resolved.system ? { system: resolved.system } : {}),
            maxTokens: resolved.maxTokens ?? 1,
            temperature: 0,
            topP: 1,
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
            ...(request.stop ? { stop: request.stop } : {}),
            ...(resolved.responseFormat ? { responseFormat: resolved.responseFormat } : {}),
            user: "ray_warmup",
          }),
        ),
      });
    }
  }

  async health(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();
    let lastFailure: unknown;

    try {
      const response = await this.request(
        "/v1/models",
        { method: "GET" },
        Math.min(this.adapter.timeoutMs, 5_000),
      );
      const modelIds = extractModelIds(response, this.adapter.modelRef);
      const latencyMs = Date.now() - startedAt;

      if (modelIds && modelIds.validModelCount > 0) {
        if (!modelIds.foundModelRef && modelIds.scannedAllEntries) {
          const availableModels = modelIds.ids.slice(0, MAX_HEALTH_DETAIL_MODEL_IDS);

          return {
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            latencyMs,
            details: {
              probe: "/v1/models",
              message: `Configured modelRef "${this.adapter.modelRef}" is not exposed by the backend`,
              availableModels,
              ...(modelIds.validModelCount > availableModels.length
                ? { availableModelsTruncated: true }
                : {}),
            },
          };
        }

        if (modelIds.foundModelRef) {
          return {
            status: "ready",
            checkedAt: new Date().toISOString(),
            latencyMs,
            details: {
              probe: "/v1/models",
              modelRef: this.adapter.modelRef,
            },
          };
        }
      }
    } catch (error) {
      lastFailure = error;
    }

    try {
      await this.request("/health", { method: "GET" }, Math.min(this.adapter.timeoutMs, 5_000));
      return {
        status: "ready",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: {
          probe: "/health",
        },
      };
    } catch (error) {
      lastFailure = error;
    }

    const baseUrlPath = describeAdapterBaseUrlPath(this.adapter.baseUrl);

    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      details: {
        probe: "/v1/models + /health",
        message: toErrorMessage(lastFailure),
        ...(baseUrlPath ? { baseUrlPath } : {}),
      },
    };
  }

  async infer(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    const payload = (await this.request(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(
          buildChatCompletionPayload({
            modelRef: this.adapter.modelRef,
            input: request.input,
            ...(request.system ? { system: request.system } : {}),
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            topP: request.topP,
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
            ...(request.stop ? { stop: request.stop } : {}),
            ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
            user: context.requestId,
          }),
        ),
      },
      this.adapter.timeoutMs,
      context.signal,
    )) as OpenAICompatibleResponse;

    const output = extractAssistantText(payload, {
      maxChars: resolveAssistantTextLimit(request.maxTokens),
    });
    const usage = normalizeOpenAICompatibleTokenUsage(payload);

    return {
      output,
      ...(usage ? { usage } : {}),
      diagnostics: {
        requestShape: "openai-chat",
      },
      raw: payload,
    };
  }

  private async request(
    pathname: string,
    init: RequestInit,
    timeoutMs = this.adapter.timeoutMs,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await adapterRequest(this.adapter, pathname, init, timeoutMs, parentSignal);
    } catch (error) {
      if (error instanceof RayError) {
        throw error;
      }

      throw new RayError(`The backend request failed: ${toErrorMessage(error)}`, {
        code: "provider_request_failed",
        status: 502,
        details: error,
      });
    }
  }
}
