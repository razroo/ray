import { access, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRayConfig, mergeConfig, type DeepPartial } from "@ray/config";
import type { LlamaCppLaunchProfile, RayConfig } from "@razroo/ray-core";
import { buildLlamaCppEnvironment, buildLlamaCppLaunchArgs } from "../packages/deploy/src/index.ts";

type AutotuneScope = "auto" | "gateway" | "full";
type BenchmarkCheckOperator = "<=" | ">=" | "===";

const STRUCTURED_OUTPUT_VERSION = 1;
const BENCHMARK_API_KEY_ENV = "RAY_BENCHMARK_API_KEY";
const MAX_BENCHMARK_WORKLOAD_FILE_BYTES = 1_048_576;
const MAX_BENCHMARK_BASELINE_FILE_BYTES = 256 * 1024;
const MAX_BENCHMARK_WORKLOAD_ITEMS = 1_024;
const MAX_BENCHMARK_CLI_ARGS = 128;
const MAX_BENCHMARK_CLI_ARG_BYTES = 4_096;
const MAX_BENCHMARK_PATH_BYTES = 4_096;
const MAX_BENCHMARK_CONCURRENCY = 64;
const MAX_BENCHMARK_REQUESTS = 10_000;
const DEFAULT_AUTOTUNE_SCHEDULER_CANDIDATES = 64;
const MAX_AUTOTUNE_SCHEDULER_CANDIDATES = 256;
const MAX_BENCHMARK_LABEL_CHARS = 256;
const MAX_BENCHMARK_API_KEY_CHARS = 4_096;
const MAX_BENCHMARK_TEXT_CHARS = 65_536;
const MAX_BENCHMARK_METADATA_KEYS = 32;
const MAX_BENCHMARK_METADATA_KEY_CHARS = 128;
const MAX_BENCHMARK_METADATA_VALUE_CHARS = 4_096;
const MAX_BENCHMARK_TEMPLATE_VARIABLES = 64;
const MAX_BENCHMARK_TEMPLATE_VARIABLE_KEY_CHARS = 128;
const MAX_BENCHMARK_TEMPLATE_VARIABLE_VALUE_CHARS = 16_384;
const MAX_BENCHMARK_STOP_SEQUENCES = 16;
const MAX_BENCHMARK_STOP_SEQUENCE_CHARS = 256;
const MAX_BENCHMARK_QUALITY_STRINGS = 32;
const MAX_BENCHMARK_QUALITY_STRING_CHARS = 1_024;
const MAX_BENCHMARK_BASELINE_NOTES = 16;
const MAX_BENCHMARK_BASELINE_NOTE_CHARS = 1_024;
const MAX_BENCHMARK_REQUEST_BODY_BYTES = 1_048_576;
const MAX_BENCHMARK_ERROR_RESPONSE_BYTES = 64 * 1024;
const MAX_BENCHMARK_SUCCESS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BENCHMARK_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BENCHMARK_HISTORY_FILE_BYTES = 8 * 1024 * 1024;
const BENCHMARK_HISTORY_RETAIN_BYTES = 6 * 1024 * 1024;
const MAX_BENCHMARK_CHILD_OUTPUT_BYTES = 32 * 1024;
const BENCHMARK_REQUEST_TIMEOUT_MS = 180_000;
const BENCHMARK_HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const BUN_RUNTIME_BINARY = process.env.RAY_BUN_BINARY ?? "bun";
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const baselineAssertionKeys = new Set<keyof BenchmarkBaselineAssertions>([
  "maxLatencyP95Ms",
  "maxQueueDelayP95Ms",
  "maxTtftP95Ms",
  "minCompletionTokensPerSecondAvg",
  "minPromptCacheHitRate",
  "minPromptCacheReuseRatio",
  "minEmailsPerHour",
  "minQualityPassRate",
  "minQualityScoreAvg",
  "minValidJsonRate",
]);
const benchmarkChildOutputCaptures = new WeakMap<ChildProcess, BenchmarkChildOutputCapture>();

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
  historyDir?: string;
  promptFormatSweep: boolean;
  autotune: boolean;
  autotuneScope: AutotuneScope;
  autotuneMaxCandidates: number;
  assertBaseline: boolean;
  help: boolean;
}

interface InferenceRequest {
  input?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
  responseFormat?: {
    type: "text" | "json_object";
  };
  cache?: boolean;
  dedupeKey?: string;
  metadata?: Record<string, string>;
  templateId?: string;
  templateVariables?: Record<string, string | number | boolean>;
}

interface BenchmarkQualityAssertions {
  requiresValidJson?: boolean;
  minOutputChars?: number;
  maxOutputChars?: number;
  mustContain?: string[];
  mustNotContain?: string[];
  noPromptEcho?: boolean;
  stopMustNotAppear?: boolean;
  requiresCallToAction?: boolean;
  noSubjectGreetingSignoff?: boolean;
}

interface BenchmarkWorkloadItem extends InferenceRequest {
  benchmark?: BenchmarkQualityAssertions;
}

interface RunBenchmarkOptions {
  baseUrl: string;
  workload: BenchmarkWorkloadItem[];
  concurrency: number;
  requests: number;
  label: string;
  apiKey?: string;
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
      requestShape?: "openai-chat" | "llama.cpp-completion";
      promptFormat?: "llama.cpp-template" | "prompt-scaffold" | "ray-chat-fallback";
      promptFormatReason?: string;
      jsonRepairAttempted?: boolean;
      jsonRepairSucceeded?: boolean;
      modelRef?: string;
      backendModel?: string;
      launchPreset?: string;
      totalSlots?: number;
      tokensCached?: number;
      slotId?: number;
      preferredSlot?: number;
      slotRouteReason?: string;
      contextWindow?: number;
      timings?: {
        ttftMs?: number;
        completionTokensPerSecond?: number;
      };
    };
  };
}

type BenchmarkProviderDiagnostics = NonNullable<
  NonNullable<InferenceResponse["diagnostics"]>["provider"]
>;

interface BenchmarkSample {
  request: BenchmarkWorkloadItem;
  response: InferenceResponse;
  wallTimeMs: number;
}

interface BenchmarkAccumulator {
  requests: number;
  responseCacheHits: number;
  promptCacheHits: number;
  qualityPasses: number;
  jsonRequests: number;
  validJsonResponses: number;
  promptEchoRejects: number;
  latencyValues: number[];
  queueValues: number[];
  ttftValues: number[];
  throughputValues: number[];
  promptCacheRatios: number[];
  clientLatencyValues: number[];
  qualityScores: number[];
  providerDiagnostics: BenchmarkProviderDiagnostics[];
}

interface BenchmarkProviderDiagnosticsSummary {
  requestShapes: Record<string, number>;
  promptFormats: Record<string, number>;
  promptFormatReasons: Record<string, number>;
  slotRouteReasons: Record<string, number>;
  modelRefs: Record<string, number>;
  backendModels: Record<string, number>;
  launchPresets: Record<string, number>;
  jsonRepairAttempts?: number;
  jsonRepairSuccesses?: number;
  totalSlots?: number;
  contextWindowP50?: number;
  slotReuseRate?: number;
  cachedTokensAvg?: number;
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
  qualityPassRate?: number;
  validJsonRate?: number;
  promptEchoRejects?: number;
  qualityFailures?: number;
  qualityScoreAvg?: number;
  qualityScoreP50?: number;
  providerDiagnostics?: BenchmarkProviderDiagnosticsSummary;
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

interface BenchmarkChildOutputCapture {
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface BenchmarkBaselineAssertions {
  maxLatencyP95Ms?: number;
  maxQueueDelayP95Ms?: number;
  maxTtftP95Ms?: number;
  minCompletionTokensPerSecondAvg?: number;
  minPromptCacheHitRate?: number;
  minPromptCacheReuseRatio?: number;
  minEmailsPerHour?: number;
  minQualityPassRate?: number;
  minQualityScoreAvg?: number;
  minValidJsonRate?: number;
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
    schedulerCandidateLimit: number;
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

interface PromptFormatSweepOutput {
  kind: "prompt-format-sweep";
  version: number;
  generatedAt: string;
  args: {
    baseUrl: string;
    workloadPath?: string;
    concurrency: number;
    requests: number;
    label: string;
  };
  results: Array<{
    promptFormat: string;
    summary: BenchmarkSummary;
  }>;
  recommendedPromptFormat: string;
}

const defaultWorkload: BenchmarkWorkloadItem[] = [
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

function assertCliArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv)) {
    throw new Error("argv must be an array of strings");
  }

