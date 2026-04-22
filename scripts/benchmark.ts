import { readFile } from "node:fs/promises";
import path from "node:path";

interface BenchmarkArgs {
  baseUrl: string;
  workloadPath?: string;
  concurrency: number;
  requests?: number;
  label?: string;
}

interface InferenceRequest {
  input: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  responseFormat?: {
    type: "text" | "json_object";
  };
  metadata?: Record<string, string>;
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

const defaultWorkload: InferenceRequest[] = [
  {
    system:
      "You are an email writing assistant. Write only the email body. Keep it concise, specific, and practical.",
    input:
      "Draft a short cold outreach email to a VP Engineering about faster CI runs for a 40-person product team.",
    maxTokens: 140,
    metadata: {
      promptFamily: "email.cold_outreach",
      taskTemplate: "cold_outreach_v1",
    },
  },
  {
    system:
      "You are an email writing assistant. Write only the email body. Keep it concise, specific, and practical.",
    input:
      "Draft a short cold outreach email to a Head of Sales Operations about reducing CRM admin work with AI enrichment.",
    maxTokens: 140,
    metadata: {
      promptFamily: "email.cold_outreach",
      taskTemplate: "cold_outreach_v1",
    },
  },
  {
    system:
      "You classify inbound email replies. Return only compact JSON with keys sentiment, intent, and urgency.",
    input:
      'Classify this reply: "This is interesting, but we already have a vendor. Check back next quarter."',
    maxTokens: 80,
    responseFormat: {
      type: "json_object",
    },
    metadata: {
      promptFamily: "email.reply_classification",
      taskTemplate: "reply_classifier_v1",
    },
  },
  {
    system:
      "You rewrite email replies. Write only the email body in plain text. Keep it warm and direct.",
    input:
      'Rewrite this reply to sound more confident while staying polite: "Happy to take a look sometime next week if you want to send a few options."',
    maxTokens: 120,
    metadata: {
      promptFamily: "email.reply_rewrite",
      taskTemplate: "reply_rewrite_v1",
    },
  },
];

function parseArgs(argv: string[]): BenchmarkArgs {
  const result: BenchmarkArgs = {
    baseUrl: "http://127.0.0.1:3000",
    concurrency: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

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
    }
  }

  return result;
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

async function invoke(baseUrl: string, request: InferenceRequest): Promise<BenchmarkSample> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/infer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workload = await loadWorkload(args.workloadPath);
  const requestCount = args.requests ?? workload.length;
  const queue = Array.from(
    { length: requestCount },
    (_, index) => workload[index % workload.length],
  );
  const results: BenchmarkSample[] = [];
  const startedAt = Date.now();
  let cursor = 0;

  const workers = Array.from({ length: args.concurrency }, async () => {
    while (cursor < queue.length) {
      const nextIndex = cursor;
      cursor += 1;
      const request = queue[nextIndex];
      if (!request) {
        break;
      }

      const sample = await invoke(args.baseUrl, request);
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

  const summary = {
    label: args.label ?? args.workloadPath ?? "default-workload",
    baseUrl: args.baseUrl,
    concurrency: args.concurrency,
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
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
