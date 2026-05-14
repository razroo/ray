import type { LlamaCppLaunchProfile, RayConfig, SchedulerConfig } from "@razroo/ray-core";

export type LlamaTunerModelClass = "sub1b" | "1b" | "custom";
export type LlamaTunerGoal = "latency" | "throughput" | "balanced";
export type LlamaTunerRisk = "low" | "medium";

export interface LlamaTunerHost {
  cpuCount: number;
  memoryMiB: number;
  architecture?: "x64" | "arm64" | "unknown";
  machineClass?: string;
}

export interface LlamaTunerTarget {
  modelClass?: LlamaTunerModelClass;
  goal?: LlamaTunerGoal;
  maxCandidates?: number;
}

export interface LlamaTunerInput {
  config: RayConfig;
  host: LlamaTunerHost;
  target?: LlamaTunerTarget;
}

export interface LlamaTunerCandidate {
  id: string;
  launchProfile: LlamaCppLaunchProfile;
  scheduler: Pick<
    SchedulerConfig,
    "concurrency" | "maxInflightTokens" | "batchWindowMs" | "shortJobMaxTokens"
  >;
  risk: LlamaTunerRisk;
  rationale: string[];
}

export interface LlamaTunerObservation {
  candidateId: string;
  completionTokensPerSecondAvg: number;
  latencyP95Ms?: number;
  ttftP95Ms?: number;
  queueDelayP95Ms?: number;
  failureRate?: number;
  qualityPassRate?: number;
  memoryPressureRatio?: number;
  cpuThrottledRatio?: number;
}

export interface LlamaTunerRecommendationOptions {
  goal?: LlamaTunerGoal;
  minQualityPassRate?: number;
  maxFailureRate?: number;
  maxMemoryPressureRatio?: number;
  maxCpuThrottledRatio?: number;
}

export interface LlamaTunerRecommendation {
  candidate: LlamaTunerCandidate;
  observation: LlamaTunerObservation;
  score: number;
  rationale: string[];
}

const MAX_CPU_COUNT = 256;
const MAX_MEMORY_MIB = 1_048_576;
const MAX_TUNER_CANDIDATES = 96;
const DEFAULT_TUNER_CANDIDATES = 48;
const MAX_CONTEXT_SIZE = 16_384;
const MAX_BATCH_SIZE = 2_048;
const MAX_PARALLEL = 8;
const MAX_CACHE_REUSE = 2_048;
const MAX_CACHE_RAM_MIB = 8_192;
const DEFAULT_FAILURE_RATE = 0;
const DEFAULT_QUALITY_PASS_RATE = 100;
const DEFAULT_PRESSURE_RATIO = 0;
const DEFAULT_LATENCY_MS = 0;

const tunerTargetKeys = new Set(["modelClass", "goal", "maxCandidates"]);
const tunerHostKeys = new Set(["cpuCount", "memoryMiB", "architecture", "machineClass"]);
const tunerInputKeys = new Set(["config", "host", "target"]);
const recommendationOptionKeys = new Set([
  "goal",
  "minQualityPassRate",
  "maxFailureRate",
  "maxMemoryPressureRatio",
  "maxCpuThrottledRatio",
]);
const observationKeys = new Set([
  "candidateId",
  "completionTokensPerSecondAvg",
  "latencyP95Ms",
  "ttftP95Ms",
  "queueDelayP95Ms",
  "failureRate",
  "qualityPassRate",
  "memoryPressureRatio",
  "cpuThrottledRatio",
]);
const unsafeRecordKeys = new Set(["__proto__", "constructor", "prototype"]);

function objectEntries(value: object, label: string): Array<[string, unknown]> {
  try {
    return Object.entries(value);
  } catch {
    throw new TypeError(`${label} must not contain unreadable properties`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertKnownObjectKeys(value: object, label: string, allowedKeys: ReadonlySet<string>) {
  for (const [key] of objectEntries(value, label)) {
    if (unsafeRecordKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsafe key "${key}"`);
    }

    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} must not contain unsupported key "${key}"`);
    }
  }
}

function assertPositiveSafeIntegerAtMost(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }

  if (value > maximum) {
    throw new RangeError(`${label} must be less than or equal to ${maximum}`);
  }

  return value;
}

function assertOptionalRatio(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite ratio between 0 and 1`);
  }

  return value;
}

function assertOptionalPercent(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${label} must be a finite percentage between 0 and 100`);
  }

  return value;
}