  if (argv.length > MAX_BENCHMARK_CLI_ARGS) {
    throw new Error(`argv must contain at most ${MAX_BENCHMARK_CLI_ARGS} entries`);
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      throw new Error(`argv[${index}] must be a string`);
    }

    if (value.includes("\0")) {
      throw new Error(`argv[${index}] must not contain NUL bytes`);
    }

    if (Buffer.byteLength(value, "utf8") > MAX_BENCHMARK_CLI_ARG_BYTES) {
      throw new Error(`argv[${index}] must be at most ${MAX_BENCHMARK_CLI_ARG_BYTES} bytes`);
    }
  }
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parsePositiveIntegerFlag(value: string, label: string, maximum: number): number {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  if (parsed > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }

  return parsed;
}

function assertNonEmptyStringAtMost(value: string, label: string, maximum: number): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }

  if (value.length > maximum) {
    throw new Error(`${label} must be at most ${maximum} characters`);
  }
}

function assertPathFlagValue(value: string, label: string): void {
  assertBenchmarkPathValue(value, label);
}

function assertBenchmarkPathValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }

  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }

  if (Buffer.byteLength(value, "utf8") > MAX_BENCHMARK_PATH_BYTES) {
    throw new Error(`${label} must be at most ${MAX_BENCHMARK_PATH_BYTES} bytes`);
  }
}

function normalizeBaseUrlFlag(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--base-url must be an absolute HTTP URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--base-url must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new Error("--base-url must not include credentials");
  }

  if (parsed.search || parsed.hash) {
    throw new Error("--base-url must not include a query string or fragment");
  }

  return parsed.toString().replace(/\/$/, "");
}

export function parseArgs(argv: string[]): BenchmarkArgs {
  assertCliArgv(argv);

  const result: BenchmarkArgs = {
    baseUrl: "http://127.0.0.1:3000",
    concurrency: 1,
    promptFormatSweep: false,
    autotune: false,
    autotuneScope: "auto",
    autotuneMaxCandidates: DEFAULT_AUTOTUNE_SCHEDULER_CANDIDATES,
    assertBaseline: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

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

    if (current === "--prompt-format-sweep") {
      result.promptFormatSweep = true;
      continue;
    }

    if (current === "--assert-baseline") {
      result.assertBaseline = true;
      continue;
    }

    if (current === "--base-url") {
      result.baseUrl = normalizeBaseUrlFlag(readFlagValue(argv, index, current));
      index += 1;
      continue;
    }

    if (current === "--workload") {
      const value = readFlagValue(argv, index, current);
      assertPathFlagValue(value, "--workload");
      result.workloadPath = value;
      index += 1;
      continue;
    }

    if (current === "--concurrency") {
      result.concurrency = parsePositiveIntegerFlag(
        readFlagValue(argv, index, current),
        "--concurrency",
        MAX_BENCHMARK_CONCURRENCY,
      );
      index += 1;
      continue;
    }

    if (current === "--requests") {
      result.requests = parsePositiveIntegerFlag(
        readFlagValue(argv, index, current),
        "--requests",
        MAX_BENCHMARK_REQUESTS,
      );
      index += 1;
      continue;
    }

    if (current === "--label") {
      const value = readFlagValue(argv, index, current);
      assertNonEmptyStringAtMost(value, "--label", MAX_BENCHMARK_LABEL_CHARS);
      result.label = value;
      index += 1;
      continue;
    }

    if (current === "--api-key") {
      const value = readFlagValue(argv, index, current);
      assertNonEmptyStringAtMost(value, "--api-key", MAX_BENCHMARK_API_KEY_CHARS);
      result.apiKey = value;
      index += 1;
      continue;
    }

    if (current === "--config") {
      const value = readFlagValue(argv, index, current);
      assertPathFlagValue(value, "--config");
      result.configPath = value;
      index += 1;
      continue;
    }

    if (current === "--output") {
      const value = readFlagValue(argv, index, current);
      assertPathFlagValue(value, "--output");
      result.outputPath = value;
      index += 1;
      continue;
    }

    if (current === "--history-dir") {
      const value = readFlagValue(argv, index, current);
      assertPathFlagValue(value, "--history-dir");
      result.historyDir = value;
      index += 1;
      continue;
    }

    if (current === "--baseline") {
      const value = readFlagValue(argv, index, current);
      assertPathFlagValue(value, "--baseline");
      result.baselinePath = value;
      index += 1;
      continue;
    }

    if (current === "--autotune-scope") {
      const value = readFlagValue(argv, index, current);
      if (value !== "auto" && value !== "gateway" && value !== "full") {
        throw new Error("--autotune-scope must be auto, gateway, or full");
      }
      result.autotuneScope = value;
      index += 1;
      continue;
    }

    if (current === "--autotune-max-candidates") {
      result.autotuneMaxCandidates = parsePositiveIntegerFlag(
        readFlagValue(argv, index, current),
        "--autotune-max-candidates",
        MAX_AUTOTUNE_SCHEDULER_CANDIDATES,
      );
      index += 1;
      continue;
    }

    if (current.startsWith("-")) {
      throw new Error(`Unknown option: ${current}`);
    }

    throw new Error(`Unexpected positional argument: ${current}`);
  }

  return result;
}

function printUsage(): void {
  console.log("Usage: bun run benchmark -- [options]");
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
  console.log("  --history-dir <path>    Append structured benchmark output to JSONL history.");
  console.log("  --baseline <path>       Compare the benchmark summary against a baseline JSON.");
  console.log("  --assert-baseline       Exit non-zero if the baseline checks fail.");
  console.log("  --prompt-format-sweep   Run llama.cpp template/scaffold/Ray fallback variants.");
  console.log("  --autotune              Sweep scheduler settings using the supplied config.");
  console.log("  --autotune-scope <mode> Autotune scope: auto, gateway, or full. Default: auto.");
  console.log(
    `  --autotune-max-candidates <n> Max scheduler candidates. Default: ${DEFAULT_AUTOTUNE_SCHEDULER_CANDIDATES}, max: ${MAX_AUTOTUNE_SCHEDULER_CANDIDATES}.`,
  );
  console.log("  --help, -h              Show this help text.");
  console.log("");
  console.log(`Auth fallback env: ${BENCHMARK_API_KEY_ENV}`);
}

