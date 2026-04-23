import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRayConfig, mergeConfig, type DeepPartial } from "@ray/config";
import type { LlamaCppLaunchProfile, RayConfig } from "@razroo/ray-core";
import { buildLlamaCppEnvironment } from "../packages/deploy/src/index.ts";

type AutotuneScope = "auto" | "gateway" | "full";
type BenchmarkCheckOperator = "<=" | ">=" | "===";

const STRUCTURED_OUTPUT_VERSION = 1;
const BENCHMARK_API_KEY_ENV = "RAY_BENCHMARK_API_KEY";

interface BenchmarkArgs {
  baseUrl: string;
  workloadPath?: string;
  concurrency: number;
  requests?: number;
  label?: string;
  configPath?: string;
  apiKey?: string;
  outputPath?: string;
  baselinePath?: string;
  autotune: boolean;
  autotuneScope: AutotuneScope;
  assertBaseline: boolean;
  help: boolean;
}

interface InferenceRequest {
  input?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: {
    type: "text" | "json_object";
  };
  metadata?: Record<string, string>;
  templateId?: string;
  templateVariables?: Record<string, string | number | boolean>;
}

interface InferenceResponse {
  id: string;
  output: string;
  cached: boolean;
  deduplicated: boolean;
  queueTimeMs: number;
  latencyMs: number;
  degraded: boolean;
  usage: {
    tokens?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
  diagnostics?: {
    provider?: {
      tokensCached?: number;
      slotId?: number;
      timings?: {
        ttftMs?: number;
        completionTokensPerSecond?: number;
      };
    };
  };
}

interface BenchmarkSample {
  response: InferenceResponse;
  wallTimeMs: number;
}

interface BenchmarkSummary {
  label: string;
  baseUrl: string;
  concurrency: number;
  requests: number;
  responseCacheHitRate?: number;
  promptCacheHitRate?: number;
  promptCacheReuseRatio?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  queueDelayP50Ms?: number;
  queueDelayP95Ms?: number;
  ttftP50Ms?: number;
  ttftP95Ms?: number;
  completionTokensPerSecondAvg?: number;
  emailsPerHour?: number;
  wallTimeMs: number;
  clientLatencyP50Ms?: number;
  score?: number;
}

interface AutotuneCandidate {
  label: string;
  override: DeepPartial<RayConfig>;
}

interface LaunchProfileCandidate {
  label: string;
  profile: LlamaCppLaunchProfile;
  perSlotContext: number;
}

interface LaunchProfileBenchmarkResult {
  candidate: LaunchProfileCandidate;
  summary: BenchmarkSummary;
}

interface SchedulerBenchmarkResult {
  candidate: AutotuneCandidate;
  summary: BenchmarkSummary;
}

interface BenchmarkBaselineAssertions {
  maxLatencyP95Ms?: number;
  maxQueueDelayP95Ms?: number;
  maxTtftP95Ms?: number;
  minCompletionTokensPerSecondAvg?: number;
  minPromptCacheHitRate?: number;
  minPromptCacheReuseRatio?: number;
  minEmailsPerHour?: number;
}

interface BenchmarkBaseline {
  version: number;
  label: string;
  machineClass: string;
  workloadPath?: string;
  concurrency: number;
  requests: number;
  assertions: BenchmarkBaselineAssertions;
  notes?: string[];
}

interface BenchmarkComparisonCheck {
  metric: string;
  operator: BenchmarkCheckOperator;
  expected: number | string;
  actual: number | string;
  passed: boolean;
}

interface BenchmarkComparison {
  baselinePath: string;
  baselineLabel: string;
  machineClass: string;
  passed: boolean;
  checks: BenchmarkComparisonCheck[];
}

interface BenchmarkSummaryOutput {
  kind: "benchmark-summary";
  version: number;
  generatedAt: string;
  args: {
    baseUrl: string;
    workloadPath?: string;
    concurrency: number;
    requests: number;
    label: string;
    configPath?: string;
    baselinePath?: string;
  };
  summary: BenchmarkSummary;
  comparison?: BenchmarkComparison;
}

interface AutotuneOutput {
  kind: "autotune-report";
  version: number;
  generatedAt: string;
  args: {
    configPath: string;
    scope: "gateway" | "full";
    workloadPath?: string;
    concurrency: number;
    requests: number;
  };
  launchResults?: Array<{
    label: string;
    profile: LlamaCppLaunchProfile;
    summary: BenchmarkSummary;
  }>;
  schedulerResults: Array<{
    label: string;
    schedulerOverride: DeepPartial<RayConfig>["scheduler"];
    summary: BenchmarkSummary;
  }>;
  recommendedPatch: DeepPartial<RayConfig>;
}

const defaultWorkload: InferenceRequest[] = [
  {
    templateId: "email.cold_outreach.v1",
    templateVariables: {
      recipientRole: "VP Engineering",
      topic: "faster CI runs",
      valueProp: "cut flaky builds and idle time",
      companyContext: "40-person SaaS engineering team",
    },
  },
  {
    templateId: "email.cold_outreach.v1",
    templateVariables: {
      recipientRole: "Head of Sales Operations",
      topic: "less CRM admin work",
      valueProp: "reduce manual enrichment and cleanup",
      companyContext: "mid-market revenue team with high outbound volume",
    },
  },
  {
    templateId: "email.reply_classification.v1",
    templateVariables: {
      replyText: "This is interesting, but we already have a vendor. Check back next quarter.",
    },
  },
  {
    templateId: "email.reply_rewrite.v1",
    templateVariables: {
      rewriteGoal: "Sound more confident while staying polite.",
      replyText: "Happy to take a look sometime next week if you want to send a few options.",
    },
  },
];

function parseArgs(argv: string[]): BenchmarkArgs {
  const result: BenchmarkArgs = {
    baseUrl: "http://127.0.0.1:3000",
    concurrency: 1,
    autotune: false,
    autotuneScope: "auto",
    assertBaseline: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--") {
      continue;
    }

    if (current === "--help" || current === "-h") {
      result.help = true;
      continue;
    }

    if (current === "--autotune") {
      result.autotune = true;
      continue;
    }

    if (current === "--assert-baseline") {
      result.assertBaseline = true;
      continue;
    }

    if (!next) {
      continue;
    }

    if (current === "--base-url") {
      result.baseUrl = next;
      index += 1;
      continue;
    }

    if (current === "--workload") {
      result.workloadPath = next;
      index += 1;
      continue;
    }

    if (current === "--concurrency") {
      result.concurrency = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
      continue;
    }

    if (current === "--requests") {
      result.requests = Math.max(1, Number.parseInt(next, 10) || 1);
      index += 1;
      continue;
    }

    if (current === "--label") {
      result.label = next;
      index += 1;
      continue;
    }

    if (current === "--api-key") {
      result.apiKey = next;
      index += 1;
      continue;
    }

    if (current === "--config") {
      result.configPath = next;
      index += 1;
      continue;
    }

    if (current === "--output") {
      result.outputPath = next;
      index += 1;
      continue;
    }

    if (current === "--baseline") {
      result.baselinePath = next;
      index += 1;
      continue;
    }

    if (
      current === "--autotune-scope" &&
      (next === "auto" || next === "gateway" || next === "full")
    ) {
      result.autotuneScope = next;
      index += 1;
    }
  }

