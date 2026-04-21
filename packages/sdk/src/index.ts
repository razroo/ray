import type {
  HealthSnapshot,
  InferenceRequest,
  InferenceResponse,
  RuntimeMetricsSnapshot,
} from "@ray/core";

export interface RayClientOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export class RayClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: RayClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.headers = {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    };

    if (options.apiKey) {
      this.headers.authorization = `Bearer ${options.apiKey}`;
    }
  }

  infer(request: InferenceRequest): Promise<InferenceResponse> {
    return this.request<InferenceResponse>("/v1/infer", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  health(): Promise<HealthSnapshot> {
    return this.request<HealthSnapshot>("/health");
  }

  metrics(): Promise<RuntimeMetricsSnapshot> {
    return this.request<RuntimeMetricsSnapshot>("/metrics");
  }

  config(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/config");
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ray request failed with ${response.status}: ${body}`);
    }

    return (await response.json()) as T;
  }
}