async function readTextFileBounded(
  filePath: string,
  limitBytes: number,
  label: string,
): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();

    if (!stats.isFile()) {
      throw new Error(`${label} path must be a file: ${filePath}`);
    }

    if (stats.size > limitBytes) {
      throw new Error(`${label} file must be at most ${limitBytes} bytes: ${filePath}`);
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function workloadSourceName(source: string): string {
  return source === "Benchmark workload" ? "Benchmark workload" : "Workload file";
}

function assertWorkloadSize(workload: BenchmarkWorkloadItem[], source: string): void {
  const sourceName = workloadSourceName(source);

  if (workload.length === 0) {
    throw new Error(`${sourceName} has no usable entries: ${source}`);
  }

  if (workload.length > MAX_BENCHMARK_WORKLOAD_ITEMS) {
    throw new Error(
      `${sourceName} must contain at most ${MAX_BENCHMARK_WORKLOAD_ITEMS} entries: ${source}`,
    );
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  for (const key of Object.keys(value)) {
    if (unsafeObjectKeys.has(key)) {
      throw new Error(`${label} cannot include unsafe key ${key}`);
    }
  }
}

function assertOptionalStringValue(
  value: unknown,
  label: string,
  maxChars: number,
): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters`);
  }
}

function assertStringValue(
  value: unknown,
  label: string,
  maxChars: number,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (value.length > maxChars) {
    throw new Error(`${label} must be at most ${maxChars} characters`);
  }
}

function assertOptionalBooleanValue(
  value: unknown,
  label: string,
): asserts value is boolean | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}

function assertOptionalPositiveIntegerValue(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  if (value > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertPositiveIntegerValue(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  if (value > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertOptionalNonNegativeIntegerValue(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  if (value > maximum) {
    throw new Error(`${label} must be less than or equal to ${maximum}`);
  }
}

function assertOptionalNonNegativeNumberValue(
  value: unknown,
  label: string,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertNonNegativeNumberValue(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function assertOptionalNumberInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number | undefined {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number between ${minimum} and ${maximum}`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  maxEntries: number,
  maxEntryChars: number,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  if (value.length > maxEntries) {
    throw new Error(`${label} must contain at most ${maxEntries} entries`);
  }

  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index}] must be a string`);
    }

    if (entry.length > maxEntryChars) {
      throw new Error(`${label}[${index}] must be at most ${maxEntryChars} characters`);
    }
  }
}

function assertOptionalStringArray(
  value: unknown,
  label: string,
  maxEntries: number,
  maxEntryChars: number,
): asserts value is string[] | undefined {
  if (value === undefined) {
    return;
  }

  assertStringArray(value, label, maxEntries, maxEntryChars);
}

function assertOptionalStringRecord(
  value: unknown,
  label: string,
  maxEntries: number,
  maxKeyChars: number,
  maxValueChars: number,
): asserts value is Record<string, string> | undefined {
  if (value === undefined) {
    return;
  }

  assertRecord(value, label);
  const entries = Object.entries(value);

  if (entries.length > maxEntries) {
    throw new Error(`${label} must contain at most ${maxEntries} entries`);
  }

  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > maxKeyChars) {
      throw new Error(`${label} keys must be 1-${maxKeyChars} characters`);
    }

    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }

    if (entry.length > maxValueChars) {
      throw new Error(`${label}.${key} must be at most ${maxValueChars} characters`);
    }
  }
}

function assertOptionalTemplateVariables(
  value: unknown,
  label: string,
): asserts value is Record<string, string | number | boolean> | undefined {
  if (value === undefined) {
    return;
  }

  assertRecord(value, label);
  const entries = Object.entries(value);

  if (entries.length > MAX_BENCHMARK_TEMPLATE_VARIABLES) {
    throw new Error(`${label} must contain at most ${MAX_BENCHMARK_TEMPLATE_VARIABLES} entries`);
  }

  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_BENCHMARK_TEMPLATE_VARIABLE_KEY_CHARS) {
      throw new Error(
        `${label} keys must be 1-${MAX_BENCHMARK_TEMPLATE_VARIABLE_KEY_CHARS} characters`,
      );
    }

    if (typeof entry === "string") {
      if (entry.length > MAX_BENCHMARK_TEMPLATE_VARIABLE_VALUE_CHARS) {
        throw new Error(
          `${label}.${key} must be at most ${MAX_BENCHMARK_TEMPLATE_VARIABLE_VALUE_CHARS} characters`,
        );
      }
      continue;
    }

    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new Error(`${label}.${key} must be a finite number`);
      }
      continue;
    }

    if (typeof entry !== "boolean") {
      throw new Error(`${label}.${key} must be a string, number, or boolean`);
    }
  }
}

function assertOptionalResponseFormat(
  value: unknown,
  label: string,
): asserts value is InferenceRequest["responseFormat"] | undefined {
  if (value === undefined) {
    return;
  }

  assertRecord(value, label);
  if (value.type !== "text" && value.type !== "json_object") {
    throw new Error(`${label}.type must be text or json_object`);
  }
}

function assertOptionalBenchmarkAssertions(
  value: unknown,
  label: string,
): asserts value is BenchmarkQualityAssertions | undefined {
  if (value === undefined) {
    return;
  }

  assertRecord(value, label);
  assertOptionalBooleanValue(value.requiresValidJson, `${label}.requiresValidJson`);
  assertOptionalBooleanValue(value.noPromptEcho, `${label}.noPromptEcho`);
  assertOptionalBooleanValue(value.stopMustNotAppear, `${label}.stopMustNotAppear`);
  assertOptionalBooleanValue(value.requiresCallToAction, `${label}.requiresCallToAction`);
  assertOptionalBooleanValue(value.noSubjectGreetingSignoff, `${label}.noSubjectGreetingSignoff`);
  assertOptionalNonNegativeIntegerValue(
    value.minOutputChars,
    `${label}.minOutputChars`,
    MAX_BENCHMARK_TEXT_CHARS,
  );
  assertOptionalNonNegativeIntegerValue(
    value.maxOutputChars,
    `${label}.maxOutputChars`,
    MAX_BENCHMARK_TEXT_CHARS,
  );

  if (
    typeof value.minOutputChars === "number" &&
    typeof value.maxOutputChars === "number" &&
    value.minOutputChars > value.maxOutputChars
  ) {
    throw new Error(`${label}.minOutputChars must be less than or equal to maxOutputChars`);
  }

  assertOptionalStringArray(
    value.mustContain,
    `${label}.mustContain`,
    MAX_BENCHMARK_QUALITY_STRINGS,
    MAX_BENCHMARK_QUALITY_STRING_CHARS,
  );
  assertOptionalStringArray(
    value.mustNotContain,
    `${label}.mustNotContain`,
    MAX_BENCHMARK_QUALITY_STRINGS,
    MAX_BENCHMARK_QUALITY_STRING_CHARS,
  );
}

function assertBenchmarkWorkloadItem(
  value: unknown,
  label: string,
): asserts value is BenchmarkWorkloadItem {
  assertRecord(value, label);
  assertOptionalStringValue(value.input, `${label}.input`, MAX_BENCHMARK_TEXT_CHARS);
  assertOptionalStringValue(value.system, `${label}.system`, MAX_BENCHMARK_TEXT_CHARS);
  assertOptionalStringValue(value.templateId, `${label}.templateId`, MAX_BENCHMARK_LABEL_CHARS);
  assertOptionalStringValue(value.dedupeKey, `${label}.dedupeKey`, MAX_BENCHMARK_LABEL_CHARS);

  if (value.input === undefined && value.templateId === undefined) {
    throw new Error(`${label} must include input or templateId`);
  }

  assertOptionalPositiveIntegerValue(value.maxTokens, `${label}.maxTokens`, 8_192);
  assertOptionalNumberInRange(value.temperature, `${label}.temperature`, 0, 2);
  assertOptionalNumberInRange(value.topP, `${label}.topP`, 0, 1);
  assertOptionalNonNegativeIntegerValue(value.seed, `${label}.seed`);
  assertOptionalBooleanValue(value.cache, `${label}.cache`);
  assertOptionalResponseFormat(value.responseFormat, `${label}.responseFormat`);
  assertOptionalStringArray(
    value.stop,
    `${label}.stop`,
    MAX_BENCHMARK_STOP_SEQUENCES,
    MAX_BENCHMARK_STOP_SEQUENCE_CHARS,
  );
  assertOptionalStringRecord(
    value.metadata,
    `${label}.metadata`,
    MAX_BENCHMARK_METADATA_KEYS,
    MAX_BENCHMARK_METADATA_KEY_CHARS,
    MAX_BENCHMARK_METADATA_VALUE_CHARS,
  );
  assertOptionalTemplateVariables(value.templateVariables, `${label}.templateVariables`);
  assertOptionalBenchmarkAssertions(value.benchmark, `${label}.benchmark`);
}

function validateWorkload(workload: unknown, resolvedPath: string): BenchmarkWorkloadItem[] {
  if (!Array.isArray(workload)) {
    throw new Error(`${resolvedPath} must be an array of workload entries`);
  }

  assertWorkloadSize(workload as BenchmarkWorkloadItem[], resolvedPath);

  for (const [index, item] of workload.entries()) {
    assertBenchmarkWorkloadItem(item, `Workload entry ${index + 1}`);
  }

  return workload as BenchmarkWorkloadItem[];
}

function assertRunBenchmarkOptions(value: unknown): asserts value is RunBenchmarkOptions {
  assertRecord(value, "Benchmark options");
  assertStringValue(value.baseUrl, "Benchmark baseUrl", MAX_BENCHMARK_CLI_ARG_BYTES);
  normalizeBaseUrlFlag(value.baseUrl);
  validateWorkload(value.workload, "Benchmark workload");
  assertPositiveIntegerValue(value.concurrency, "Benchmark concurrency", MAX_BENCHMARK_CONCURRENCY);
  assertPositiveIntegerValue(value.requests, "Benchmark requests", MAX_BENCHMARK_REQUESTS);
  assertStringValue(value.label, "Benchmark label", MAX_BENCHMARK_LABEL_CHARS);
  if (value.apiKey !== undefined) {
    assertOptionalStringValue(value.apiKey, "Benchmark apiKey", MAX_BENCHMARK_API_KEY_CHARS);
  }
}

function assertBaselineAssertions(
  value: unknown,
  label: string,
): asserts value is BenchmarkBaselineAssertions {
  assertRecord(value, label);

  for (const key of Object.keys(value)) {
    if (!baselineAssertionKeys.has(key as keyof BenchmarkBaselineAssertions)) {
      throw new Error(`${label}.${key} is not a supported benchmark assertion`);
    }
  }

  for (const key of baselineAssertionKeys) {
    assertOptionalNonNegativeNumberValue(value[key], `${label}.${key}`);
  }
}

function assertBenchmarkBaseline(
  value: unknown,
  label: string,
): asserts value is BenchmarkBaseline {
  assertRecord(value, label);

  if (value.version !== 1) {
    throw new Error(`Unsupported benchmark baseline version in ${label}: ${String(value.version)}`);
  }

  assertOptionalStringValue(value.label, `${label}.label`, MAX_BENCHMARK_LABEL_CHARS);
  assertOptionalStringValue(value.machineClass, `${label}.machineClass`, MAX_BENCHMARK_LABEL_CHARS);
  assertOptionalStringValue(
    value.workloadPath,
    `${label}.workloadPath`,
    MAX_BENCHMARK_CLI_ARG_BYTES,
  );
  assertOptionalPositiveIntegerValue(
    value.concurrency,
    `${label}.concurrency`,
    MAX_BENCHMARK_CONCURRENCY,
  );
  assertOptionalPositiveIntegerValue(value.requests, `${label}.requests`, MAX_BENCHMARK_REQUESTS);

  if (value.label === undefined) {
    throw new Error(`${label}.label is required`);
  }

  if (value.machineClass === undefined) {
    throw new Error(`${label}.machineClass is required`);
  }

  if (value.concurrency === undefined) {
    throw new Error(`${label}.concurrency is required`);
  }

  if (value.requests === undefined) {
    throw new Error(`${label}.requests is required`);
  }

  if (value.assertions === undefined) {
    throw new Error(`${label}.assertions is required`);
  }
  assertBaselineAssertions(value.assertions, `${label}.assertions`);

  if (value.notes !== undefined) {
    assertStringArray(
      value.notes,
      `${label}.notes`,
      MAX_BENCHMARK_BASELINE_NOTES,
      MAX_BENCHMARK_BASELINE_NOTE_CHARS,
    );
  }
}

export async function loadWorkload(workloadPath?: string): Promise<BenchmarkWorkloadItem[]> {
  if (!workloadPath) {
    return defaultWorkload;
  }

  assertBenchmarkPathValue(workloadPath, "Workload path");
  const resolvedPath = path.resolve(process.cwd(), workloadPath);
  const raw = await readTextFileBounded(
    resolvedPath,
    MAX_BENCHMARK_WORKLOAD_FILE_BYTES,
    "Workload",
  );
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new Error(`Workload file is empty: ${resolvedPath}`);
  }

  let workload: unknown[];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Workload file must contain a JSON array: ${resolvedPath}`);
    }
    workload = parsed;
  } else {
    workload = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }

  return validateWorkload(workload, resolvedPath);
}