  return result;
}

function printUsage(): void {
  console.log("Usage: pnpm benchmark -- [options]");
  console.log("");
  console.log("Options:");
  console.log("  --base-url <url>        Gateway base URL. Default: http://127.0.0.1:3000");
  console.log("  --workload <path>       JSON or JSONL workload file.");
  console.log("  --concurrency <n>       Client-side concurrency. Default: 1");
  console.log("  --requests <n>          Total requests to replay.");
  console.log("  --label <name>          Label shown in benchmark output.");
  console.log("  --config <path>         Ray config path for autotune mode.");
  console.log("  --api-key <key>         Bearer API key used for auth-enabled gateways.");
  console.log(
    `  --output <path>         Write structured benchmark or autotune output JSON (${STRUCTURED_OUTPUT_VERSION}).`,
  );
  console.log("  --baseline <path>       Compare the benchmark summary against a baseline JSON.");
  console.log("  --assert-baseline       Exit non-zero if the baseline checks fail.");
  console.log("  --autotune              Sweep scheduler settings using the supplied config.");
  console.log("  --autotune-scope <mode> Autotune scope: auto, gateway, or full. Default: auto.");
  console.log("  --help, -h              Show this help text.");
  console.log("");
  console.log(`Auth fallback env: ${BENCHMARK_API_KEY_ENV}`);
}

async function loadWorkload(workloadPath?: string): Promise<InferenceRequest[]> {
  if (!workloadPath) {
    return defaultWorkload;
  }

  const resolvedPath = path.resolve(process.cwd(), workloadPath);
  const raw = await readFile(resolvedPath, "utf8");
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new Error(`Workload file is empty: ${resolvedPath}`);
  }

  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as InferenceRequest[];
  }

  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as InferenceRequest);
}

