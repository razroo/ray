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
} from "@razroo/ray-core";

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

  async warm(): Promise<void> {
    await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: this.adapter.modelRef,
        stream: false,
        temperature: 0,
        top_p: 1,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
        user: "ray_warmup",
      }),
    });
  }

  async health(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();
    const probes = ["/health", "/v1/models"];
    let lastFailure: unknown;

    for (const pathname of probes) {
      try {
        const response = await this.request(
          pathname,
          { method: "GET" },
          Math.min(this.adapter.timeoutMs, 5_000),
        );
        const latencyMs = Date.now() - startedAt;
        const details =
          pathname === "/v1/models" &&
          response !== undefined &&
          response !== null &&
          typeof response === "object"
            ? { probe: pathname }
            : { probe: pathname };

        return {
          status: "ready",
          checkedAt: new Date().toISOString(),
          latencyMs,
          details,
        };
      } catch (error) {
        lastFailure = error;
      }
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
      raw: payload,
    };
  }

  private buildHeaders(): Record<string, string> {
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

    return headers;
  }

  private async request(
    pathname: string,
    init: RequestInit,
    timeoutMs = this.adapter.timeoutMs,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new RayError(`The backend did not respond within ${timeoutMs}ms`, {
          code: "provider_timeout",
          status: 504,
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
              details: parentSignal?.reason,
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
      const response = await fetch(`${normalizeBaseUrl(this.adapter.baseUrl)}${pathname}`, {
        ...init,
        headers: {
          ...this.buildHeaders(),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new RayError(`The backend rejected the request with ${response.status}`, {
          code: "provider_upstream_error",
          status: 502,
          details: body,
        });
      }

      if (response.status === 204) {
        return undefined;
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        return (await response.json()) as unknown;
      }

      return await response.text();
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
        details: error,
      });
    } finally {
      clearTimeout(timeout);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent);
      }
    }
  }
}