export async function loadBaseline(baselinePath: string): Promise<BenchmarkBaseline> {
  assertBenchmarkPathValue(baselinePath, "Baseline path");
  const resolvedPath = path.resolve(process.cwd(), baselinePath);
  const raw = await readTextFileBounded(
    resolvedPath,
    MAX_BENCHMARK_BASELINE_FILE_BYTES,
    "Baseline",
  );
  const baseline = JSON.parse(raw) as unknown;

  assertBenchmarkBaseline(baseline, resolvedPath);

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

function countOccurrences(values: Array<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const value of values) {
    if (!value) {
      continue;
    }

    counts[value] = (counts[value] ?? 0) + 1;
  }

  return counts;
}

function scoreSummary(summary: BenchmarkSummary): number {
  const emailsPerHour = summary.emailsPerHour ?? 0;
  const latencyPenalty = (summary.latencyP95Ms ?? summary.latencyP50Ms ?? 0) / 1_000;
  const queuePenalty = (summary.queueDelayP95Ms ?? summary.queueDelayP50Ms ?? 0) / 1_000;
  const throughputBonus = (summary.completionTokensPerSecondAvg ?? 0) / 100;
  const qualityMultiplier = (summary.qualityPassRate ?? 100) / 100;
  return (
    (emailsPerHour / Math.max(1, 1 + latencyPenalty + queuePenalty) + throughputBonus) *
    qualityMultiplier
  );
}

function stripBenchmarkFields(request: BenchmarkWorkloadItem): InferenceRequest {
  return {
    ...(request.input !== undefined ? { input: request.input } : {}),
    ...(request.system !== undefined ? { system: request.system } : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.stop !== undefined ? { stop: [...request.stop] } : {}),
    ...(request.responseFormat !== undefined
      ? { responseFormat: { ...request.responseFormat } }
      : {}),
    ...(request.cache !== undefined ? { cache: request.cache } : {}),
    ...(request.dedupeKey !== undefined ? { dedupeKey: request.dedupeKey } : {}),
    ...(request.metadata !== undefined ? { metadata: { ...request.metadata } } : {}),
    ...(request.templateId !== undefined ? { templateId: request.templateId } : {}),
    ...(request.templateVariables !== undefined
      ? { templateVariables: { ...request.templateVariables } }
      : {}),
  };
}