async function loadBaseline(baselinePath: string): Promise<BenchmarkBaseline> {
  const resolvedPath = path.resolve(process.cwd(), baselinePath);
  const baseline = JSON.parse(await readFile(resolvedPath, "utf8")) as BenchmarkBaseline;

  if (baseline.version !== 1) {
    throw new Error(
      `Unsupported benchmark baseline version in ${resolvedPath}: ${baseline.version}`,
    );
  }

  return baseline;
}

function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[position];
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value: number | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function uniqueIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.max(1, Math.round(value))))];
}

function scoreSummary(summary: BenchmarkSummary): number {
  const emailsPerHour = summary.emailsPerHour ?? 0;
  const latencyPenalty = (summary.latencyP95Ms ?? summary.latencyP50Ms ?? 0) / 1_000;
  const queuePenalty = (summary.queueDelayP95Ms ?? summary.queueDelayP50Ms ?? 0) / 1_000;
  const throughputBonus = (summary.completionTokensPerSecondAvg ?? 0) / 100;
  return emailsPerHour / Math.max(1, 1 + latencyPenalty + queuePenalty) + throughputBonus;
}

function resolveBenchmarkApiKey(args: BenchmarkArgs, config?: RayConfig): string | undefined {
  if (args.apiKey) {
    return args.apiKey;
  }

  const directEnvKey = process.env[BENCHMARK_API_KEY_ENV];
  if (directEnvKey) {
    return directEnvKey;
  }

  if (!config?.auth.enabled || !config.auth.apiKeyEnv) {
    return undefined;
  }

  const raw = process.env[config.auth.apiKeyEnv];
  if (!raw) {
    return undefined;
  }

  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
}

function resolveAutotuneScope(args: BenchmarkArgs, config: RayConfig): "gateway" | "full" {
  if (args.autotuneScope === "gateway" || args.autotuneScope === "full") {
    return args.autotuneScope;
  }

  return config.model.adapter.kind === "llama.cpp" && config.model.adapter.launchProfile
    ? "full"
    : "gateway";
}

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function getPortOffset(basePort: number, index: number): number {
  return basePort + index + 1;
}

function isCax11Preset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-sub1b-cax11";
}

