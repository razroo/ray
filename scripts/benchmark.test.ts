import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig } from "@ray/config";
import {
  appendHistoryOutput,
  assertBenchmarkLlamaCppLaunchFiles,
  buildAutotuneCandidates,
  buildBenchmarkLlamaCppServerArgs,
  loadBaseline,
  loadWorkload,
  parseArgs,
  resolveBenchmarkApiKey,
  runBenchmark,
  waitForBenchmarkChildHealth,
  writeStructuredOutput,
} from "./benchmark.ts";

async function withTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    await run(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function minimalBenchmarkOutput(label: string) {
  return {
    kind: "benchmark-summary",
    version: 1,
    generatedAt: new Date(0).toISOString(),
    args: {
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      label,
    },
    summary: {
      label,
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      wallTimeMs: 1,
    },
  } as const;
}

test("parseArgs accepts strict benchmark CLI options", () => {
  const args = parseArgs([
    "--base-url",
    "http://127.0.0.1:3000/",
    "--workload",
    "examples/workloads/email-workload.jsonl",
    "--concurrency",
    "2",
    "--requests",
    "16",
    "--label",
    "cx23-smoke",
    "--api-key",
    "test-key",
    "--config",
    "examples/config/ray.sub1b.json",
    "--output",
    ".ray/benchmarks/latest.json",
    "--history-dir",
    ".ray/benchmarks/history",
    "--baseline",
    "examples/benchmarks/baselines/hetzner-cx23-sub1b.json",
    "--prompt-format-sweep",
    "--autotune",
    "--autotune-scope",
    "gateway",
    "--autotune-max-candidates",
    "12",
    "--assert-baseline",
  ]);

  assert.equal(args.baseUrl, "http://127.0.0.1:3000");
  assert.equal(args.workloadPath, "examples/workloads/email-workload.jsonl");
  assert.equal(args.concurrency, 2);
  assert.equal(args.requests, 16);
  assert.equal(args.label, "cx23-smoke");
  assert.equal(args.apiKey, "test-key");
  assert.equal(args.configPath, "examples/config/ray.sub1b.json");
  assert.equal(args.outputPath, ".ray/benchmarks/latest.json");
  assert.equal(args.historyDir, ".ray/benchmarks/history");
  assert.equal(args.baselinePath, "examples/benchmarks/baselines/hetzner-cx23-sub1b.json");
  assert.equal(args.promptFormatSweep, true);
  assert.equal(args.autotune, true);
  assert.equal(args.autotuneScope, "gateway");
  assert.equal(args.autotuneMaxCandidates, 12);
  assert.equal(args.assertBaseline, true);
});

test("parseArgs rejects malformed direct argv values", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--concurrency", 2] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(
    () => parseArgs(Array.from({ length: 129 }, () => "--help")),
    /argv must contain at most 128 entries/,
  );
  assert.throws(
    () => parseArgs(["--workload", `ray${"\0"}.jsonl`]),
    /argv\[1\] must not contain NUL bytes/,
  );
  assert.throws(
    () => parseArgs(["--workload", " examples/workload.jsonl"]),
    /--workload must be a path without surrounding whitespace/,
  );
  assert.throws(
    () => parseArgs(["--output", ".ray/benchmarks/latest.json\n"]),
    /--output must not contain control characters/,
  );
  assert.throws(
    () => parseArgs(["--label", "x".repeat(4_097)]),
    /argv\[1\] must be at most 4096 bytes/,
  );
  assert.throws(
    () => parseArgs(["--api-key", "not a bearer token"]),
    /--api-key must be a bearer-token-safe string without whitespace/,
  );
  assert.throws(
    () => parseArgs(["--api-key", `bad${String.fromCharCode(0x1f)}key`]),
    /--api-key must be a bearer-token-safe string without whitespace or control characters/,
  );
});