function assertOptionalNonNegativeFinite(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }

  return value;
}

function assertGoal(value: unknown, label: string): LlamaTunerGoal {
  if (value === undefined) {
    return "balanced";
  }

  if (value !== "latency" && value !== "throughput" && value !== "balanced") {
    throw new TypeError(`${label} must be latency, throughput, or balanced`);
  }

  return value;
}

function normalizeTarget(value: unknown): Required<LlamaTunerTarget> {
  if (value === undefined) {
    return {
      modelClass: "sub1b",
      goal: "balanced",
      maxCandidates: DEFAULT_TUNER_CANDIDATES,
    };
  }

  assertRecord(value, "tuner target");
  assertKnownObjectKeys(value, "tuner target", tunerTargetKeys);

  const modelClass = value.modelClass ?? "sub1b";
  if (modelClass !== "sub1b" && modelClass !== "1b" && modelClass !== "custom") {
    throw new TypeError("tuner target modelClass must be sub1b, 1b, or custom");
  }

  return {
    modelClass,
    goal: assertGoal(value.goal, "tuner target goal"),
    maxCandidates:
      value.maxCandidates === undefined
        ? DEFAULT_TUNER_CANDIDATES
        : assertPositiveSafeIntegerAtMost(
            value.maxCandidates,
            "tuner target maxCandidates",
            MAX_TUNER_CANDIDATES,
          ),
  };
}

function normalizeHost(value: unknown): LlamaTunerHost {
  assertRecord(value, "tuner host");
  assertKnownObjectKeys(value, "tuner host", tunerHostKeys);

  const architecture = value.architecture ?? "unknown";
  if (architecture !== "x64" && architecture !== "arm64" && architecture !== "unknown") {
    throw new TypeError("tuner host architecture must be x64, arm64, or unknown");
  }

  if (value.machineClass !== undefined && typeof value.machineClass !== "string") {
    throw new TypeError("tuner host machineClass must be a string");
  }

  return {
    cpuCount: assertPositiveSafeIntegerAtMost(value.cpuCount, "tuner host cpuCount", MAX_CPU_COUNT),
    memoryMiB: assertPositiveSafeIntegerAtMost(
      value.memoryMiB,
      "tuner host memoryMiB",
      MAX_MEMORY_MIB,
    ),
    architecture,
    ...(value.machineClass ? { machineClass: value.machineClass } : {}),
  };
}

function normalizeInput(input: LlamaTunerInput): {
  config: RayConfig;
  host: LlamaTunerHost;
  target: Required<LlamaTunerTarget>;
  baseProfile: LlamaCppLaunchProfile;
} {
  assertRecord(input, "tuner input");
  assertKnownObjectKeys(input, "tuner input", tunerInputKeys);

  const config = input.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("tuner input config must be a Ray config object");
  }

  const adapter = config.model?.adapter;
  if (adapter?.kind !== "llama.cpp" || adapter.launchProfile === undefined) {
    throw new TypeError("tuner input config must use a llama.cpp adapter with a launchProfile");
  }

  return {
    config,
    host: normalizeHost(input.host),
    target: normalizeTarget(input.target),
    baseProfile: adapter.launchProfile,
  };
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function candidateThreadValues(
  baseThreads: number,
  cpuCount: number,
  goal: LlamaTunerGoal,
): number[] {
  const cpuCeiling = Math.max(1, cpuCount - 1);
  const values = uniqueNumbers([
    1,
    baseThreads,
    cpuCeiling,
    Math.ceil(cpuCount / 2),
    goal === "latency" ? Math.max(1, cpuCount - 1) : cpuCount,
  ]);

  return values.map((value) => clamp(value, 1, cpuCount));
}

function candidateParallelValues(
  baseParallel: number,
  cpuCount: number,
  modelClass: LlamaTunerModelClass,
) {
  const ceiling =
    modelClass === "1b" ? 2 : Math.min(MAX_PARALLEL, Math.max(1, Math.floor(cpuCount / 1)));
  return uniqueNumbers([1, baseParallel, Math.min(2, ceiling)]).map((value) =>
    clamp(value, 1, ceiling),
  );
}

function candidateContextValues(
  baseCtx: number,
  memoryMiB: number,
  modelClass: LlamaTunerModelClass,
) {
  const memoryCeiling = memoryMiB >= 8_192 ? 4_096 : modelClass === "1b" ? 3_072 : 4_096;
  return uniqueNumbers([2_048, baseCtx, 3_072, memoryCeiling]).map((value) =>
    clamp(value, 1_024, Math.min(MAX_CONTEXT_SIZE, memoryCeiling)),
  );
}