async function invoke(
  baseUrl: string,
  request: InferenceRequest,
  apiKey?: string,
): Promise<BenchmarkSample> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Benchmark request failed with ${response.status}: ${body}`);
  }

  return {
    response: (await response.json()) as InferenceResponse,
    wallTimeMs: Date.now() - startedAt,
  };
}

async function runBenchmark(options: {
  baseUrl: string;
  workload: InferenceRequest[];
  concurrency: number;
  requests: number;
  label: string;
  apiKey?: string;
}): Promise<BenchmarkSummary> {
  const queue = Array.from(
    { length: options.requests },
    (_, index) => options.workload[index % options.workload.length],
  );
  const results: BenchmarkSample[] = [];
  const startedAt = Date.now();
  let cursor = 0;

  const workers = Array.from({ length: options.concurrency }, async () => {
    while (cursor < queue.length) {
      const nextIndex = cursor;
      cursor += 1;
      const request = queue[nextIndex];
      if (!request) {
        break;
      }

      const sample = await invoke(options.baseUrl, request, options.apiKey);
      results.push(sample);
    }
  });

  await Promise.all(workers);

  const wallTimeMs = Date.now() - startedAt;
  const responses = results.map((sample) => sample.response);
  const latencyValues = responses.map((response) => response.latencyMs);
  const queueValues = responses.map((response) => response.queueTimeMs);
  const ttftValues = responses
    .map((response) => response.diagnostics?.provider?.timings?.ttftMs)
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const throughputValues = responses
    .map((response) => response.diagnostics?.provider?.timings?.completionTokensPerSecond)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const promptCacheRatios = responses
    .map((response) => {
      const promptTokens = response.usage.tokens?.prompt;
      const cachedTokens = response.diagnostics?.provider?.tokensCached;
      if (
        typeof promptTokens !== "number" ||
        promptTokens <= 0 ||
        typeof cachedTokens !== "number" ||
        cachedTokens <= 0
      ) {
        return undefined;
      }
      return cachedTokens / promptTokens;
    })
    .filter((value): value is number => typeof value === "number" && value > 0);
  const responseCacheHits = responses.filter((response) => response.cached).length;
  const promptCacheHits = responses.filter(
    (response) => (response.diagnostics?.provider?.tokensCached ?? 0) > 0,
  ).length;

  const summary: BenchmarkSummary = {
    label: options.label,
    baseUrl: options.baseUrl,
    concurrency: options.concurrency,
    requests: responses.length,
    responseCacheHitRate:
      responses.length > 0 ? (responseCacheHits / responses.length) * 100 : undefined,
    promptCacheHitRate:
      responses.length > 0 ? (promptCacheHits / responses.length) * 100 : undefined,
    promptCacheReuseRatio: mean(promptCacheRatios),
    latencyP50Ms: quantile(latencyValues, 0.5),
    latencyP95Ms: quantile(latencyValues, 0.95),
    queueDelayP50Ms: quantile(queueValues, 0.5),
    queueDelayP95Ms: quantile(queueValues, 0.95),
    ttftP50Ms: quantile(ttftValues, 0.5),
    ttftP95Ms: quantile(ttftValues, 0.95),
    completionTokensPerSecondAvg: mean(throughputValues),
    emailsPerHour: wallTimeMs > 0 ? (responses.length / wallTimeMs) * 3_600_000 : undefined,
    wallTimeMs,
    clientLatencyP50Ms: quantile(
      results.map((sample) => sample.wallTimeMs),
      0.5,
    ),
  };
  summary.score = scoreSummary(summary);
  return summary;
}

function printSummary(summary: BenchmarkSummary): void {
  console.log(`Benchmark: ${summary.label}`);
  console.log(`Base URL: ${summary.baseUrl}`);
  console.log(`Concurrency: ${summary.concurrency}`);
  console.log(`Requests: ${summary.requests}`);
  console.log(
    `Latency: p50=${formatNumber(summary.latencyP50Ms)}ms p95=${formatNumber(summary.latencyP95Ms)}ms`,
  );
  console.log(
    `Queue delay: p50=${formatNumber(summary.queueDelayP50Ms)}ms p95=${formatNumber(summary.queueDelayP95Ms)}ms`,
  );
  console.log(
    `TTFT: p50=${formatNumber(summary.ttftP50Ms)}ms p95=${formatNumber(summary.ttftP95Ms)}ms`,
  );
  console.log(`Completion tok/s: avg=${formatNumber(summary.completionTokensPerSecondAvg)}`);
  console.log(`Response cache hit rate: ${formatNumber(summary.responseCacheHitRate)}%`);
  console.log(
    `Prompt cache hit rate: ${formatNumber(summary.promptCacheHitRate)}% reuse=${formatNumber(
      typeof summary.promptCacheReuseRatio === "number"
        ? summary.promptCacheReuseRatio * 100
        : undefined,
    )}%`,
  );
  console.log(`Emails/hour: ${formatNumber(summary.emailsPerHour)}`);
  console.log(`Score: ${formatNumber(summary.score, 2)}`);
}

function buildAutotuneCandidates(config: RayConfig): AutotuneCandidate[] {
  const base = config.scheduler;
  const concurrencyCeiling =
    config.model.adapter.kind === "llama.cpp" ? Math.max(1, base.concurrency) : 4;
  const concurrencyValues = uniqueIntegers([
    1,
    base.concurrency,
    Math.max(1, base.concurrency - 1),
    Math.min(base.concurrency + 1, concurrencyCeiling),
  ]);
  const batchWindowValues = uniqueIntegers([0, base.batchWindowMs, 5, 10, 15]);
  const affinityValues = uniqueIntegers([8, base.affinityLookahead, 16, 24]);
  const inflightValues = uniqueIntegers([
    Math.max(512, Math.floor(base.maxInflightTokens * 0.75)),
    base.maxInflightTokens,
    Math.floor(base.maxInflightTokens * 1.25),
  ]);
  const shortJobValues = uniqueIntegers([64, base.shortJobMaxTokens, 96, 128]);
  const candidates: AutotuneCandidate[] = [];

  for (const concurrency of concurrencyValues) {
    for (const batchWindowMs of batchWindowValues) {
      for (const affinityLookahead of affinityValues) {
        for (const maxInflightTokens of inflightValues) {
          for (const shortJobMaxTokens of shortJobValues) {
            candidates.push({
              label: `c${concurrency}-bw${batchWindowMs}-aff${affinityLookahead}-if${maxInflightTokens}-short${shortJobMaxTokens}`,
              override: {
                scheduler: {
                  concurrency,
                  batchWindowMs,
                  affinityLookahead,
                  maxInflightTokens,
                  shortJobMaxTokens,
                },
              },
            });
          }
        }
      }
    }
  }

  return candidates;
}

function buildLaunchProfileRecommendations(
  launchProfile: LlamaCppLaunchProfile,
): LaunchProfileCandidate[] {
  const ctxSizes = isCax11Preset(launchProfile.preset)
    ? uniqueIntegers([2048, 2560, launchProfile.ctxSize, 3072])
    : uniqueIntegers([2048, 3072, launchProfile.ctxSize, 4096]);
  const parallels = isCax11Preset(launchProfile.preset)
    ? uniqueIntegers([1, launchProfile.parallel])
    : uniqueIntegers([1, launchProfile.parallel, 2]);
  const batchSizes = isCax11Preset(launchProfile.preset)
    ? uniqueIntegers([96, 128, launchProfile.batchSize, 192])
    : uniqueIntegers([128, launchProfile.batchSize, 256]);
  const recommendations: LaunchProfileCandidate[] = [];

  for (const ctxSize of ctxSizes) {
    for (const parallel of parallels) {
      for (const batchSize of batchSizes) {
        const ubatchSize = Math.min(batchSize, launchProfile.ubatchSize);
        const profile: LlamaCppLaunchProfile = {
          ...launchProfile,
          ctxSize,
          parallel,
          batchSize,
          ubatchSize,
        };
        recommendations.push({
          label: `ctx${ctxSize}-p${parallel}-b${batchSize}`,
          perSlotContext: Math.floor(ctxSize / Math.max(1, parallel)),
          profile,
        });
      }
    }
  }

  return recommendations
    .sort((left, right) => left.perSlotContext - right.perSlotContext)
    .slice(0, 8);
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ignore until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for health at ${baseUrl}`);
}