test("resolveBenchmarkApiKey bounds API key environment values", () => {
  const args = parseArgs([]);
  const config = createDefaultConfig("tiny");
  config.auth.enabled = true;
  config.auth.apiKeyEnv = "RAY_API_KEYS";

  const previousBenchmarkKey = process.env.RAY_BENCHMARK_API_KEY;
  const previousConfigKeys = process.env.RAY_API_KEYS;

  try {
    process.env.RAY_BENCHMARK_API_KEY = "direct-benchmark-key";
    assert.equal(resolveBenchmarkApiKey(args, config), "direct-benchmark-key");

    process.env.RAY_BENCHMARK_API_KEY = "x".repeat(4_097);
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_BENCHMARK_API_KEY must be at most 4096 characters/,
    );

    process.env.RAY_BENCHMARK_API_KEY = "bad key";
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_BENCHMARK_API_KEY must be a bearer-token-safe string without whitespace/,
    );

    process.env.RAY_BENCHMARK_API_KEY = `bad${String.fromCharCode(0x1f)}key`;
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_BENCHMARK_API_KEY must be a bearer-token-safe string without whitespace or control characters/,
    );

    delete process.env.RAY_BENCHMARK_API_KEY;
    process.env.RAY_API_KEYS = "\n, first-key ,second-key";
    assert.equal(resolveBenchmarkApiKey(args, config), "first-key");

    process.env.RAY_API_KEYS = "x".repeat(65_537);
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_API_KEYS must be at most 65536 characters/,
    );

    process.env.RAY_API_KEYS = "\n, bad key";
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_API_KEYS entries must be a bearer-token-safe string without whitespace/,
    );

    process.env.RAY_API_KEYS = `bad${String.fromCharCode(0x1f)}key`;
    assert.throws(
      () => resolveBenchmarkApiKey(args, config),
      /RAY_API_KEYS entries must be a bearer-token-safe string without whitespace or control characters/,
    );
  } finally {
    if (previousBenchmarkKey === undefined) {
      delete process.env.RAY_BENCHMARK_API_KEY;
    } else {
      process.env.RAY_BENCHMARK_API_KEY = previousBenchmarkKey;
    }

    if (previousConfigKeys === undefined) {
      delete process.env.RAY_API_KEYS;
    } else {
      process.env.RAY_API_KEYS = previousConfigKeys;
    }
  }
});

test("parseArgs rejects ambiguous benchmark flags", () => {
  assert.throws(() => parseArgs(["--workload"]), /--workload requires a value/);
  assert.throws(
    () => parseArgs(["--workload", "--concurrency", "2"]),
    /--workload requires a value/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["workload.jsonl"]), /Unexpected positional argument/);
  assert.throws(
    () => parseArgs(["--autotune-scope", "everything"]),
    /--autotune-scope must be auto, gateway, or full/,
  );
});

test("parseArgs rejects unsafe benchmark limits and URLs", () => {
  assert.throws(
    () => parseArgs(["--base-url", "ray.example.com"]),
    /--base-url must be an absolute HTTP URL/,
  );
  assert.throws(
    () => parseArgs(["--base-url", " http://ray.example.com"]),
    /--base-url must not contain unencoded whitespace or control characters/,
  );
  assert.throws(
    () => parseArgs(["--base-url", "http://exa\tmple.com"]),
    /--base-url must not contain unencoded whitespace or control characters/,
  );
  assert.throws(
    () => parseArgs(["--base-url", "ftp://ray.example.com"]),
    /--base-url must use http or https/,
  );
  assert.throws(
    () => parseArgs(["--base-url", "http://user:pass@ray.example.com"]),
    /--base-url must not include credentials/,
  );
  assert.throws(
    () => parseArgs(["--base-url", "http://ray.example.com/?debug=true"]),
    /--base-url must not include a query string or fragment/,
  );
  assert.throws(
    () => parseArgs(["--concurrency", "2.5"]),
    /--concurrency must be a positive integer/,
  );
  assert.throws(
    () => parseArgs(["--concurrency", "65"]),
    /--concurrency must be less than or equal to 64/,
  );
  assert.throws(
    () => parseArgs(["--requests", "10001"]),
    /--requests must be less than or equal to 10000/,
  );
  assert.throws(
    () => parseArgs(["--autotune-max-candidates", "257"]),
    /--autotune-max-candidates must be less than or equal to 256/,
  );
});

