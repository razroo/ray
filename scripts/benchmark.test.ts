import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendHistoryOutput,
  loadBaseline,
  loadWorkload,
  parseArgs,
  runBenchmark,
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
    () => parseArgs(["--label", "x".repeat(4_097)]),
    /argv\[1\] must be at most 4096 bytes/,
  );
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
  assert.match(contents, /"kind":"benchmark-summary"/);
  assert.equal(contents.endsWith("\n"), true);
});