async function startGateway(configPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      "--import",
      "tsx",
      "./apps/gateway/src/index.ts",
      "--config",
      configPath,
    ],
    {
      cwd: process.cwd(),
      stdio: "ignore",
    },
  );

  return child;
}

async function startLlamaCppServer(launchProfile: LlamaCppLaunchProfile): Promise<ChildProcess> {
  await access(launchProfile.binaryPath);
  await access(launchProfile.modelPath);

  return await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(launchProfile.binaryPath, launchProfile.extraArgs ?? [], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        ...buildLlamaCppEnvironment(launchProfile),
      },
    });

    const onError = (error: Error) => {
      reject(error);
    };

    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      resolve(child);
    });
  });
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGINT");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
  });
}

async function benchmarkGatewayConfig(options: {
  config: RayConfig;
  configPath: string;
  workload: InferenceRequest[];
  concurrency: number;
  requests: number;
  label: string;
  apiKey?: string;
}): Promise<BenchmarkSummary> {
  await writeFile(options.configPath, JSON.stringify(options.config, null, 2));
  const gateway = await startGateway(options.configPath);

  try {
    const baseUrl = buildBaseUrl(options.config.server.host, options.config.server.port);
    await waitForHealth(baseUrl);
    return await runBenchmark({
      baseUrl,
      workload: options.workload,
      concurrency: options.concurrency,
      requests: options.requests,
      label: options.label,
      apiKey: options.apiKey,
    });
  } finally {
    await stopChildProcess(gateway);
  }
}

async function runSchedulerSweep(options: {
  config: RayConfig;
  workload: InferenceRequest[];
  clientConcurrency: number;
  requests: number;
  tempDir: string;
  apiKey?: string;
}): Promise<SchedulerBenchmarkResult[]> {
  const candidates = buildAutotuneCandidates(options.config);
  const results: SchedulerBenchmarkResult[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }

    const candidateConfig = mergeConfig(options.config, {
      ...candidate.override,
      server: {
        port: getPortOffset(options.config.server.port, index),
      },
    });
    const candidatePath = path.join(options.tempDir, `${candidate.label}.json`);
    const summary = await benchmarkGatewayConfig({
      config: candidateConfig,
      configPath: candidatePath,
      workload: options.workload,
      concurrency: options.clientConcurrency,
      requests: options.requests,
      label: candidate.label,
      apiKey: options.apiKey,
    });
    results.push({
      candidate,
      summary,
    });
  }

  return results;
}