test("buildAutotuneCandidates caps scheduler sweeps near the active config", () => {
  const config = createDefaultConfig("sub1b");
  const candidates = buildAutotuneCandidates(config, 12);
  const baseline = candidates[0]?.override.scheduler;

  assert.equal(candidates.length, 12);
  assert.equal(new Set(candidates.map((candidate) => candidate.label)).size, candidates.length);
  assert.equal(baseline?.concurrency, config.scheduler.concurrency);
  assert.equal(baseline?.batchWindowMs, config.scheduler.batchWindowMs);
  assert.equal(baseline?.affinityLookahead, config.scheduler.affinityLookahead);
  assert.equal(baseline?.maxInflightTokens, config.scheduler.maxInflightTokens);
  assert.equal(baseline?.shortJobMaxTokens, config.scheduler.shortJobMaxTokens);
  assert.throws(
    () => buildAutotuneCandidates(config, 257),
    /Autotune scheduler candidate limit must be a positive integer/,
  );
});

test("buildBenchmarkLlamaCppServerArgs mirrors generated launch profiles", () => {
  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }

  config.model.adapter.launchProfile.extraArgs = ["--no-mmap"];
  const args = buildBenchmarkLlamaCppServerArgs(config.model.adapter.launchProfile);

  assert.deepEqual(args.slice(0, 6), [
    "--model",
    config.model.adapter.launchProfile.modelPath,
    "--alias",
    config.model.adapter.launchProfile.alias,
    "--host",
    config.model.adapter.launchProfile.host,
  ]);
  assert.match(args.join(" "), /--threads-batch 2/);
  assert.match(args.join(" "), /--batch-size 192 --ubatch-size 96/);
  assert.match(args.join(" "), /--cache-prompt --cache-reuse 192 --cache-ram 384/);
  assert.match(args.join(" "), /--cont-batching --metrics --slots --warmup/);
  assert.equal(args.at(-1), "--no-mmap");
});

test("assertBenchmarkLlamaCppLaunchFiles rejects inaccessible backend files", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-launch-files-"));
  t.after(async () => {
    await chmod(path.join(tempDir, "model.gguf"), 0o644).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  const binaryPath = path.join(tempDir, "llama-server");
  const modelPath = path.join(tempDir, "model.gguf");
  await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  await writeFile(modelPath, "GGUF", { mode: 0o644 });

  const config = createDefaultConfig("1b");
  if (config.model.adapter.kind !== "llama.cpp" || !config.model.adapter.launchProfile) {
    throw new Error("Expected llama.cpp launch profile");
  }
  const launchProfile = {
    ...config.model.adapter.launchProfile,
    binaryPath,
    modelPath,
  };

  await assert.rejects(
    () => assertBenchmarkLlamaCppLaunchFiles(launchProfile),
    /llama\.cpp binary must be executable/,
  );

  await chmod(binaryPath, 0o755);
  await chmod(modelPath, 0o000);

  await assert.rejects(
    () => assertBenchmarkLlamaCppLaunchFiles(launchProfile),
    /llama\.cpp GGUF model must be readable/,
  );
});

test("loadWorkload rejects oversized benchmark workload files before parsing", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-workload-limit-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const workloadPath = path.join(tempDir, "huge-workload.jsonl");
  await writeFile(workloadPath, "x".repeat(1_048_577), "utf8");

  await assert.rejects(
    () => loadWorkload(workloadPath),
    /Workload file must be at most 1048576 bytes/,
  );
});

test("loadWorkload rejects excessive benchmark workload entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-workload-count-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const workloadPath = path.join(tempDir, "many-workloads.jsonl");
  await writeFile(
    workloadPath,
    Array.from({ length: 1_025 }, () => JSON.stringify({ input: "ping" })).join("\n"),
    "utf8",
  );

  await assert.rejects(
    () => loadWorkload(workloadPath),
    /Workload file must contain at most 1024 entries/,
  );
});

