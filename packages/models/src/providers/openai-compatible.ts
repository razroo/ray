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
import { adapterRequest, extractAssistantText } from "./http.js";

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

function extractModelIds(payload: unknown): string[] | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }

  const data = (payload as OpenAICompatibleModelsResponse).data;

  if (!Array.isArray(data)) {
    return undefined;
  }

  return data
    .map((entry) => (typeof entry?.id === "string" ? entry.id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = "openai-compatible";
  readonly modelId: string;
  readonly capabilities = {
    streaming: false,
    quantized: true,
    localBackend: true,
  } as const;

  constructor(
    private readonly model: ModelConfig,
    private readonly adapter: OpenAICompatibleProviderConfig,
  ) {
    this.modelId = model.id;
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
      const modelIds = extractModelIds(response);
      const latencyMs = Date.now() - startedAt;

      if (modelIds && modelIds.length > 0) {
        if (!modelIds.includes(this.adapter.modelRef)) {
          return {
            status: "unavailable",
            checkedAt: new Date().toISOString(),
            latencyMs,
            details: {
              probe: "/v1/models",
              message: `Configured modelRef "${this.adapter.modelRef}" is not exposed by the backend`,
              availableModels: modelIds.slice(0, 10),
            },
          };
        }

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

    return {
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      details: {
        message: toErrorMessage(lastFailure),
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

    const output = extractAssistantText(payload);
    const usage: ProviderResult["usage"] = {};

    if (
      payload.usage?.prompt_tokens !== undefined ||
      payload.usage?.completion_tokens !== undefined ||
      payload.usage?.total_tokens !== undefined
    ) {
      const prompt = payload.usage?.prompt_tokens ?? 0;
      const completion = payload.usage?.completion_tokens ?? 0;

      usage.tokens = {
        prompt,
        completion,
        total: payload.usage?.total_tokens ?? prompt + completion,
      };
    }

    return {
      output,
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
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
