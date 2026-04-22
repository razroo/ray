import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRayConfig, mergeConfig, type DeepPartial } from "@ray/config";
import type { LlamaCppLaunchProfile, RayConfig } from "@razroo/ray-core";
import { buildLlamaCppEnvironment } from "../packages/deploy/src/index.ts";

type AutotuneScope = "auto" | "gateway" | "full";

interface BenchmarkArgs {
  baseUrl: string;
  workloadPath?: string;
  concurrency: number;
  requests?: number;
  label?: string;
  configPath?: string;
  apiKey?: string;
  autotune: boolean;
  autotuneScope: AutotuneScope;
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
  console.log("  --autotune              Sweep scheduler settings using the supplied config.");
  console.log("  --autotune-scope <mode> Autotune scope: auto, gateway, or full. Default: auto.");
  console.log("  --help, -h              Show this help text.");
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
  const concurrencyValues = uniqueIntegers([
    1,
    base.concurrency,
    Math.max(1, base.concurrency - 1),
    Math.min(base.concurrency + 1, config.model.adapter.kind === "llama.cpp" ? 2 : 4),
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
  const ctxSizes = uniqueIntegers([2048, 3072, launchProfile.ctxSize, 4096]);
  const parallels = uniqueIntegers([1, launchProfile.parallel, 2]);
  const batchSizes = uniqueIntegers([128, launchProfile.batchSize, 256]);
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

async function runAutotune(args: BenchmarkArgs, workload: InferenceRequest[]): Promise<void> {
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
      `Auth is enabled in ${args.configPath}. Supply --api-key or populate ${config.auth.apiKeyEnv}.`,
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

  try {
    let schedulerBaseConfig = config;
    let bestLaunchProfile: LlamaCppLaunchProfile | undefined;

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
      const launchedProfile: LlamaCppLaunchProfile = {
        ...bestLaunchProfile,
        port: getPortOffset(config.model.adapter.launchProfile.port, 100),
      };
      const backend = await startLlamaCppServer(launchedProfile);

      try {
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

        console.log("\nRecommended autotune patch:");
        console.log(
          JSON.stringify(
            {
              model: {
                adapter: {
                  launchProfile: bestLaunchProfile,
                },
              },
              scheduler: bestSchedulerResult.candidate.override.scheduler,
            },
            null,
            2,
          ),
        );
      } finally {
        await stopChildProcess(backend);
      }
      return;
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

    console.log("\nRecommended autotune patch:");
    console.log(
      JSON.stringify(
        {
          scheduler: bestSchedulerResult.candidate.override.scheduler,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const workload = await loadWorkload(args.workloadPath);

  if (args.autotune) {
    await runAutotune(args, workload);
    return;
  }

  const summary = await runBenchmark({
    baseUrl: args.baseUrl,
    workload,
    concurrency: args.concurrency,
    requests: args.requests ?? workload.length,
    label: args.label ?? args.workloadPath ?? "default-workload",
    apiKey: args.apiKey,
  });
  printSummary(summary);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
