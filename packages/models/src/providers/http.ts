import {
  RayError,
  toErrorMessage,
  type LlamaCppProviderConfig,
  type OpenAICompatibleProviderConfig,
} from "@razroo/ray-core";

interface OpenAICompatibleResponse {
  choices?: Array<{
    text?: string;
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

type HttpAdapterConfig = Pick<
  OpenAICompatibleProviderConfig | LlamaCppProviderConfig,
  "baseUrl" | "timeoutMs" | "headers" | "apiKeyEnv"
>;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function buildAdapterHeaders(adapter: HttpAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(adapter.headers ?? {}),
  };

  if (adapter.apiKeyEnv) {
    const apiKey = process.env[adapter.apiKeyEnv];
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }

  return headers;
}

export async function adapterRequest(
  adapter: HttpAdapterConfig,
  pathname: string,
  init: RequestInit,
  timeoutMs = adapter.timeoutMs,
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
    const response = await fetch(`${normalizeBaseUrl(adapter.baseUrl)}${pathname}`, {
      ...init,
      headers: {
        ...buildAdapterHeaders(adapter),
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

export function extractAssistantText(payload: OpenAICompatibleResponse): string {
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
