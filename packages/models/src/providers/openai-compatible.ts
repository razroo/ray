import {
  RayError,
  type ModelConfig,
  type ModelProvider,
  type NormalizedInferenceRequest,
  type OpenAICompatibleProviderConfig,
  type ProviderContext,
  type ProviderResult,
} from "@ray/core";

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function extractAssistantText(payload: OpenAICompatibleResponse): string {
  const choice = payload.choices?.[0];

  if (!choice) {
    throw new RayError("The backend returned no choices", {
      code: "provider_invalid_response",
      status: 502,
    });
  }

  if (typeof choice.text === "string" && choice.text.length > 0) {
    return choice.text;
  }

  const content = choice.message?.content;

  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new RayError("The backend returned an empty response body", {
    code: "provider_invalid_response",
    status: 502,
  });
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

  async infer(request: NormalizedInferenceRequest, context: ProviderContext): Promise<ProviderResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.adapter.headers ?? {}),
    };

    if (this.adapter.apiKeyEnv) {
      const apiKey = process.env[this.adapter.apiKeyEnv];
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }

    const response = await fetch(`${normalizeBaseUrl(this.adapter.baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.adapter.modelRef,
        stream: false,
        temperature: request.temperature,
        top_p: request.topP,
        max_tokens: request.maxTokens,
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          { role: "user", content: request.input },
        ],
        user: context.requestId,
      }),
      signal: context.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RayError(`The backend rejected the inference request with ${response.status}`, {
        code: "provider_upstream_error",
        status: 502,
        details: body,
      });
    }

    const payload = (await response.json()) as OpenAICompatibleResponse;
    const output = extractAssistantText(payload);

    const usage: ProviderResult["usage"] = {};

    if (payload.usage?.prompt_tokens !== undefined) {
      usage.promptChars = payload.usage.prompt_tokens;
    }

    if (payload.usage?.completion_tokens !== undefined) {
      usage.completionChars = payload.usage.completion_tokens;
    }

    if (payload.usage?.total_tokens !== undefined) {
      usage.totalChars = payload.usage.total_tokens;
    }

    return {
      output,
      usage,
      raw: payload,
    };
  }
}