async function runLaunchProfileSweep(options: {
  config: RayConfig;
  workload: InferenceRequest[];
  clientConcurrency: number;
  requests: number;
  tempDir: string;
  apiKey?: string;
}): Promise<LaunchProfileBenchmarkResult[]> {
  if (
    options.config.model.adapter.kind !== "llama.cpp" ||
    !options.config.model.adapter.launchProfile
  ) {
    return [];
  }

  const baseLaunchProfile = options.config.model.adapter.launchProfile;
  const candidates = buildLaunchProfileRecommendations(baseLaunchProfile);
  const results: LaunchProfileBenchmarkResult[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }

    const launchedProfile: LlamaCppLaunchProfile = {
      ...candidate.profile,
      port: getPortOffset(baseLaunchProfile.port, index),
    };
    const backend = await startLlamaCppServer(launchedProfile);

    try {
      await waitForHealth(buildBaseUrl(launchedProfile.host, launchedProfile.port), 60_000);
      const candidateConfig = mergeConfig(options.config, {
        server: {
          port: getPortOffset(options.config.server.port, index),
        },
        model: {
          adapter: {
            kind: "llama.cpp",
            baseUrl: buildBaseUrl(launchedProfile.host, launchedProfile.port),
            launchProfile: launchedProfile,
          },
        },
      });
      const summary = await benchmarkGatewayConfig({
        config: candidateConfig,
        configPath: path.join(options.tempDir, `launch-${candidate.label}.json`),
        workload: options.workload,
        concurrency: options.clientConcurrency,
        requests: options.requests,
        label: `llama-${candidate.label}`,
        apiKey: options.apiKey,
      });
      results.push({
        candidate,
        summary,
      });
    } finally {
      await stopChildProcess(backend);
    }
  }

  return results;
}

function printTopSchedulerResults(results: SchedulerBenchmarkResult[]): void {
  const sorted = [...results].sort(
    (left, right) => (right.summary.score ?? 0) - (left.summary.score ?? 0),
  );
  const top = sorted.slice(0, 5);

  console.log(`Autotune scheduler candidates: ${results.length}`);
  for (const result of top) {
    const summary = result.summary;
    console.log(
      `${summary.label}: score=${formatNumber(summary.score, 2)} emails/hour=${formatNumber(
        summary.emailsPerHour,
      )} latencyP95=${formatNumber(summary.latencyP95Ms)}ms queueP95=${formatNumber(
        summary.queueDelayP95Ms,
      )}ms tok/s=${formatNumber(summary.completionTokensPerSecondAvg)}`,
    );
  }
}

function printTopLaunchProfileResults(results: LaunchProfileBenchmarkResult[]): void {
  const sorted = [...results].sort(
    (left, right) => (right.summary.score ?? 0) - (left.summary.score ?? 0),
  );
  const top = sorted.slice(0, 5);

  console.log(`Launch profile candidates: ${results.length}`);
  for (const result of top) {
    const summary = result.summary;
    const profile = result.candidate.profile;
    console.log(
      `${result.candidate.label}: score=${formatNumber(summary.score, 2)} emails/hour=${formatNumber(
        summary.emailsPerHour,
      )} latencyP95=${formatNumber(summary.latencyP95Ms)}ms tok/s=${formatNumber(
        summary.completionTokensPerSecondAvg,
      )} ctx=${profile.ctxSize} parallel=${profile.parallel} batch=${profile.batchSize} cacheRam=${profile.cacheRamMiB ?? "default"}`,
    );
  }
}

function addBaselineCheck(
  checks: BenchmarkComparisonCheck[],
  metric: string,
  operator: BenchmarkCheckOperator,
  expected: number | string,
  actual: number | string | undefined,
): void {
  const normalizedActual = actual ?? "missing";
  const passed =
    operator === "<="
      ? typeof normalizedActual === "number" &&
        typeof expected === "number" &&
        normalizedActual <= expected
      : operator === ">="
        ? typeof normalizedActual === "number" &&
          typeof expected === "number" &&
          normalizedActual >= expected
        : normalizedActual === expected;

  checks.push({
    metric,
    operator,
    expected,
    actual: normalizedActual,
    passed,
  });
}

