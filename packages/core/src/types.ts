export type RayProfile = "tiny" | "sub1b" | "1b" | "vps" | "balanced";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type ProviderKind = "mock" | "openai-compatible" | "llama.cpp";
export type Quantization = "q4_0" | "q4_k_m" | "q5_k_m" | "q8_0" | "fp16" | "unknown";
export type ProviderHealthStatus = "unknown" | "ready" | "warming" | "degraded" | "unavailable";
export type RateLimitKeyStrategy = "ip" | "api-key" | "ip+api-key";
export type ResponseFormatType = "text" | "json_object";
export type InferenceJobStatus = "queued" | "running" | "succeeded" | "failed";
export type InferenceJobCallbackStatus = "pending" | "delivered" | "failed";
export type ScheduleLane = "short" | "draft";
export type PromptTemplateVariableValue = string | number | boolean;
export type PromptTemplateVariables = Record<string, PromptTemplateVariableValue>;

export interface ServerConfig {
  host: string;
  port: number;
  requestBodyLimitBytes: number;
}

export interface WarmupInferenceRequest {
  input?: string;
  system?: string;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
  responseFormat?: InferenceResponseFormat;
  templateId?: string;
  templateVariables?: PromptTemplateVariables;
}

export interface InferenceResponseFormat {
  type: ResponseFormatType;
}

export interface OpenAICompatibleProviderConfig {
  kind: "openai-compatible";
  baseUrl: string;
  modelRef: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  warmupRequests?: WarmupInferenceRequest[];
}

export interface LlamaCppProviderConfig {
  kind: "llama.cpp";
  baseUrl: string;
  modelRef: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  warmupRequests?: WarmupInferenceRequest[];
  cachePrompt?: boolean;
  slotId?: number;
  slotStateTtlMs?: number;
  slotSnapshotTimeoutMs?: number;
  promptScaffoldCacheEntries?: number;
  launchProfile?: LlamaCppLaunchProfile;
}

export interface LlamaCppLaunchProfile {
  preset:
    | "single-vps-sub1b"
    | "single-vps-sub1b-cx23"
    | "single-vps-sub1b-cax11"
    | "single-vps-1b-cx23"
    | "single-vps-1b-8gb"
    | "single-vps-balanced";
  binaryPath: string;
  modelPath: string;
  host: string;
  port: number;
  alias?: string;
  ctxSize: number;
  parallel: number;
  threads: number;
  threadsBatch?: number;
  threadsHttp: number;
  batchSize: number;
  ubatchSize: number;
  cachePrompt: boolean;
  cacheReuse: number;
  cacheRamMiB?: number;
  continuousBatching: boolean;
  enableMetrics: boolean;
  exposeSlots: boolean;
  warmup: boolean;
  enableUnifiedKv: boolean;
  cacheIdleSlots: boolean;
  contextShift: boolean;
  extraArgs?: string[];
}

export interface MockProviderConfig {
  kind: "mock";
  seed?: string;
  latencyMs: number;
}

export type ProviderConfig =
  | OpenAICompatibleProviderConfig
  | LlamaCppProviderConfig
  | MockProviderConfig;

export interface ModelOperationalMetadata {
  recommendedPromptFormat: "native-template" | "openai-chat" | "plain-completion";
  supportsJsonMode: boolean;
  tokensPerSecondTarget: number;
  memoryClassMiB: number;
  preferredCtxSize: number;
  chatTemplateKnown: boolean;
}

export interface ModelConfig {
  id: string;
  family: string;
  quantization: Quantization;
  contextWindow: number;
  warmOnBoot: boolean;
  maxOutputTokens: number;
  operational?: ModelOperationalMetadata;
  adapter: ProviderConfig;
}

export interface SchedulerConfig {
  concurrency: number;
  maxQueue: number;
  maxQueuedTokens: number;
  maxInflightTokens: number;
  requestTimeoutMs: number;
  dedupeInflight: boolean;
  batchWindowMs: number;
  affinityLookahead: number;
  shortJobMaxTokens: number;
}