function stringifyBenchmarkRequestBody(request: InferenceRequest): string {
  let body: string;

  try {
    body = JSON.stringify(request);
  } catch (error) {
    throw new Error(
      `Benchmark request must be JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_BENCHMARK_REQUEST_BODY_BYTES) {
    throw new Error(
      `Benchmark request body must be at most ${MAX_BENCHMARK_REQUEST_BODY_BYTES} bytes`,
    );
  }

  return body;
}

function normalizeForQuality(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsPromptEcho(request: BenchmarkWorkloadItem, output: string): boolean {
  const input = normalizeForQuality(request.input ?? "");
  const renderedVariables = Object.values(request.templateVariables ?? {})
    .map((value) => normalizeForQuality(String(value)))
    .filter((value) => value.length >= 24);
  const candidates = [input, ...renderedVariables].filter((value) => value.length >= 32);
  const normalizedOutput = normalizeForQuality(output);

  return candidates.some((candidate) => normalizedOutput.includes(candidate.slice(0, 96)));
}

function containsCallToAction(output: string): boolean {
  const normalizedOutput = normalizeForQuality(output);
  return [
    "would you",
    "are you open",
    "open to",
    "worth a",
    "can we",
    "could we",
    "happy to",
    "send over",
    "take a look",
    "review",
    "if useful",
    "if helpful",
  ].some((phrase) => normalizedOutput.includes(phrase));
}

function containsEmailWrapper(output: string): boolean {
  const normalizedOutput = normalizeForQuality(output);
  return (
    normalizedOutput.startsWith("subject:") ||
    normalizedOutput.startsWith("hi ") ||
    normalizedOutput.startsWith("hello ") ||
    normalizedOutput.includes("best regards") ||
    normalizedOutput.includes("sincerely,") ||
    normalizedOutput.includes("thanks,")
  );
}

function resolveQualityAssertions(request: BenchmarkWorkloadItem): BenchmarkQualityAssertions {
  const templateId = request.templateId ?? "";
  const promptFamily = request.metadata?.promptFamily ?? "";
  const isEmailDraft =
    templateId === "email.cold_outreach.v1" ||
    templateId === "email.follow_up.v1" ||
    promptFamily.includes("cold_outreach") ||
    promptFamily.includes("follow_up");
  const isEmailBodySection = isEmailDraft || promptFamily.includes("section_generation");

  return {
    ...(request.responseFormat?.type === "json_object" ? { requiresValidJson: true } : {}),
    ...(request.stop && request.stop.length > 0 ? { stopMustNotAppear: true } : {}),
    ...(isEmailBodySection ? { noSubjectGreetingSignoff: true } : {}),
    ...(isEmailDraft ? { requiresCallToAction: true } : {}),
    ...(request.benchmark ?? {}),
  };
}

function evaluateQuality(request: BenchmarkWorkloadItem, response: InferenceResponse): string[] {
  const assertions = resolveQualityAssertions(request);
  const failures: string[] = [];
  const output = response.output.trim();
  const normalizedOutput = normalizeForQuality(output);

  if (assertions.requiresValidJson) {
    try {
      JSON.parse(output);
    } catch {
      failures.push("invalid_json");
    }
  }

  if (assertions.minOutputChars !== undefined && output.length < assertions.minOutputChars) {
    failures.push("output_too_short");
  }

  if (assertions.maxOutputChars !== undefined && output.length > assertions.maxOutputChars) {
    failures.push("output_too_long");
  }

  for (const required of assertions.mustContain ?? []) {
    if (!normalizedOutput.includes(normalizeForQuality(required))) {
      failures.push(`missing:${required}`);
    }
  }

  for (const forbidden of assertions.mustNotContain ?? []) {
    if (normalizedOutput.includes(normalizeForQuality(forbidden))) {
      failures.push(`forbidden:${forbidden}`);
    }
  }

  if (assertions.stopMustNotAppear) {
    for (const stop of request.stop ?? []) {
      if (stop.length > 0 && output.includes(stop)) {
        failures.push(`stop_leak:${stop}`);
      }
    }
  }

  if (assertions.noPromptEcho && containsPromptEcho(request, output)) {
    failures.push("prompt_echo");
  }

  if (assertions.requiresCallToAction && !containsCallToAction(output)) {
    failures.push("missing_cta");
  }

  if (assertions.noSubjectGreetingSignoff && containsEmailWrapper(output)) {
    failures.push("email_wrapper");
  }

  return failures;
}

function scoreQualityFailures(failures: string[]): number {
  let score = 100;

  for (const failure of failures) {
    if (failure === "invalid_json") {
      score -= 45;
    } else if (failure === "prompt_echo") {
      score -= 35;
    } else if (failure.startsWith("stop_leak")) {
      score -= 30;
    } else if (failure === "email_wrapper") {
      score -= 25;
    } else if (failure === "missing_cta") {
      score -= 20;
    } else if (failure.startsWith("forbidden")) {
      score -= 20;
    } else if (failure.startsWith("missing")) {
      score -= 18;
    } else if (failure === "output_too_short" || failure === "output_too_long") {
      score -= 15;
    } else {
      score -= 10;
    }
  }

  return Math.max(0, score);
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

function is1bPreset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-1b-cx23" || preset === "single-vps-1b-8gb";
}

function is1bCx23Preset(preset: LlamaCppLaunchProfile["preset"]): boolean {
  return preset === "single-vps-1b-cx23";
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  const parsed = Number(normalized);
  return /^\d+$/.test(normalized) && Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readResponseTextWithinLimit(
  response: Response,
  limitBytes: number,
  label: string,
): Promise<string> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > limitBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} exceeded ${limitBytes} bytes`);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded ${limitBytes} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes,
  ).toString("utf8");
}

function assertInferenceResponsePayload(value: unknown): asserts value is InferenceResponse {
  assertRecord(value, "Benchmark response");

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Benchmark response.id must be a non-empty string");
  }

  if (typeof value.output !== "string") {
    throw new Error("Benchmark response.output must be a string");
  }

  assertOptionalBooleanValue(value.cached, "Benchmark response.cached");
  assertOptionalBooleanValue(value.deduplicated, "Benchmark response.deduplicated");
  assertOptionalBooleanValue(value.degraded, "Benchmark response.degraded");
  if (value.cached === undefined) {
    throw new Error("Benchmark response.cached is required");
  }
  if (value.deduplicated === undefined) {
    throw new Error("Benchmark response.deduplicated is required");
  }
  if (value.degraded === undefined) {
    throw new Error("Benchmark response.degraded is required");
  }

  assertNonNegativeNumberValue(value.queueTimeMs, "Benchmark response.queueTimeMs");
  assertNonNegativeNumberValue(value.latencyMs, "Benchmark response.latencyMs");
  assertRecord(value.usage, "Benchmark response.usage");

  if (value.usage.tokens !== undefined) {
    assertRecord(value.usage.tokens, "Benchmark response.usage.tokens");
    assertNonNegativeNumberValue(
      value.usage.tokens.prompt,
      "Benchmark response.usage.tokens.prompt",
    );
    assertNonNegativeNumberValue(
      value.usage.tokens.completion,
      "Benchmark response.usage.tokens.completion",
    );
    assertNonNegativeNumberValue(value.usage.tokens.total, "Benchmark response.usage.tokens.total");
  }
}

