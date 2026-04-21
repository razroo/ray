export type RayProfile = "tiny" | "vps" | "balanced";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type ProviderKind = "mock" | "openai-compatible";
export type Quantization = "q4_0" | "q4_k_m" | "q5_k_m" | "q8_0" | "fp16" | "unknown";
export type ProviderHealthStatus = "unknown" | "ready" | "warming" | "degraded" | "unavailable";
export type RateLimitKeyStrategy = "ip" | "api-key" | "ip+api-key";

export interface ServerConfig {
  host: string;
  port: number;
  requestBodyLimitBytes: number;
}

export interface OpenAICompatibleProviderConfig {
  kind: "openai-compatible";
  baseUrl: string;
  modelRef: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
}

export interface MockProviderConfig {
  kind: "mock";
  seed?: string;
  latencyMs: number;
}

export type ProviderConfig = OpenAICompatibleProviderConfig | MockProviderConfig;

export interface ModelConfig {
  id: string;
  family: string;
  quantization: Quantization;
  contextWindow: number;
  warmOnBoot: boolean;
  maxOutputTokens: number;
  adapter: ProviderConfig;
}

export interface SchedulerConfig {
  concurrency: number;
  maxQueue: number;
  requestTimeoutMs: number;
  dedupeInflight: boolean;
  batchWindowMs: number;
}

export interface CacheConfig {
  enabled: boolean;
  maxEntries: number;
  ttlMs: number;
  keyStrategy: "input" | "input+params";
}

export interface TelemetryConfig {
  serviceName: string;
  logLevel: LogLevel;
  includeDebugMetrics: boolean;
  slowRequestThresholdMs: number;
}

export interface GracefulDegradationConfig {
  enabled: boolean;
  queueDepthThreshold: number;
  maxPromptChars: number;
  degradeToMaxTokens: number;
}

export interface AuthConfig {
  enabled: boolean;
  apiKeyEnv?: string;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
  keyStrategy: RateLimitKeyStrategy;
  trustProxyHeaders: boolean;
}

export interface RayConfig {
  profile: RayProfile;
  server: ServerConfig;
  model: ModelConfig;
  scheduler: SchedulerConfig;
  cache: CacheConfig;
  telemetry: TelemetryConfig;
  gracefulDegradation: GracefulDegradationConfig;
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
  tags: Record<string, string>;
}

export interface InferenceRequest {
  input: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  cache?: boolean;
  dedupeKey?: string;
  metadata?: Record<string, string>;
}

export interface NormalizedInferenceRequest {
  input: string;
  system?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  cache: boolean;
  dedupeKey?: string;
  metadata: Record<string, string>;
}

export interface UsageBreakdown {
  prompt: number;
  completion: number;
  total: number;
}

export interface UsageStats {
  chars: UsageBreakdown;
  tokens?: UsageBreakdown;
}

export interface PartialUsageStats {
  chars?: Partial<UsageBreakdown>;
  tokens?: Partial<UsageBreakdown>;
}

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface ProviderResult {
  output: string;
  usage?: PartialUsageStats;
  raw?: unknown;
}

export interface ProviderCapabilities {
  streaming: boolean;
  quantized: boolean;
  localBackend: boolean;
}

export interface ProviderContext {
  signal: AbortSignal;
  requestId: string;
  config: RayConfig;
  startedAt: number;
}

export interface ModelProvider {
  readonly modelId: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  warm?(): Promise<void>;
  health?(): Promise<ProviderHealthSnapshot>;
  infer(request: NormalizedInferenceRequest, context: ProviderContext): Promise<ProviderResult>;
}

export interface InferenceResponse {
  id: string;
  model: string;
  output: string;
  usage: UsageStats;
  cached: boolean;
  deduplicated: boolean;
  queueTimeMs: number;
  latencyMs: number;
  degraded: boolean;
  createdAt: string;
}

export interface HealthSnapshot {
  status: "ok" | "degraded" | "unavailable";
  uptimeMs: number;
  queueDepth: number;
  inFlight: number;
  cacheEntries: number;
  profile: RayProfile;
  modelId: string;
  provider: ProviderHealthSnapshot;
}

export interface SchedulerSnapshot {
  queueDepth: number;
  inFlight: number;
  maxQueue: number;
  concurrency: number;
}

export interface RuntimeMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  recent?: {
    lastLatencyMs: number | null;
    lastCacheHitAt: string | null;
    lastRequestAt: string | null;
    lastErrorAt: string | null;
    lastDegradedAt: string | null;
    lastRateLimitAt: string | null;
    lastAuthRejectAt: string | null;
  };
}