function candidateBatchValues(baseBatch: number, goal: LlamaTunerGoal) {
  const values = goal === "latency" ? [128, baseBatch, 256] : [128, baseBatch, 256, 384, 512];
  return uniqueNumbers(values).map((value) => clamp(value, 64, MAX_BATCH_SIZE));
}

function candidateCacheReuseValues(baseCacheReuse: number, goal: LlamaTunerGoal) {
  const values = goal === "latency" ? [128, baseCacheReuse, 256] : [128, baseCacheReuse, 256, 512];
  return uniqueNumbers(values).map((value) => clamp(value, 0, MAX_CACHE_REUSE));
}

function estimateCandidateRisk(
  profile: LlamaCppLaunchProfile,
  host: LlamaTunerHost,
  target: Required<LlamaTunerTarget>,
): LlamaTunerRisk {
  if (profile.parallel > 1 && host.cpuCount <= 2 && target.goal === "latency") {
    return "medium";
  }

  if (profile.batchSize >= 512 || profile.ctxSize >= 4_096) {
    return "medium";
  }

  return "low";
}

function buildRationale(
  profile: LlamaCppLaunchProfile,
  host: LlamaTunerHost,
  target: Required<LlamaTunerTarget>,
): string[] {
  const rationale = [
    `parallel=${profile.parallel} slots on ${host.cpuCount} vCPU`,
    `ctx=${profile.ctxSize} keeps sub-1B prompt room bounded on ${host.memoryMiB} MiB`,
    `batch=${profile.batchSize}/${profile.ubatchSize} probes prompt-eval throughput`,
  ];

  if (target.goal === "latency") {
    rationale.push("latency goal favors lower queueing and fewer aggressive batch candidates");
  } else if (target.goal === "throughput") {
    rationale.push("throughput goal keeps wider batch and prompt-cache reuse candidates");
  }

  if (profile.cachePrompt) {
    rationale.push(`prompt cache reuse=${profile.cacheReuse} targets repeated Email AI scaffolds`);
  }

  return rationale;
}

function candidateSortScore(candidate: LlamaTunerCandidate, goal: LlamaTunerGoal): number {
  const profile = candidate.launchProfile;
  const throughputHint =
    profile.parallel * 300 + profile.batchSize + profile.cacheReuse / 2 - profile.ctxSize / 64;
  const latencyHint = 1_000 - profile.parallel * 120 - profile.batchSize / 2 - profile.ctxSize / 96;

  if (goal === "latency") {
    return latencyHint;
  }
  if (goal === "throughput") {
    return throughputHint;
  }
  return throughputHint * 0.65 + latencyHint * 0.35;
}

function createCandidateId(profile: LlamaCppLaunchProfile): string {
  return [
    `p${profile.parallel}`,
    `t${profile.threads}`,
    `ctx${profile.ctxSize}`,
    `b${profile.batchSize}`,
    `u${profile.ubatchSize}`,
    `r${profile.cacheReuse}`,
  ].join("-");
}

export function createLlamaTunerCandidates(input: LlamaTunerInput): LlamaTunerCandidate[] {
  const { host, target, baseProfile } = normalizeInput(input);
  const candidates = new Map<string, LlamaTunerCandidate>();

  for (const parallel of candidateParallelValues(
    baseProfile.parallel,
    host.cpuCount,
    target.modelClass,
  )) {
    for (const threads of candidateThreadValues(baseProfile.threads, host.cpuCount, target.goal)) {
      for (const ctxSize of candidateContextValues(
        baseProfile.ctxSize,
        host.memoryMiB,
        target.modelClass,
      )) {
        for (const batchSize of candidateBatchValues(baseProfile.batchSize, target.goal)) {
          for (const cacheReuse of candidateCacheReuseValues(baseProfile.cacheReuse, target.goal)) {
            const launchProfile: LlamaCppLaunchProfile = {
              ...baseProfile,
              ctxSize,
              parallel,
              threads,
              threadsHttp: clamp(baseProfile.threadsHttp, 1, Math.max(1, host.cpuCount)),
              batchSize,
              ubatchSize: Math.min(baseProfile.ubatchSize, Math.max(64, Math.floor(batchSize / 2))),
              cachePrompt: true,
              cacheReuse,
              cacheRamMiB: clamp(baseProfile.cacheRamMiB ?? 512, 128, MAX_CACHE_RAM_MIB),
              continuousBatching: true,
              enableMetrics: true,
              exposeSlots: true,
              warmup: true,
            };
            const id = createCandidateId(launchProfile);
            candidates.set(id, {
              id,
              launchProfile,
              scheduler: {
                concurrency: parallel,
                maxInflightTokens: Math.min(ctxSize * parallel, 8_192),
                batchWindowMs: target.goal === "latency" ? 5 : baseProfile.parallel > 1 ? 10 : 15,
                shortJobMaxTokens: target.modelClass === "sub1b" ? 96 : 128,
              },
              risk: estimateCandidateRisk(launchProfile, host, target),
              rationale: buildRationale(launchProfile, host, target),
            });
          }
        }
      }
    }
  }

  return Array.from(candidates.values())
    .sort(
      (left, right) =>
        candidateSortScore(right, target.goal) - candidateSortScore(left, target.goal),
    )
    .slice(0, target.maxCandidates);
}