async function parseInferenceResponse(response: Response): Promise<InferenceResponse> {
  const body = await readResponseTextWithinLimit(
    response,
    MAX_BENCHMARK_SUCCESS_RESPONSE_BYTES,
    "Benchmark response",
  );
  let parsed: unknown;

  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(
      `Benchmark response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  assertInferenceResponsePayload(parsed);
  return parsed;
}

async function invoke(
  baseUrl: string,
  request: BenchmarkWorkloadItem,
  apiKey?: string,
): Promise<BenchmarkSample> {
  const inferenceRequest = stripBenchmarkFields(request);
  const body = stringifyBenchmarkRequestBody(inferenceRequest);
  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/infer`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(BENCHMARK_REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body,
    });
  } catch (error) {
    throw new Error(
      `Benchmark could not reach Ray at ${baseUrl}. Start the gateway and backend first. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    const body = await readResponseTextWithinLimit(
      response,
      MAX_BENCHMARK_ERROR_RESPONSE_BYTES,
      "Benchmark error response",
    );
    throw new Error(`Benchmark request failed with ${response.status}: ${body}`);
  }

  return {
    request,
    response: await parseInferenceResponse(response),
    wallTimeMs: Date.now() - startedAt,
  };
}

function createBenchmarkAccumulator(): BenchmarkAccumulator {
  return {
    requests: 0,
    responseCacheHits: 0,
    promptCacheHits: 0,
    qualityPasses: 0,
    jsonRequests: 0,
    validJsonResponses: 0,
    promptEchoRejects: 0,
    latencyValues: [],
    queueValues: [],
    ttftValues: [],
    throughputValues: [],
    promptCacheRatios: [],
    clientLatencyValues: [],
    qualityScores: [],
    providerDiagnostics: [],
  };
}

function requestRequiresValidJson(request: BenchmarkWorkloadItem): boolean {
  return (
    request.responseFormat?.type === "json_object" || request.benchmark?.requiresValidJson === true
  );
}

function recordBenchmarkSample(accumulator: BenchmarkAccumulator, sample: BenchmarkSample): void {
  const { request, response } = sample;
  const providerDiagnostics = response.diagnostics?.provider;
  const qualityFailures = evaluateQuality(request, response);

  accumulator.requests += 1;
  accumulator.clientLatencyValues.push(sample.wallTimeMs);
  accumulator.latencyValues.push(response.latencyMs);
  accumulator.queueValues.push(response.queueTimeMs);
  accumulator.qualityScores.push(scoreQualityFailures(qualityFailures));

  if (response.cached) {
    accumulator.responseCacheHits += 1;
  }
  if ((providerDiagnostics?.tokensCached ?? 0) > 0) {
    accumulator.promptCacheHits += 1;
  }
  if (qualityFailures.length === 0) {
    accumulator.qualityPasses += 1;
  }
  if (qualityFailures.includes("prompt_echo")) {
    accumulator.promptEchoRejects += 1;
  }

  if (requestRequiresValidJson(request)) {
    accumulator.jsonRequests += 1;
    try {
      JSON.parse(response.output);
      accumulator.validJsonResponses += 1;
    } catch {
      // evaluateQuality already records the invalid_json failure.
    }
  }

  if (providerDiagnostics) {
    accumulator.providerDiagnostics.push(providerDiagnostics);
  }

  const ttftMs = providerDiagnostics?.timings?.ttftMs;
  if (typeof ttftMs === "number" && ttftMs >= 0) {
    accumulator.ttftValues.push(ttftMs);
  }

  const completionTokensPerSecond = providerDiagnostics?.timings?.completionTokensPerSecond;
  if (typeof completionTokensPerSecond === "number" && completionTokensPerSecond > 0) {
    accumulator.throughputValues.push(completionTokensPerSecond);
  }

  const promptTokens = response.usage.tokens?.prompt;
  const cachedTokens = providerDiagnostics?.tokensCached;
  if (
    typeof promptTokens === "number" &&
    promptTokens > 0 &&
    typeof cachedTokens === "number" &&
    cachedTokens > 0
  ) {
    accumulator.promptCacheRatios.push(cachedTokens / promptTokens);
  }
}

function summarizeBenchmarkProviderDiagnostics(
  providerDiagnostics: BenchmarkProviderDiagnostics[],
): BenchmarkProviderDiagnosticsSummary | undefined {
  if (providerDiagnostics.length === 0) {
    return undefined;
  }

  const cachedTokenValues = providerDiagnostics
    .map((diagnostics) => diagnostics.tokensCached)
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const contextWindowValues = providerDiagnostics
    .map((diagnostics) => diagnostics.contextWindow)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const routedSlotSamples = providerDiagnostics.filter(
    (diagnostics) =>
      typeof diagnostics.slotId === "number" && typeof diagnostics.preferredSlot === "number",
  );
  const reusedSlotSamples = routedSlotSamples.filter(
    (diagnostics) => diagnostics.slotId === diagnostics.preferredSlot,
  );
  const totalSlots = [...providerDiagnostics]
    .reverse()
    .find((diagnostics) => typeof diagnostics.totalSlots === "number")?.totalSlots;
  const jsonRepairAttempts = providerDiagnostics.filter(
    (diagnostics) => diagnostics.jsonRepairAttempted === true,
  ).length;
  const jsonRepairSuccesses = providerDiagnostics.filter(
    (diagnostics) => diagnostics.jsonRepairSucceeded === true,
  ).length;

  return {
    requestShapes: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.requestShape),
    ),
    promptFormats: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.promptFormat),
    ),
    promptFormatReasons: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.promptFormatReason),
    ),
    slotRouteReasons: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.slotRouteReason),
    ),
    modelRefs: countOccurrences(providerDiagnostics.map((diagnostics) => diagnostics.modelRef)),
    backendModels: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.backendModel),
    ),
    launchPresets: countOccurrences(
      providerDiagnostics.map((diagnostics) => diagnostics.launchPreset),
    ),
    ...(jsonRepairAttempts > 0 ? { jsonRepairAttempts, jsonRepairSuccesses } : {}),
    ...(typeof totalSlots === "number" ? { totalSlots } : {}),
    contextWindowP50: quantile(contextWindowValues, 0.5),
    slotReuseRate:
      routedSlotSamples.length > 0
        ? (reusedSlotSamples.length / routedSlotSamples.length) * 100
        : undefined,
    cachedTokensAvg: mean(cachedTokenValues),
  };
}

export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkSummary> {
  assertRunBenchmarkOptions(options);

  const baseUrl = normalizeBaseUrlFlag(options.baseUrl);
  const workload = validateWorkload(options.workload, "Benchmark workload");

  const queue = Array.from(
    { length: options.requests },
    (_, index) => workload[index % workload.length],
  );
  const accumulator = createBenchmarkAccumulator();
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

      const sample = await invoke(baseUrl, request, options.apiKey);
      recordBenchmarkSample(accumulator, sample);
    }
  });

  await Promise.all(workers);

  const wallTimeMs = Date.now() - startedAt;
  const providerDiagnosticsSummary = summarizeBenchmarkProviderDiagnostics(
    accumulator.providerDiagnostics,
  );

  const summary: BenchmarkSummary = {
    label: options.label,
    baseUrl,
    concurrency: options.concurrency,
    requests: accumulator.requests,
    responseCacheHitRate:
      accumulator.requests > 0
        ? (accumulator.responseCacheHits / accumulator.requests) * 100
        : undefined,
    promptCacheHitRate:
      accumulator.requests > 0
        ? (accumulator.promptCacheHits / accumulator.requests) * 100
        : undefined,
    promptCacheReuseRatio: mean(accumulator.promptCacheRatios),
    latencyP50Ms: quantile(accumulator.latencyValues, 0.5),
    latencyP95Ms: quantile(accumulator.latencyValues, 0.95),
    queueDelayP50Ms: quantile(accumulator.queueValues, 0.5),
    queueDelayP95Ms: quantile(accumulator.queueValues, 0.95),
    ttftP50Ms: quantile(accumulator.ttftValues, 0.5),
    ttftP95Ms: quantile(accumulator.ttftValues, 0.95),
    completionTokensPerSecondAvg: mean(accumulator.throughputValues),
    emailsPerHour: wallTimeMs > 0 ? (accumulator.requests / wallTimeMs) * 3_600_000 : undefined,
    wallTimeMs,
    clientLatencyP50Ms: quantile(accumulator.clientLatencyValues, 0.5),
    qualityPassRate:
      accumulator.requests > 0
        ? (accumulator.qualityPasses / accumulator.requests) * 100
        : undefined,
    qualityScoreAvg: mean(accumulator.qualityScores),
    qualityScoreP50: quantile(accumulator.qualityScores, 0.5),
    validJsonRate:
      accumulator.jsonRequests > 0
        ? (accumulator.validJsonResponses / accumulator.jsonRequests) * 100
        : undefined,
    promptEchoRejects: accumulator.promptEchoRejects,
    qualityFailures: accumulator.requests - accumulator.qualityPasses,
    ...(providerDiagnosticsSummary ? { providerDiagnostics: providerDiagnosticsSummary } : {}),
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
  console.log(
    `Quality: pass=${formatNumber(summary.qualityPassRate)}% validJson=${formatNumber(
      summary.validJsonRate,
    )}% score=${formatNumber(summary.qualityScoreAvg)} p50=${formatNumber(
      summary.qualityScoreP50,
    )} failures=${summary.qualityFailures ?? 0} promptEcho=${summary.promptEchoRejects ?? 0}`,
  );
  if (summary.providerDiagnostics) {
    console.log(
      `Provider: promptFormats=${JSON.stringify(
        summary.providerDiagnostics.promptFormats,
      )} requestShapes=${JSON.stringify(summary.providerDiagnostics.requestShapes)}`,
    );
    console.log(
      `Provider: slotReuse=${formatNumber(
        summary.providerDiagnostics.slotReuseRate,
      )}% cachedTokensAvg=${formatNumber(
        summary.providerDiagnostics.cachedTokensAvg,
      )} ctxP50=${formatNumber(summary.providerDiagnostics.contextWindowP50)} totalSlots=${
        summary.providerDiagnostics.totalSlots ?? "n/a"
      } jsonRepair=${summary.providerDiagnostics.jsonRepairSuccesses ?? 0}/${
        summary.providerDiagnostics.jsonRepairAttempts ?? 0
      }`,
    );
  }
  console.log(`Emails/hour: ${formatNumber(summary.emailsPerHour)}`);
  console.log(`Score: ${formatNumber(summary.score, 2)}`);
}

function assertAutotuneCandidateLimit(maxCandidates: number): void {
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates <= 0 ||
    maxCandidates > MAX_AUTOTUNE_SCHEDULER_CANDIDATES
  ) {
    throw new Error(
      `Autotune scheduler candidate limit must be a positive integer less than or equal to ${MAX_AUTOTUNE_SCHEDULER_CANDIDATES}`,
    );
  }
}

function scoreAutotuneCandidateDistance(config: RayConfig, candidate: AutotuneCandidate): number {
  const base = config.scheduler;
  const scheduler = candidate.override.scheduler;
  if (
    !scheduler ||
    scheduler.concurrency === undefined ||
    scheduler.batchWindowMs === undefined ||
    scheduler.affinityLookahead === undefined ||
    scheduler.maxInflightTokens === undefined ||
    scheduler.shortJobMaxTokens === undefined
  ) {
    return Number.POSITIVE_INFINITY;
  }

  return (
    Math.abs(scheduler.concurrency - base.concurrency) * 1_000 +
    Math.abs(scheduler.batchWindowMs - base.batchWindowMs) * 4 +
    Math.abs(scheduler.affinityLookahead - base.affinityLookahead) * 2 +
    Math.abs(scheduler.maxInflightTokens - base.maxInflightTokens) / 16 +
    Math.abs(scheduler.shortJobMaxTokens - base.shortJobMaxTokens) * 2
  );
}

export function buildAutotuneCandidates(
  config: RayConfig,
  maxCandidates = DEFAULT_AUTOTUNE_SCHEDULER_CANDIDATES,
): AutotuneCandidate[] {
  assertAutotuneCandidateLimit(maxCandidates);

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

  return candidates
    .sort(
      (left, right) =>
        scoreAutotuneCandidateDistance(config, left) -
          scoreAutotuneCandidateDistance(config, right) || left.label.localeCompare(right.label),
    )
    .slice(0, maxCandidates);
}

function buildLaunchProfileRecommendations(
  launchProfile: LlamaCppLaunchProfile,
): LaunchProfileCandidate[] {
  const ctxSizes =
    isCax11Preset(launchProfile.preset) || is1bCx23Preset(launchProfile.preset)
      ? uniqueIntegers([1536, 2048, launchProfile.ctxSize, 2560])
      : is1bPreset(launchProfile.preset)
        ? uniqueIntegers([2048, 3072, launchProfile.ctxSize, 4096])
        : uniqueIntegers([2048, 3072, launchProfile.ctxSize, 4096]);
  const parallels =
    isCax11Preset(launchProfile.preset) || is1bCx23Preset(launchProfile.preset)
      ? uniqueIntegers([1, launchProfile.parallel])
      : uniqueIntegers([1, launchProfile.parallel, 2]);
  const batchSizes =
    isCax11Preset(launchProfile.preset) || is1bCx23Preset(launchProfile.preset)
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

function appendBoundedOutput(
  current: Buffer,
  chunk: unknown,
): { buffer: Buffer; truncated: boolean } {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const totalLength = current.length + incoming.length;
  const combined = Buffer.concat([current, incoming], totalLength);

  if (combined.length <= MAX_BENCHMARK_CHILD_OUTPUT_BYTES) {
    return {
      buffer: combined,
      truncated: false,
    };
  }

  return {
    buffer: combined.subarray(combined.length - MAX_BENCHMARK_CHILD_OUTPUT_BYTES),
    truncated: true,
  };
}

function attachBenchmarkChildOutputCapture(child: ChildProcess): BenchmarkChildOutputCapture {
  const existing = benchmarkChildOutputCaptures.get(child);
  if (existing) {
    return existing;
  }

  const capture: BenchmarkChildOutputCapture = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  benchmarkChildOutputCaptures.set(child, capture);

  child.stdout?.on("data", (chunk: unknown) => {
    const next = appendBoundedOutput(capture.stdout, chunk);
    capture.stdout = next.buffer;
    capture.stdoutTruncated = capture.stdoutTruncated || next.truncated;
  });
  child.stderr?.on("data", (chunk: unknown) => {
    const next = appendBoundedOutput(capture.stderr, chunk);
    capture.stderr = next.buffer;
    capture.stderrTruncated = capture.stderrTruncated || next.truncated;
  });

  return capture;
}

function formatCapturedChildOutput(child: ChildProcess): string {
  const capture = benchmarkChildOutputCaptures.get(child);
  if (!capture) {
    return "";
  }

  const parts: string[] = [];
  const stderr = capture.stderr.toString("utf8").trim();
  const stdout = capture.stdout.toString("utf8").trim();

  if (stderr.length > 0) {
    parts.push(`stderr${capture.stderrTruncated ? " (truncated)" : ""}:\n${stderr}`);
  }
  if (stdout.length > 0) {
    parts.push(`stdout${capture.stdoutTruncated ? " (truncated)" : ""}:\n${stdout}`);
  }

  return parts.join("\n");
}

function formatChildExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  return `code=${code ?? "null"} signal=${signal ?? "null"}`;
}

function buildBenchmarkChildExitError(
  child: ChildProcess,
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const output = formatCapturedChildOutput(child);
  return new Error(
    `${label} exited before becoming healthy (${formatChildExitStatus(code, signal)})${
      output ? `\n${output}` : ""
    }`,
  );
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 15_000,
  healthPath = "/health",
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${healthPath}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(BENCHMARK_HEALTH_REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)),
        ),
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Ignore until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for health at ${baseUrl}${healthPath}`);
}