test("loadWorkload rejects malformed benchmark workload entries", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-workload-shape-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const workloadPath = path.join(tempDir, "malformed-workload.jsonl");

  await writeFile(workloadPath, "null\n", "utf8");
  await assert.rejects(() => loadWorkload(workloadPath), /Workload entry 1 must be an object/);

  await writeFile(
    workloadPath,
    JSON.stringify({
      templateId: "email.cold_outreach.v1",
      benchmark: {
        mustContain: [42],
      },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkload(workloadPath),
    /Workload entry 1\.benchmark\.mustContain\[0\] must be a string/,
  );

  await writeFile(
    workloadPath,
    JSON.stringify({
      input: "ping",
      metadata: {
        useCase: 42,
      },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkload(workloadPath),
    /Workload entry 1\.metadata\.useCase must be a string/,
  );

  await writeFile(
    workloadPath,
    JSON.stringify({
      input: "ping",
      templateVariables: {
        bad: {},
      },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadWorkload(workloadPath),
    /Workload entry 1\.templateVariables\.bad must be a string, number, or boolean/,
  );
});

test("loadBaseline rejects oversized benchmark baseline files before parsing", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-baseline-limit-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const baselinePath = path.join(tempDir, "huge-baseline.json");
  await writeFile(baselinePath, "x".repeat(256 * 1024 + 1), "utf8");

  await assert.rejects(
    () => loadBaseline(baselinePath),
    /Baseline file must be at most 262144 bytes/,
  );
});

test("loadBaseline accepts decimal benchmark baseline assertions", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-baseline-valid-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const baselinePath = path.join(tempDir, "baseline.json");
  await writeFile(
    baselinePath,
    JSON.stringify({
      version: 1,
      label: "test-baseline",
      machineClass: "test-vps",
      workloadPath: "./examples/workloads/email-workload.jsonl",
      concurrency: 2,
      requests: 16,
      assertions: {
        minPromptCacheReuseRatio: 0.35,
      },
      notes: ["Allows decimal ratio assertions."],
    }),
    "utf8",
  );

  const baseline = await loadBaseline(baselinePath);
  assert.equal(baseline.assertions.minPromptCacheReuseRatio, 0.35);
});

test("loadBaseline rejects malformed benchmark baseline files", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-baseline-shape-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const baselinePath = path.join(tempDir, "baseline.json");

  await writeFile(
    baselinePath,
    JSON.stringify({
      version: 1,
      label: "test-baseline",
      machineClass: "test-vps",
      concurrency: 2,
      requests: 16,
    }),
    "utf8",
  );
  await assert.rejects(() => loadBaseline(baselinePath), /\.assertions is required/);

  await writeFile(
    baselinePath,
    JSON.stringify({
      version: 1,
      label: "test-baseline",
      machineClass: "test-vps",
      concurrency: 2,
      requests: 16,
      assertions: {
        minPromptCacheReuseRatio: "0.35",
      },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadBaseline(baselinePath),
    /\.assertions\.minPromptCacheReuseRatio must be a non-negative number/,
  );

  await writeFile(
    baselinePath,
    JSON.stringify({
      version: 1,
      label: "test-baseline",
      machineClass: "test-vps",
      concurrency: 2,
      requests: 16,
      assertions: {},
      notes: [42],
    }),
    "utf8",
  );
  await assert.rejects(() => loadBaseline(baselinePath), /\.notes\[0\] must be a string/);
});

test("runBenchmark accepts bounded gateway inference responses", async () => {
  await withTestServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "inf_test",
          output: "ok",
          cached: false,
          deduplicated: false,
          queueTimeMs: 1,
          latencyMs: 2,
          degraded: false,
          usage: {
            tokens: {
              prompt: 1,
              completion: 1,
              total: 2,
            },
          },
        }),
      );
    },
    async (baseUrl) => {
      const summary = await runBenchmark({
        baseUrl,
        workload: [{ input: "ping" }],
        concurrency: 1,
        requests: 1,
        label: "network-smoke",
      });

      assert.equal(summary.requests, 1);
      assert.equal(summary.latencyP50Ms, 2);
    },
  );
});

test("runBenchmark rejects malformed direct options before dispatch", async () => {
  await assert.rejects(() => runBenchmark(null as never), /Benchmark options must be an object/);
  await assert.rejects(
    () =>
      runBenchmark({
        baseUrl: "http://127.0.0.1:3000",
        workload: [],
        concurrency: 1,
        requests: 1,
        label: "empty-workload",
      }),
    /Benchmark workload has no usable entries/,
  );
  await assert.rejects(
    () =>
      runBenchmark({
        baseUrl: "http://127.0.0.1:3000",
        workload: [{ input: "ping" }],
        concurrency: 65,
        requests: 1,
        label: "bad-concurrency",
      }),
    /Benchmark concurrency must be less than or equal to 64/,
  );
  await assert.rejects(
    () =>
      runBenchmark({
        baseUrl: "http://127.0.0.1:3000",
        workload: [{ input: "ping" }],
        concurrency: 1,
        requests: 10_001,
        label: "bad-requests",
      }),
    /Benchmark requests must be less than or equal to 10000/,
  );
});