function compareSummaryToBaseline(options: {
  summary: BenchmarkSummary;
  baseline: BenchmarkBaseline;
  baselinePath: string;
  args: BenchmarkArgs;
}): BenchmarkComparison {
  const checks: BenchmarkComparisonCheck[] = [];
  const { baseline, summary, args } = options;

  addBaselineCheck(checks, "concurrency", "===", baseline.concurrency, summary.concurrency);
  addBaselineCheck(checks, "requests", "===", baseline.requests, summary.requests);

  if (baseline.workloadPath) {
    addBaselineCheck(
      checks,
      "workloadPath",
      "===",
      path.normalize(baseline.workloadPath),
      args.workloadPath ? path.normalize(args.workloadPath) : undefined,
    );
  }

  if (baseline.assertions.maxLatencyP95Ms !== undefined) {
    addBaselineCheck(
      checks,
      "latencyP95Ms",
      "<=",
      baseline.assertions.maxLatencyP95Ms,
      summary.latencyP95Ms,
    );
  }

  if (baseline.assertions.maxQueueDelayP95Ms !== undefined) {
    addBaselineCheck(
      checks,
      "queueDelayP95Ms",
      "<=",
      baseline.assertions.maxQueueDelayP95Ms,
      summary.queueDelayP95Ms,
    );
  }

  if (baseline.assertions.maxTtftP95Ms !== undefined) {
    addBaselineCheck(
      checks,
      "ttftP95Ms",
      "<=",
      baseline.assertions.maxTtftP95Ms,
      summary.ttftP95Ms,
    );
  }

  if (baseline.assertions.minCompletionTokensPerSecondAvg !== undefined) {
    addBaselineCheck(
      checks,
      "completionTokensPerSecondAvg",
      ">=",
      baseline.assertions.minCompletionTokensPerSecondAvg,
      summary.completionTokensPerSecondAvg,
    );
  }

  if (baseline.assertions.minPromptCacheHitRate !== undefined) {
    addBaselineCheck(
      checks,
      "promptCacheHitRate",
      ">=",
      baseline.assertions.minPromptCacheHitRate,
      summary.promptCacheHitRate,
    );
  }

  if (baseline.assertions.minPromptCacheReuseRatio !== undefined) {
    addBaselineCheck(
      checks,
      "promptCacheReuseRatio",
      ">=",
      baseline.assertions.minPromptCacheReuseRatio,
      summary.promptCacheReuseRatio,
    );
  }

  if (baseline.assertions.minEmailsPerHour !== undefined) {
    addBaselineCheck(
      checks,
      "emailsPerHour",
      ">=",
      baseline.assertions.minEmailsPerHour,
      summary.emailsPerHour,
    );
  }

  return {
    baselinePath: path.resolve(process.cwd(), options.baselinePath),
    baselineLabel: baseline.label,
    machineClass: baseline.machineClass,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function printComparison(comparison: BenchmarkComparison): void {
  console.log(
    `Baseline ${comparison.machineClass} (${comparison.baselineLabel}): ${comparison.passed ? "PASS" : "FAIL"}`,
  );

  for (const check of comparison.checks) {
    const actual =
      typeof check.actual === "number" ? formatNumber(check.actual, 2) : String(check.actual);
    const expected =
      typeof check.expected === "number" ? formatNumber(check.expected, 2) : String(check.expected);
    console.log(
      `  ${check.passed ? "ok" : "fail"} ${check.metric} ${check.operator} ${expected} (actual ${actual})`,
    );
  }
}

async function writeStructuredOutput(
  outputPath: string,
  payload: BenchmarkSummaryOutput | AutotuneOutput,
): Promise<void> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote structured output to ${resolvedPath}`);
}

async function runAutotune(
  args: BenchmarkArgs,
  workload: InferenceRequest[],
): Promise<AutotuneOutput> {
  if (!args.configPath) {
    throw new Error("--autotune requires --config");
  }

  const loaded = await loadRayConfig({
    cwd: process.cwd(),
    configPath: args.configPath,
  });
  const config = loaded.config;
  const apiKey = resolveBenchmarkApiKey(args, config);
  if (config.auth.enabled && !apiKey) {
    throw new Error(
      `Auth is enabled in ${args.configPath}. Supply --api-key, set ${BENCHMARK_API_KEY_ENV}, or populate ${config.auth.apiKeyEnv}.`,
    );
  }

  const scope = resolveAutotuneScope(args, config);
  if (
    scope === "full" &&
    (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile)
  ) {
    throw new Error("Full autotune requires a llama.cpp adapter with a launchProfile.");
  }

  const baseRequests = args.requests ?? Math.max(workload.length * 3, 12);
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-autotune-"));
  let pinnedBackend: ChildProcess | undefined;

  try {
    let schedulerBaseConfig = config;
    let bestLaunchProfile: LlamaCppLaunchProfile | undefined;
    let launchResultsOutput: AutotuneOutput["launchResults"] | undefined;

    if (
      scope === "full" &&
      config.model.adapter.kind === "llama.cpp" &&
      config.model.adapter.launchProfile
    ) {
      const launchResults = await runLaunchProfileSweep({
        config,
        workload,
        clientConcurrency: args.concurrency,
        requests: baseRequests,
        tempDir,
        apiKey,
      });
      if (launchResults.length === 0) {
        throw new Error("No llama.cpp launch profile candidates were benchmarked.");
      }

      printTopLaunchProfileResults(launchResults);
      const bestLaunchResult = [...launchResults].sort(
        (left, right) => (right.summary.score ?? 0) - (left.summary.score ?? 0),
      )[0];
      if (!bestLaunchResult) {
        throw new Error("Unable to resolve a winning llama.cpp launch profile candidate.");
      }

      bestLaunchProfile = bestLaunchResult.candidate.profile;
      launchResultsOutput = launchResults.map((result) => ({
        label: result.candidate.label,
        profile: result.candidate.profile,
        summary: result.summary,
      }));

      const launchedProfile: LlamaCppLaunchProfile = {
        ...bestLaunchProfile,
        port: getPortOffset(config.model.adapter.launchProfile.port, 100),
      };
      pinnedBackend = await startLlamaCppServer(launchedProfile);

      await waitForHealth(buildBaseUrl(launchedProfile.host, launchedProfile.port), 60_000);
      schedulerBaseConfig = mergeConfig(config, {
        model: {
          adapter: {
            kind: "llama.cpp",
            baseUrl: buildBaseUrl(launchedProfile.host, launchedProfile.port),
            launchProfile: launchedProfile,
          },
        },
      });
    }

    const schedulerResults = await runSchedulerSweep({
      config: schedulerBaseConfig,
      workload,
      clientConcurrency: args.concurrency,
      requests: baseRequests,
      tempDir,
      apiKey,
    });
    printTopSchedulerResults(schedulerResults);
    const bestSchedulerResult = [...schedulerResults].sort(
      (left, right) => (right.summary.score ?? 0) - (left.summary.score ?? 0),
    )[0];
    if (!bestSchedulerResult) {
      throw new Error("No scheduler candidates were benchmarked.");
    }

    const recommendedPatch: DeepPartial<RayConfig> = bestLaunchProfile
      ? {
          model: {
            adapter: {
              launchProfile: bestLaunchProfile,
            },
          },
          scheduler: bestSchedulerResult.candidate.override.scheduler,
        }
      : {
          scheduler: bestSchedulerResult.candidate.override.scheduler,
        };

    console.log("\nRecommended autotune patch:");
    console.log(JSON.stringify(recommendedPatch, null, 2));

    return {
      kind: "autotune-report",
      version: STRUCTURED_OUTPUT_VERSION,
      generatedAt: new Date().toISOString(),
      args: {
        configPath: path.resolve(process.cwd(), args.configPath),
        scope,
        ...(args.workloadPath ? { workloadPath: args.workloadPath } : {}),
        concurrency: args.concurrency,
        requests: baseRequests,
      },
      ...(launchResultsOutput ? { launchResults: launchResultsOutput } : {}),
      schedulerResults: schedulerResults.map((result) => ({
        label: result.candidate.label,
        schedulerOverride: result.candidate.override.scheduler,
        summary: result.summary,
      })),
      recommendedPatch,
    };
  } finally {
    if (pinnedBackend) {
      await stopChildProcess(pinnedBackend);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.assertBaseline && !args.baselinePath) {
    throw new Error("--assert-baseline requires --baseline");
  }

  const workload = await loadWorkload(args.workloadPath);

  if (args.autotune) {
    const report = await runAutotune(args, workload);
    if (args.outputPath) {
      await writeStructuredOutput(args.outputPath, report);
    }
    return;
  }

  const directConfig = args.configPath
    ? (
        await loadRayConfig({
          cwd: process.cwd(),
          configPath: args.configPath,
        })
      ).config
    : undefined;
  const requests = args.requests ?? workload.length;
  const summary = await runBenchmark({
    baseUrl: args.baseUrl,
    workload,
    concurrency: args.concurrency,
    requests,
    label: args.label ?? args.workloadPath ?? "default-workload",
    apiKey: resolveBenchmarkApiKey(args, directConfig),
  });
  printSummary(summary);

  let comparison: BenchmarkComparison | undefined;
  if (args.baselinePath) {
    const baseline = await loadBaseline(args.baselinePath);
    comparison = compareSummaryToBaseline({
      summary,
      baseline,
      baselinePath: args.baselinePath,
      args,
    });
    console.log("");
    printComparison(comparison);
  }

  if (args.outputPath) {
    await writeStructuredOutput(args.outputPath, {
      kind: "benchmark-summary",
      version: STRUCTURED_OUTPUT_VERSION,
      generatedAt: new Date().toISOString(),
      args: {
        baseUrl: args.baseUrl,
        ...(args.workloadPath ? { workloadPath: args.workloadPath } : {}),
        concurrency: args.concurrency,
        requests,
        label: summary.label,
        ...(args.configPath ? { configPath: path.resolve(process.cwd(), args.configPath) } : {}),
        ...(args.baselinePath
          ? { baselinePath: path.resolve(process.cwd(), args.baselinePath) }
          : {}),
      },
      summary,
      ...(comparison ? { comparison } : {}),
    });
  }

  if (args.assertBaseline && comparison && !comparison.passed) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