export async function waitForBenchmarkChildHealth(
  child: ChildProcess,
  label: string,
  baseUrl: string,
  timeoutMs = 15_000,
  healthPath = "/health",
): Promise<void> {
  attachBenchmarkChildOutputCapture(child);

  if (child.exitCode !== null || child.signalCode !== null) {
    throw buildBenchmarkChildExitError(child, label, child.exitCode, child.signalCode);
  }

  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const exitPromise = new Promise<never>((_resolve, reject) => {
    onExit = (code, signal) => {
      reject(buildBenchmarkChildExitError(child, label, code, signal));
    };
    child.once("exit", onExit);
  });

  try {
    await Promise.race([waitForHealth(baseUrl, timeoutMs, healthPath), exitPromise]);
  } finally {
    if (onExit) {
      child.off("exit", onExit);
    }
  }
}

async function spawnBenchmarkChild(
  label: string,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  return await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    attachBenchmarkChildOutputCapture(child);

    const onError = (error: Error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    };

    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      resolve(child);
    });
  });
}

async function startGateway(configPath: string): Promise<ChildProcess> {
  return await spawnBenchmarkChild(
    "Ray gateway",
    BUN_RUNTIME_BINARY,
    ["--conditions=development", "./apps/gateway/src/index.ts", "--config", configPath],
    {
      cwd: process.cwd(),
    },
  );
}

async function startLlamaCppServer(launchProfile: LlamaCppLaunchProfile): Promise<ChildProcess> {
  await assertBenchmarkLlamaCppLaunchFiles(launchProfile);

  return await spawnBenchmarkChild(
    "llama.cpp server",
    launchProfile.binaryPath,
    buildBenchmarkLlamaCppServerArgs(launchProfile),
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...buildLlamaCppEnvironment(launchProfile),
      },
    },
  );
}