test("runBenchmark strips non-inference fields before dispatch", async () => {
  let received: Record<string, unknown> | undefined;

  await withTestServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "inf_stripped",
            output: "ok",
            cached: false,
            deduplicated: false,
            queueTimeMs: 1,
            latencyMs: 2,
            degraded: false,
            usage: {
              tokens: {
                prompt: 1,
                completion: 1,
                total: 2,
              },
            },
          }),
        );
      });
    },
    async (baseUrl) => {
      await runBenchmark({
        baseUrl,
        workload: [
          {
            input: "ping",
            responseFormat: { type: "json_object", extra: "not-forwarded" },
            benchmark: { noPromptEcho: true },
            extra: "not-forwarded",
          } as never,
        ],
        concurrency: 1,
        requests: 1,
        label: "strip-fields",
      });
    },
  );

  assert.deepEqual(received, { input: "ping", responseFormat: { type: "json_object" } });
});

test("runBenchmark rejects oversized request bodies before dispatch", async () => {
  let requests = 0;

  await withTestServer(
    (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
    async (baseUrl) => {
      const templateVariables = Object.fromEntries(
        Array.from({ length: 64 }, (_value, index) => [`v${index}`, "x".repeat(16_384)]),
      );

      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [
              {
                templateId: "email.cold_outreach.v1",
                templateVariables,
              },
            ],
            concurrency: 1,
            requests: 1,
            label: "oversized-request",
          }),
        /Benchmark request body must be at most 1048576 bytes/,
      );
    },
  );

  assert.equal(requests, 0);
});

test("runBenchmark streams summary metrics without retaining sample payloads", async () => {
  await withTestServer(
    (request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as {
          input?: string;
          responseFormat?: { type?: string };
        };
        const wantsJson = body.responseFormat?.type === "json_object";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: wantsJson ? "inf_json" : "inf_echo",
            output: wantsJson ? '{"ok":true}' : body.input,
            cached: wantsJson,
            deduplicated: false,
            queueTimeMs: wantsJson ? 2 : 4,
            latencyMs: wantsJson ? 10 : 30,
            degraded: false,
            usage: {
              tokens: {
                prompt: 10,
                completion: 2,
                total: 12,
              },
            },
            diagnostics: {
              provider: {
                requestShape: "llama.cpp-completion",
                promptFormat: "prompt-scaffold",
                promptFormatReason: "benchmark",
                slotRouteReason: "preferred",
                modelRef: "local-test",
                backendModel: "test.gguf",
                launchPreset: "single-vps-sub1b",
                tokensCached: wantsJson ? 5 : 0,
                slotId: 1,
                preferredSlot: 1,
                totalSlots: 2,
                contextWindow: wantsJson ? 2048 : 1024,
                timings: {
                  ttftMs: wantsJson ? 7 : 9,
                  completionTokensPerSecond: wantsJson ? 12 : 6,
                },
              },
            },
          }),
        );
      });
    },
    async (baseUrl) => {
      const summary = await runBenchmark({
        baseUrl,
        workload: [
          {
            input: "return a compact json object",
            responseFormat: { type: "json_object" },
          },
          {
            input: "please do not repeat this benchmark prompt exactly in the output",
            benchmark: { noPromptEcho: true },
          },
        ],
        concurrency: 2,
        requests: 2,
        label: "streamed-summary",
      });

      assert.equal(summary.requests, 2);
      assert.equal(summary.responseCacheHitRate, 50);
      assert.equal(summary.promptCacheHitRate, 50);
      assert.equal(summary.promptCacheReuseRatio, 0.5);
      assert.equal(summary.validJsonRate, 100);
      assert.equal(summary.qualityFailures, 1);
      assert.equal(summary.promptEchoRejects, 1);
      assert.equal(summary.latencyP50Ms, 10);
      assert.equal(summary.latencyP95Ms, 10);
      assert.equal(summary.providerDiagnostics?.requestShapes["llama.cpp-completion"], 2);
      assert.equal(summary.providerDiagnostics?.promptFormats["prompt-scaffold"], 2);
      assert.equal(summary.providerDiagnostics?.slotReuseRate, 100);
      assert.equal(summary.providerDiagnostics?.cachedTokensAvg, 2.5);
      assert.equal(summary.providerDiagnostics?.contextWindowP50, 1024);
      assert.equal(summary.providerDiagnostics?.totalSlots, 2);
    },
  );
});