function normalizeObservation(value: unknown): LlamaTunerObservation {
  assertRecord(value, "tuner observation");
  assertKnownObjectKeys(value, "tuner observation", observationKeys);

  if (typeof value.candidateId !== "string" || value.candidateId.length === 0) {
    throw new TypeError("tuner observation candidateId must be a non-empty string");
  }

  const observation: LlamaTunerObservation = {
    candidateId: value.candidateId,
    completionTokensPerSecondAvg:
      assertOptionalNonNegativeFinite(
        value.completionTokensPerSecondAvg,
        "tuner observation completionTokensPerSecondAvg",
      ) ?? 0,
  };

  const latencyP95Ms = assertOptionalNonNegativeFinite(
    value.latencyP95Ms,
    "tuner observation latencyP95Ms",
  );
  if (latencyP95Ms !== undefined) {
    observation.latencyP95Ms = latencyP95Ms;
  }

  const ttftP95Ms = assertOptionalNonNegativeFinite(value.ttftP95Ms, "tuner observation ttftP95Ms");
  if (ttftP95Ms !== undefined) {
    observation.ttftP95Ms = ttftP95Ms;
  }

  const queueDelayP95Ms = assertOptionalNonNegativeFinite(
    value.queueDelayP95Ms,
    "tuner observation queueDelayP95Ms",
  );
  if (queueDelayP95Ms !== undefined) {
    observation.queueDelayP95Ms = queueDelayP95Ms;
  }

  const failureRate = assertOptionalRatio(value.failureRate, "tuner observation failureRate");
  if (failureRate !== undefined) {
    observation.failureRate = failureRate;
  }

  const qualityPassRate = assertOptionalPercent(
    value.qualityPassRate,
    "tuner observation qualityPassRate",
  );
  if (qualityPassRate !== undefined) {
    observation.qualityPassRate = qualityPassRate;
  }

  const memoryPressureRatio = assertOptionalRatio(
    value.memoryPressureRatio,
    "tuner observation memoryPressureRatio",
  );
  if (memoryPressureRatio !== undefined) {
    observation.memoryPressureRatio = memoryPressureRatio;
  }

  const cpuThrottledRatio = assertOptionalRatio(
    value.cpuThrottledRatio,
    "tuner observation cpuThrottledRatio",
  );
  if (cpuThrottledRatio !== undefined) {
    observation.cpuThrottledRatio = cpuThrottledRatio;
  }

  return observation;
}

function normalizeRecommendationOptions(
  value: LlamaTunerRecommendationOptions = {},
): Required<LlamaTunerRecommendationOptions> {
  assertRecord(value, "tuner recommendation options");
  assertKnownObjectKeys(value, "tuner recommendation options", recommendationOptionKeys);

  return {
    goal: assertGoal(value.goal, "tuner recommendation goal"),
    minQualityPassRate:
      assertOptionalPercent(value.minQualityPassRate, "tuner recommendation minQualityPassRate") ??
      80,
    maxFailureRate:
      assertOptionalRatio(value.maxFailureRate, "tuner recommendation maxFailureRate") ?? 0.02,
    maxMemoryPressureRatio:
      assertOptionalRatio(
        value.maxMemoryPressureRatio,
        "tuner recommendation maxMemoryPressureRatio",
      ) ?? 0.9,
    maxCpuThrottledRatio:
      assertOptionalRatio(
        value.maxCpuThrottledRatio,
        "tuner recommendation maxCpuThrottledRatio",
      ) ?? 0.35,
  };
}