async function assertBenchmarkPathAccess(
  filePath: string,
  label: string,
  mode: number,
  expectation: string,
): Promise<void> {
  await access(filePath, mode).catch((error: unknown) => {
    throw new Error(
      `${label} must be ${expectation} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export async function assertBenchmarkLlamaCppLaunchFiles(
  launchProfile: LlamaCppLaunchProfile,
): Promise<void> {
  await assertBenchmarkPathAccess(
    launchProfile.binaryPath,
    "llama.cpp binary",
    constants.X_OK,
    "executable",
  );
  await assertBenchmarkPathAccess(
    launchProfile.modelPath,
    "llama.cpp GGUF model",
    constants.R_OK,
    "readable",
  );
}

export function buildBenchmarkLlamaCppServerArgs(launchProfile: LlamaCppLaunchProfile): string[] {
  return [...buildLlamaCppLaunchArgs(launchProfile), ...(launchProfile.extraArgs ?? [])];
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
  workload: BenchmarkWorkloadItem[];
  concurrency: number;
  requests: number;
  label: string;
  apiKey?: string;
}): Promise<BenchmarkSummary> {
  await writeFile(options.configPath, JSON.stringify(options.config, null, 2));
  const gateway = await startGateway(options.configPath);

  try {
    const baseUrl = buildBaseUrl(options.config.server.host, options.config.server.port);
    await waitForBenchmarkChildHealth(gateway, "Ray gateway", baseUrl, 15_000, "/livez");
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
  workload: BenchmarkWorkloadItem[];
  clientConcurrency: number;
  requests: number;
  tempDir: string;
  maxCandidates: number;
  apiKey?: string;
}): Promise<SchedulerBenchmarkResult[]> {
  const candidates = buildAutotuneCandidates(options.config, options.maxCandidates);
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
  workload: BenchmarkWorkloadItem[];
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
      await waitForBenchmarkChildHealth(
        backend,
        "llama.cpp server",
        buildBaseUrl(launchedProfile.host, launchedProfile.port),
        60_000,
      );
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

  if (baseline.assertions.minQualityPassRate !== undefined) {
    addBaselineCheck(
      checks,
      "qualityPassRate",
      ">=",
      baseline.assertions.minQualityPassRate,
      summary.qualityPassRate,
    );
  }

  if (baseline.assertions.minQualityScoreAvg !== undefined) {
    addBaselineCheck(
      checks,
      "qualityScoreAvg",
      ">=",
      baseline.assertions.minQualityScoreAvg,
      summary.qualityScoreAvg,
    );
  }

  if (baseline.assertions.minValidJsonRate !== undefined) {
    addBaselineCheck(
      checks,
      "validJsonRate",
      ">=",
      baseline.assertions.minValidJsonRate,
      summary.validJsonRate,
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

export async function writeStructuredOutput(
  outputPath: string,
  payload: BenchmarkSummaryOutput | AutotuneOutput | PromptFormatSweepOutput,
): Promise<void> {
  assertBenchmarkPathValue(outputPath, "Benchmark output path");
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  const outputBytes = Buffer.byteLength(output, "utf8");

  if (outputBytes > MAX_BENCHMARK_OUTPUT_FILE_BYTES) {
    throw new Error(
      `Benchmark structured output must be at most ${MAX_BENCHMARK_OUTPUT_FILE_BYTES} bytes`,
    );
  }

  const outputDirectory = path.dirname(resolvedPath);
  const tempPath = path.join(
    outputDirectory,
    `.tmp-${path.basename(resolvedPath)}-${process.pid}-${randomUUID()}`,
  );

  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(tempPath, output, { flag: "wx" });
    await rename(tempPath, resolvedPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  console.log(`Wrote structured output to ${resolvedPath}`);
}

async function readFileTail(filePath: string, retainBytes: number): Promise<string> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    fileHandle = await open(filePath, "r");
    const stats = await fileHandle.stat();
    const start = Math.max(0, stats.size - retainBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);

    if (length > 0) {
      await fileHandle.read(buffer, 0, length, start);
    }

    return buffer.toString("utf8");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function trimPartialJsonlHead(contents: string): string {
  const firstNewline = contents.indexOf("\n");
  return firstNewline === -1 ? "" : contents.slice(firstNewline + 1);
}

async function pruneHistoryFile(historyPath: string, incomingBytes: number): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;

  try {
    stats = await stat(historyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  if (!stats.isFile() || stats.size + incomingBytes <= MAX_BENCHMARK_HISTORY_FILE_BYTES) {
    return;
  }

  const retainBytes = Math.max(
    0,
    Math.min(BENCHMARK_HISTORY_RETAIN_BYTES, MAX_BENCHMARK_HISTORY_FILE_BYTES - incomingBytes),
  );
  const tail = retainBytes > 0 ? await readFileTail(historyPath, retainBytes) : "";
  const retained = stats.size > retainBytes ? trimPartialJsonlHead(tail) : tail;

  await writeFile(historyPath, retained);
}

export async function appendHistoryOutput(
  historyDir: string | undefined,
  payload: BenchmarkSummaryOutput | AutotuneOutput | PromptFormatSweepOutput,
): Promise<void> {
  if (!historyDir) {
    return;
  }

  assertBenchmarkPathValue(historyDir, "Benchmark history directory");
  const resolvedDir = path.resolve(process.cwd(), historyDir);
  const historyPath = path.join(resolvedDir, `${payload.kind}.jsonl`);
  const line = `${JSON.stringify(payload)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");

  if (lineBytes > MAX_BENCHMARK_HISTORY_FILE_BYTES) {
    throw new Error(
      `Benchmark history record must be at most ${MAX_BENCHMARK_HISTORY_FILE_BYTES} bytes`,
    );
  }

  await mkdir(resolvedDir, { recursive: true });
  await pruneHistoryFile(historyPath, lineBytes);
  await writeFile(historyPath, line, {
    flag: "a",
  });
  console.log(`Appended benchmark history to ${historyPath}`);
}

function withPromptFormatOverride(
  workload: BenchmarkWorkloadItem[],
  promptFormat: string,
): BenchmarkWorkloadItem[] {
  return workload.map((request) => ({
    ...request,
    metadata: {
      ...(request.metadata ?? {}),
      rayPromptFormat: promptFormat,
    },
  }));
}

async function runPromptFormatSweep(
  args: BenchmarkArgs,
  workload: BenchmarkWorkloadItem[],
): Promise<PromptFormatSweepOutput> {
  const promptFormats = ["llama.cpp-template", "prompt-scaffold", "ray-chat-fallback"];
  const requests = args.requests ?? workload.length;
  const directConfig = args.configPath
    ? (
        await loadRayConfig({
          cwd: process.cwd(),
          configPath: args.configPath,
        })
      ).config
    : undefined;
  const results: PromptFormatSweepOutput["results"] = [];

  for (const promptFormat of promptFormats) {
    const summary = await runBenchmark({
      baseUrl: args.baseUrl,
      workload: withPromptFormatOverride(workload, promptFormat),
      concurrency: args.concurrency,
      requests,
      label: `${args.label ?? args.workloadPath ?? "default-workload"}:${promptFormat}`,
      apiKey: resolveBenchmarkApiKey(args, directConfig),
    });
    printSummary(summary);
    console.log("");
    results.push({
      promptFormat,
      summary,
    });
  }

  const winner = [...results].sort(
    (left, right) =>
      (right.summary.qualityScoreAvg ?? 0) - (left.summary.qualityScoreAvg ?? 0) ||
      (right.summary.score ?? 0) - (left.summary.score ?? 0),
  )[0];

  if (!winner) {
    throw new Error("Prompt format sweep produced no results.");
  }

  console.log(`Recommended prompt format: ${winner.promptFormat}`);

  return {
    kind: "prompt-format-sweep",
    version: STRUCTURED_OUTPUT_VERSION,
    generatedAt: new Date().toISOString(),
    args: {
      baseUrl: args.baseUrl,
      ...(args.workloadPath ? { workloadPath: args.workloadPath } : {}),
      concurrency: args.concurrency,
      requests,
      label: args.label ?? args.workloadPath ?? "default-workload",
    },
    results,
    recommendedPromptFormat: winner.promptFormat,
  };
}

async function runAutotune(
  args: BenchmarkArgs,
  workload: BenchmarkWorkloadItem[],
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

      await waitForBenchmarkChildHealth(
        pinnedBackend,
        "llama.cpp server",
        buildBaseUrl(launchedProfile.host, launchedProfile.port),
        60_000,
      );
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
      maxCandidates: args.autotuneMaxCandidates,
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
        schedulerCandidateLimit: args.autotuneMaxCandidates,
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
    await appendHistoryOutput(args.historyDir, report);
    return;
  }

  if (args.promptFormatSweep) {
    const report = await runPromptFormatSweep(args, workload);
    if (args.outputPath) {
      await writeStructuredOutput(args.outputPath, report);
    }
    await appendHistoryOutput(args.historyDir, report);
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

  const outputPayload: BenchmarkSummaryOutput = {
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
  };

  if (args.outputPath) {
    await writeStructuredOutput(args.outputPath, outputPayload);
  }
  await appendHistoryOutput(args.historyDir, outputPayload);

  if (args.assertBaseline && comparison && !comparison.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