test("runBenchmark rejects oversized gateway error responses", async () => {
  await withTestServer(
    (_request, response) => {
      response.writeHead(500, {
        "content-length": String(64 * 1024 + 1),
        "content-type": "text/plain",
      });
      response.end("backend failed");
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [{ input: "ping" }],
            concurrency: 1,
            requests: 1,
            label: "oversized-error",
          }),
        /Benchmark error response exceeded 65536 bytes/,
      );
    },
  );
});

test("runBenchmark refuses to follow gateway redirects", async () => {
  let redirectedRequests = 0;
  let redirectedAuthorization: string | undefined;
  const redirectedServer = createServer((request, response) => {
    redirectedRequests += 1;
    redirectedAuthorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "inf_redirected",
        output: "redirected",
        cached: false,
        deduplicated: false,
        queueTimeMs: 1,
        latencyMs: 2,
        degraded: false,
        usage: {
          tokens: {
            prompt: 1,
            completion: 1,
            total: 2,
          },
        },
      }),
    );
  });

  await new Promise<void>((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));

  try {
    const redirectedAddress = redirectedServer.address();
    if (!redirectedAddress || typeof redirectedAddress === "string") {
      throw new Error("Expected a TCP server address");
    }

    await withTestServer(
      (_request, response) => {
        response.writeHead(307, {
          "content-type": "application/json",
          location: `http://127.0.0.1:${(redirectedAddress as AddressInfo).port}/v1/infer`,
        });
        response.end(JSON.stringify({ error: { code: "redirected" } }));
      },
      async (baseUrl) => {
        await assert.rejects(
          () =>
            runBenchmark({
              baseUrl,
              workload: [{ input: "ping" }],
              concurrency: 1,
              requests: 1,
              label: "redirect",
              apiKey: "benchmark-secret",
            }),
          /Benchmark request failed with 307/,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      redirectedServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedAuthorization, undefined);
});

test("runBenchmark rejects oversized and malformed gateway success responses", async () => {
  await withTestServer(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": String(2 * 1024 * 1024 + 1),
        "content-type": "application/json",
      });
      response.end("{}");
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [{ input: "ping" }],
            concurrency: 1,
            requests: 1,
            label: "oversized-success",
          }),
        /Benchmark response exceeded 2097152 bytes/,
      );
    },
  );

  await withTestServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: "ok" }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [{ input: "ping" }],
            concurrency: 1,
            requests: 1,
            label: "malformed-success",
          }),
        /Benchmark response\.id must be a non-empty string/,
      );
    },
  );

  await withTestServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "inf_oversized_latency",
          output: "ok",
          cached: false,
          deduplicated: false,
          queueTimeMs: 1,
          latencyMs: 180_001,
          degraded: false,
          usage: {
            tokens: {
              prompt: 1,
              completion: 1,
              total: 2,
            },
          },
        }),
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [{ input: "ping" }],
            concurrency: 1,
            requests: 1,
            label: "oversized-latency",
          }),
        /Benchmark response\.latencyMs must be less than or equal to 180000/,
      );
    },
  );

  await withTestServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "inf_oversized_tokens",
          output: "ok",
          cached: false,
          deduplicated: false,
          queueTimeMs: 1,
          latencyMs: 2,
          degraded: false,
          usage: {
            tokens: {
              prompt: 1_000_001,
              completion: 1,
              total: 1_000_002,
            },
          },
        }),
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runBenchmark({
            baseUrl,
            workload: [{ input: "ping" }],
            concurrency: 1,
            requests: 1,
            label: "oversized-tokens",
          }),
        /Benchmark response\.usage\.tokens\.prompt must be less than or equal to 1000000/,
      );
    },
  );
});

test("waitForBenchmarkChildHealth fails fast with bounded child output", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "console.error('llama startup failed'); setTimeout(() => process.exit(42), 25);",
  ]);

  await assert.rejects(
    () => waitForBenchmarkChildHealth(child, "llama.cpp server", "http://127.0.0.1:1", 30_000),
    /llama\.cpp server exited before becoming healthy \(code=42 signal=null\)[\s\S]*llama startup failed/,
  );
});