function isStableObservation(
  observation: LlamaTunerObservation,
  options: Required<LlamaTunerRecommendationOptions>,
): boolean {
  return (
    (observation.failureRate ?? DEFAULT_FAILURE_RATE) <= options.maxFailureRate &&
    (observation.qualityPassRate ?? DEFAULT_QUALITY_PASS_RATE) >= options.minQualityPassRate &&
    (observation.memoryPressureRatio ?? DEFAULT_PRESSURE_RATIO) <= options.maxMemoryPressureRatio &&
    (observation.cpuThrottledRatio ?? DEFAULT_PRESSURE_RATIO) <= options.maxCpuThrottledRatio
  );
}

function scoreObservation(
  observation: LlamaTunerObservation,
  options: Required<LlamaTunerRecommendationOptions>,
): number {
  const tps = observation.completionTokensPerSecondAvg;
  const latencyPenalty = (observation.latencyP95Ms ?? DEFAULT_LATENCY_MS) / 1_000;
  const ttftPenalty = (observation.ttftP95Ms ?? DEFAULT_LATENCY_MS) / 1_500;
  const queuePenalty = (observation.queueDelayP95Ms ?? DEFAULT_LATENCY_MS) / 500;
  const memoryPenalty = (observation.memoryPressureRatio ?? DEFAULT_PRESSURE_RATIO) * 8;
  const cpuPenalty = (observation.cpuThrottledRatio ?? DEFAULT_PRESSURE_RATIO) * 6;
  const qualityBonus = ((observation.qualityPassRate ?? DEFAULT_QUALITY_PASS_RATE) - 80) / 10;

  if (options.goal === "latency") {
    return tps * 0.7 + qualityBonus - latencyPenalty * 2 - ttftPenalty * 2 - queuePenalty;
  }

  if (options.goal === "throughput") {
    return (
      tps * 1.25 + qualityBonus - latencyPenalty * 0.4 - queuePenalty - memoryPenalty - cpuPenalty
    );
  }

  return (
    tps + qualityBonus - latencyPenalty - ttftPenalty - queuePenalty - memoryPenalty - cpuPenalty
  );
}

export function recommendLlamaTunerCandidate(
  candidates: readonly LlamaTunerCandidate[],
  observations: readonly LlamaTunerObservation[],
  options: LlamaTunerRecommendationOptions = {},
): LlamaTunerRecommendation {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("tuner candidates must be a non-empty array");
  }
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new TypeError("tuner observations must be a non-empty array");
  }

  const normalizedOptions = normalizeRecommendationOptions(options);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const scored: LlamaTunerRecommendation[] = [];

  for (const rawObservation of observations) {
    const observation = normalizeObservation(rawObservation);
    const candidate = candidateById.get(observation.candidateId);
    if (candidate === undefined || !isStableObservation(observation, normalizedOptions)) {
      continue;
    }

    const score = scoreObservation(observation, normalizedOptions);
    scored.push({
      candidate,
      observation,
      score,
      rationale: [
        `selected ${candidate.id} at ${observation.completionTokensPerSecondAvg.toFixed(2)} completion tok/s`,
        `p95 latency ${Math.round(observation.latencyP95Ms ?? 0)}ms, queue ${Math.round(
          observation.queueDelayP95Ms ?? 0,
        )}ms`,
        ...candidate.rationale,
      ],
    });
  }

  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (best === undefined) {
    throw new Error("no stable llama tuner observations matched the candidate set");
  }

  return best;
}

export function createTunedRayConfig(config: RayConfig, candidate: LlamaTunerCandidate): RayConfig {
  if (config.model.adapter.kind !== "llama.cpp") {
    throw new TypeError("tuned Ray config requires a llama.cpp adapter");
  }

  return {
    ...config,
    model: {
      ...config.model,
      adapter: {
        ...config.model.adapter,
        launchProfile: { ...candidate.launchProfile },
        cachePrompt: candidate.launchProfile.cachePrompt,
        promptScaffoldCacheEntries: Math.max(
          config.model.adapter.promptScaffoldCacheEntries ?? 0,
          candidate.launchProfile.cacheReuse,
        ),
      },
    },
    scheduler: {
      ...config.scheduler,
      ...candidate.scheduler,
    },
  };
}