export interface AsyncQueueConfig {
  enabled: boolean;
  storageDir: string;
  pollIntervalMs: number;
  dispatchConcurrency: number;
  maxAttempts: number;
  callbackTimeoutMs: number;
  maxCallbackAttempts: number;
  callbackAllowPrivateNetwork: boolean;
  callbackAllowedHosts: string[];
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

export interface PromptCompilerConfig {
  enabled: boolean;
  collapseWhitespace: boolean;
  dedupeRepeatedLines: boolean;
  familyMetadataKeys: string[];
}

export interface AdaptiveTuningConfig {
  enabled: boolean;
  sampleSize: number;
  queueLatencyThresholdMs: number;
  minCompletionTokensPerSecond: number;
  maxOutputReductionRatio: number;
  minOutputTokens: number;
  learnedFamilyCapEnabled: boolean;
  familyHistorySize: number;
  learnedCapMinSamples: number;
  draftPercentile: number;
  shortPercentile: number;
  learnedCapHeadroomTokens: number;
}

export interface AuthConfig {
  enabled: boolean;
  apiKeyEnv?: string;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxRequests: number;
  maxKeys: number;
  keyStrategy: RateLimitKeyStrategy;
  trustProxyHeaders: boolean;
}

export interface RayConfig {
  profile: RayProfile;
  server: ServerConfig;
  model: ModelConfig;
  scheduler: SchedulerConfig;
  asyncQueue: AsyncQueueConfig;
  cache: CacheConfig;
  telemetry: TelemetryConfig;
  gracefulDegradation: GracefulDegradationConfig;
  promptCompiler: PromptCompilerConfig;
  adaptiveTuning: AdaptiveTuningConfig;
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
  tags: Record<string, string>;
}

export interface InferenceRequest {
  input?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
  responseFormat?: InferenceResponseFormat;
  cache?: boolean;
  dedupeKey?: string;
  metadata?: Record<string, string>;
  templateId?: string;
  templateVariables?: PromptTemplateVariables;
}

export interface NormalizedInferenceRequest {
  input: string;
  system?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  seed?: number;
  stop?: string[];
  responseFormat?: InferenceResponseFormat;
  cache: boolean;
  dedupeKey?: string;
  metadata: Record<string, string>;
  promptTemplateId?: string;
  templateVariables?: Record<string, string>;
  promptLane?: ScheduleLane;
  promptFamily?: string;
}

export interface CreateInferenceJobRequest extends InferenceRequest {
  callbackUrl?: string;
}

export interface InferenceJobError {
  message: string;
  code?: string;
  details?: unknown;
}

export interface InferenceJobCallbackState {
  url: string;
  status: InferenceJobCallbackStatus;
  attempts: number;
  lastAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface InferenceJobRecord {
  id: string;
  status: InferenceJobStatus;
  request: InferenceRequest;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string;
  result?: InferenceResponse;
  error?: InferenceJobError;
  callback?: InferenceJobCallbackState;
}

export interface InferenceJobAcceptedResponse {
  id: string;
  status: InferenceJobStatus;
  createdAt: string;
  location: string;
}

export interface AsyncQueueSnapshot {
  enabled: boolean;
  queued: number;
  running: number;
  callbackPending: number;
  totalJobs: number;
  dispatchConcurrency: number;
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
  detectedCapabilities?: ProviderDetectedCapabilities;
  details?: Record<string, unknown>;
}

export type ProviderCapabilityStatus = "available" | "unavailable" | "unknown";

export interface ProviderDetectedCapabilities {
  modelRef?: string;
  backendModel?: string;
  launchPreset?: string;
  applyTemplate: ProviderCapabilityStatus;
  chatTemplate: ProviderCapabilityStatus;
  jsonMode: ProviderCapabilityStatus;
  contextWindow?: number;
  totalSlots?: number;
  promptFormatPreference?: "native-template" | "openai-chat" | "plain-completion";
  errors?: Record<string, string>;
}

export interface ProviderTimings {
  ttftMs?: number;
  totalMs?: number;
  promptMs?: number;
  completionMs?: number;
  promptTokensPerSecond?: number;
  completionTokensPerSecond?: number;
}

export interface SchedulerSlotSnapshot {
  id: number;
  taskId?: number;
  isProcessing: boolean;
  contextWindow?: number;
  promptTokens?: number;
  cacheTokens?: number;
  updatedAt: string;
}

export interface ProviderDiagnostics {
  requestShape?: "openai-chat" | "llama.cpp-completion";
  promptFormat?: "llama.cpp-template" | "prompt-scaffold" | "ray-chat-fallback";
  promptFormatReason?: string;
  jsonRepairAttempted?: boolean;
  jsonRepairSucceeded?: boolean;
  modelRef?: string;
  backendModel?: string;
  launchPreset?: string;
  totalSlots?: number;
  slotId?: number;
  preferredSlot?: number;
  tokensCached?: number;
  tokensEvaluated?: number;
  truncated?: boolean;
  contextWindow?: number;
  slotRouteReason?: string;
  timings?: ProviderTimings;
}

export interface ProviderRequestPreparation {
  request: NormalizedInferenceRequest;
  promptTokens?: number;
  affinityKey?: string;
  lane?: ScheduleLane;
  preferredSlot?: number;
  slotSnapshots?: SchedulerSlotSnapshot[];
  providerState?: unknown;
  diagnostics?: ProviderDiagnostics;
}

export interface ProviderResult {
  output: string;
  usage?: PartialUsageStats;
  diagnostics?: ProviderDiagnostics;
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
  affinityKey?: string;
  lane?: ScheduleLane;
  preparation?: ProviderRequestPreparation;
}

export interface ModelProvider {
  readonly modelId: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  warm?(): Promise<void>;
  health?(): Promise<ProviderHealthSnapshot>;
  prepare?(
    request: NormalizedInferenceRequest,
    context: ProviderContext,
  ): Promise<ProviderRequestPreparation>;
  infer(request: NormalizedInferenceRequest, context: ProviderContext): Promise<ProviderResult>;
}

export interface PromptCompilerDiagnostics {
  familyKey: string;
  lane: ScheduleLane;
  templateId?: string;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
}

export interface AdaptiveTuningDiagnostics {
  reduced: boolean;
  requestedMaxTokens: number;
  appliedMaxTokens: number;
  reductionRatio: number;
  reason?: string;
}

export interface LearnedOutputCapDiagnostics {
  applied: boolean;
  familyKey: string;
  lane: ScheduleLane;
  requestedMaxTokens: number;
  appliedMaxTokens: number;
  learnedCapTokens?: number;
  sampleCount: number;
  percentile: number;
}

export interface TaskRoutingDiagnostics {
  taskKind: "classification" | "rewrite" | "draft" | "unknown";
  recommendedModelRole: "classifier" | "drafter" | "general";
  activeModelRole?: string;
  matchedActiveRole: boolean;
}

export interface InferenceDiagnostics {
  promptCompiler?: PromptCompilerDiagnostics;
  learnedOutputCap?: LearnedOutputCapDiagnostics;
  adaptiveTuning?: AdaptiveTuningDiagnostics;
  taskRouting?: TaskRoutingDiagnostics;
  provider?: ProviderDiagnostics;
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
  diagnostics?: InferenceDiagnostics;
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
  asyncQueue?: AsyncQueueSnapshot;
}

export interface SchedulerSnapshot {
  queueDepth: number;
  shortQueueDepth: number;
  draftQueueDepth: number;
  inFlight: number;
  maxQueue: number;
  concurrency: number;
  queuedTokens: number;
  inFlightTokens: number;
  maxQueuedTokens: number;
  maxInflightTokens: number;
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
    lastPromptCacheReuseRatio: number | null;
    lastPromptCacheTokens: number | null;
    lastSlotId: number | null;
    lastSlotOccupancyRatio: number | null;
    lastProcessRssMiB: number | null;
    lastHeapUsedMiB: number | null;
    lastCpuPercent: number | null;
    lastEventLoopLagP95Ms: number | null;
  };
}