test("benchmark file helpers reject malformed direct paths before filesystem work", async () => {
  const oversizedPath = `/${"a".repeat(4096)}`;

  await assert.rejects(
    () => loadWorkload(" examples/workload.jsonl"),
    /Workload path must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () => loadBaseline("examples/baseline.json\n"),
    /Baseline path must not contain control characters/,
  );
  await assert.rejects(
    () =>
      writeStructuredOutput(
        " .ray/benchmarks/latest.json",
        minimalBenchmarkOutput("malformed-output-path"),
      ),
    /Benchmark output path must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () =>
      appendHistoryOutput(".ray/benchmarks\n", minimalBenchmarkOutput("malformed-history-path")),
    /Benchmark history directory must not contain control characters/,
  );
  await assert.rejects(
    () => loadWorkload(oversizedPath),
    /Workload path must be at most 4096 bytes/,
  );
  await assert.rejects(
    () => loadBaseline(oversizedPath),
    /Baseline path must be at most 4096 bytes/,
  );
  await assert.rejects(
    () => writeStructuredOutput(oversizedPath, minimalBenchmarkOutput("oversized-output-path")),
    /Benchmark output path must be at most 4096 bytes/,
  );
  await assert.rejects(
    () => appendHistoryOutput(oversizedPath, minimalBenchmarkOutput("oversized-history-path")),
    /Benchmark history directory must be at most 4096 bytes/,
  );
});

test("writeStructuredOutput keeps existing reports when oversized output is rejected", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-output-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, "latest.json");
  await writeFile(outputPath, "stale report\n");
  await chmod(outputPath, 0o666);
  await writeStructuredOutput(outputPath, {
    kind: "benchmark-summary",
    version: 1,
    generatedAt: new Date(0).toISOString(),
    args: {
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      label: "bounded-output",
    },
    summary: {
      label: "bounded-output",
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      wallTimeMs: 1,
    },
  });
  const previousContents = await readFile(outputPath, "utf8");
  const outputMode = (await stat(outputPath)).mode & 0o777;

  await assert.rejects(
    () =>
      writeStructuredOutput(outputPath, {
        kind: "benchmark-summary",
        version: 1,
        generatedAt: new Date(0).toISOString(),
        args: {
          baseUrl: "http://127.0.0.1:3000",
          concurrency: 1,
          requests: 1,
          label: "oversized-output",
        },
        summary: {
          label: "x".repeat(8 * 1024 * 1024),
          baseUrl: "http://127.0.0.1:3000",
          concurrency: 1,
          requests: 1,
          wallTimeMs: 1,
        },
      }),
    /Benchmark structured output must be at most 8388608 bytes/,
  );

  assert.equal(await readFile(outputPath, "utf8"), previousContents);
  assert.equal(outputMode & 0o022, 0);
  assert.equal(
    (await readdir(tempDir)).some((entry) => entry.startsWith(".tmp-")),
    false,
  );
});

test("appendHistoryOutput keeps benchmark history bounded", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-benchmark-history-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const historyDir = path.join(tempDir, "history");
  const historyPath = path.join(historyDir, "benchmark-summary.jsonl");
  await mkdir(historyDir, { recursive: true });
  await writeFile(historyPath, `${"x".repeat(8 * 1024 * 1024 + 128)}\n`);
  await chmod(historyPath, 0o666);

  await appendHistoryOutput(historyDir, {
    kind: "benchmark-summary",
    version: 1,
    generatedAt: new Date(0).toISOString(),
    args: {
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      label: "bounded-history",
    },
    summary: {
      label: "bounded-history",
      baseUrl: "http://127.0.0.1:3000",
      concurrency: 1,
      requests: 1,
      wallTimeMs: 1,
    },
  });

  const historyStats = await stat(historyPath);
  const contents = await readFile(historyPath, "utf8");

  assert.ok(historyStats.size <= 8 * 1024 * 1024);
  assert.equal(historyStats.mode & 0o022, 0);
  assert.match(contents, /"kind":"benchmark-summary"/);
  assert.equal(contents.endsWith("\n"), true);
});
