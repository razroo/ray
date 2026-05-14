import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import {
  fetchText,
  formatTextSummary,
  parseArgs,
  runGatewaySmokeCli,
  smokeGateway,
  type GatewaySmokeSummary,
} from "./gateway-smoke.ts";

const repoRoot = process.cwd();

interface IoCapture {
  io: Pick<NodeJS.Process, "stdout" | "stderr">;
  stdout: () => string;
  stderr: () => string;
}

function createIoCapture(): IoCapture {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    } as unknown as Pick<NodeJS.Process, "stdout" | "stderr">,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function assertCliSucceeded(exitCode: number, capture: IoCapture): void {
  assert.equal(
    exitCode,
    0,
    `expected gateway smoke CLI to exit 0\nstderr:\n${capture.stderr()}\nstdout:\n${capture.stdout()}`,
  );
  assert.equal(capture.stderr(), "");
}

test("parseArgs accepts strict gateway smoke options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config",
    "./examples/config/ray.tiny.json",
    "--host",
    "127.0.0.1",
    "--port",
    "3017",
    "--timeout-ms",
    "5000",
    "--public-safety",
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configPath, "./examples/config/ray.tiny.json");
  assert.equal(args.host, "127.0.0.1");
  assert.equal(args.port, 3017);
  assert.equal(args.timeoutMs, 5000);
  assert.equal(args.publicSafety, true);
  assert.equal(args.asyncQueue, false);
  assert.equal(args.json, true);

  const asyncArgs = parseArgs(["--async-queue"]);
  assert.equal(asyncArgs.asyncQueue, true);
  assert.equal(asyncArgs.publicSafety, false);

  const publicAsyncArgs = parseArgs(["--public-safety", "--async-queue"]);
  assert.equal(publicAsyncArgs.publicSafety, true);
  assert.equal(publicAsyncArgs.asyncQueue, true);

  assert.equal(parseArgs(["--host", "localhost"]).host, "localhost");
  assert.equal(parseArgs(["--host", "::1"]).host, "::1");
});

test("parseArgs rejects malformed gateway smoke argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(
    () => parseArgs(["--cwd", " /srv/ray"]),
    /--cwd must be a path without surrounding whitespace/,
  );
  assert.throws(
    () => parseArgs(["--config", "./examples/config/ray.tiny.json\n"]),
    /--config must not contain control characters/,
  );
  assert.throws(() => parseArgs(["--port", "0"]), /--port must be a positive integer/);
  assert.throws(
    () => parseArgs(["--timeout-ms", "120001"]),
    /--timeout-ms must be a positive integer/,
  );
  assert.throws(
    () => parseArgs(["--host", "0.0.0.0"]),
    /--host must be localhost or a loopback IP address/,
  );
  assert.throws(
    () => parseArgs(["--host", "example.com"]),
    /--host must be localhost or a loopback IP address/,
  );
  assert.throws(
    () => parseArgs(["--host", "127.0.0.1 "]),
    /--host must not contain control characters or whitespace/,
  );
  assert.throws(
    () => parseArgs(["--host", "[::1]"]),
    /--host must be an unbracketed loopback host/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["config.json"]), /Unexpected positional argument/);
});

test("fetchText refuses to follow smoke probe redirects", async (t) => {
  let redirectedRequests = 0;
  let redirectedAuthorization: string | undefined;
  const redirectedServer = createServer((request, response) => {
    redirectedRequests += 1;
    redirectedAuthorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("redirected");
  });

  await new Promise<void>((resolve) => redirectedServer.listen(0, "127.0.0.1", resolve));
  t.after(() => redirectedServer.close());

  const redirectedAddress = redirectedServer.address();
  if (!redirectedAddress || typeof redirectedAddress === "string") {
    throw new Error("Expected a TCP server address");
  }

  const redirectingServer = createServer((_request, response) => {
    response.writeHead(307, {
      "content-type": "text/plain",
      location: `http://127.0.0.1:${redirectedAddress.port}/readyz`,
    });
    response.end("manual redirect");
  });

  await new Promise<void>((resolve) => redirectingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => redirectingServer.close());

  const redirectingAddress = redirectingServer.address();
  if (!redirectingAddress || typeof redirectingAddress === "string") {
    throw new Error("Expected a TCP server address");
  }

  const response = await fetchText(
    `http://127.0.0.1:${redirectingAddress.port}/readyz`,
    {
      method: "GET",
      headers: {
        authorization: "Bearer smoke-secret",
      },
    },
    1_000,
    "/readyz redirect smoke",
  );

  assert.equal(response.status, 307);
  assert.equal(response.text, "manual redirect");
  assert.equal(redirectedRequests, 0);
  assert.equal(redirectedAuthorization, undefined);
});

test("smokeGateway rejects malformed direct inputs before startup", async () => {
  await assert.rejects(
    () => smokeGateway(null as never),
    /gateway smoke options must be an object/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: " /srv/ray",
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
      }),
    /cwd must be a path without surrounding whitespace/,
  );
  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json\n",
        host: "127.0.0.1",
      }),
    /configPath must not contain control characters/,
  );
  await assert.rejects(
    () =>
      smokeGateway({
        cwd: `/${"a".repeat(4096)}`,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
      }),
    /cwd must be at most 4096 bytes/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: `/${"a".repeat(4096)}`,
        host: "127.0.0.1",
      }),
    /configPath must be at most 4096 bytes/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: path.join(path.dirname(repoRoot), "outside.json"),
        host: "127.0.0.1",
      }),
    /configPath must stay inside cwd/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "0.0.0.0",
      }),
    /host must be localhost or a loopback IP address/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1\t",
      }),
    /host must not contain control characters or whitespace/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
        port: 65_536,
      }),
    /port must be a positive integer less than or equal to 65535/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
        timeoutMs: Number.NaN,
      }),
    /timeoutMs must be a positive integer less than or equal to 120000/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
        publicSafety: "true",
      } as never),
    /publicSafety must be a boolean when provided/,
  );

  await assert.rejects(
    () =>
      smokeGateway({
        cwd: repoRoot,
        configPath: "./examples/config/ray.tiny.json",
        host: "127.0.0.1",
        asyncQueue: 1,
      } as never),
    /asyncQueue must be a boolean when provided/,
  );
});

test("formatTextSummary reports the checked gateway endpoints", () => {
  const summary: GatewaySmokeSummary = {
    ok: true,
    mode: "public-safety",
    configPath: `${repoRoot}/examples/config/ray.tiny.json`,
    profile: "tiny",
    modelId: "tiny-dev",
    host: "127.0.0.1",
    port: 3100,
    baseUrl: "http://127.0.0.1:3100",
    livezStatus: 200,
    readyzStatus: 200,
    inferStatus: 200,
    outputChars: 42,
    publicSafety: {
      livezUnauthStatus: 200,
      readyzUnauthStatus: 200,
      protectedMissingStatuses: {
        "/v1/infer": 401,
        "/health": 401,
      },
      protectedInvalidStatuses: {
        "/v1/infer": 401,
        "/health": 401,
      },
      protectedValidStatuses: {
        "/v1/infer": 200,
        "/health": 200,
      },
      rateLimitStatus: 429,
    },
  };

  const text = formatTextSummary(repoRoot, summary);

  assert.match(text, /examples\/config\/ray\.tiny\.json/);
  assert.match(text, /livez: HTTP 200/);
  assert.match(text, /readyz: HTTP 200/);
  assert.match(text, /infer: HTTP 200, outputChars=42/);
  assert.match(text, /protected missing auth: 401, 401/);
  assert.match(text, /rate limit: HTTP 429/);
});

test("formatTextSummary reports async queue job smoke results", () => {
  const summary: GatewaySmokeSummary = {
    ok: true,
    mode: "async-queue",
    configPath: `${repoRoot}/examples/config/ray.tiny.json`,
    profile: "tiny",
    modelId: "tiny-dev",
    host: "127.0.0.1",
    port: 3100,
    baseUrl: "http://127.0.0.1:3100",
    livezStatus: 200,
    readyzStatus: 200,
    inferStatus: 202,
    outputChars: 42,
    asyncQueue: {
      createStatus: 202,
      jobId: "job_123",
      location: "/v1/jobs/job_123",
      finalStatus: "succeeded",
      pollCount: 3,
      outputChars: 42,
      observability: {
        healthStatus: 200,
        metricsStatus: 200,
        healthTotalJobs: 1,
        metricsTotalJobs: 1,
        callbackConcurrency: 1,
        activeInferenceJobs: 0,
        activeCallbackDeliveries: 0,
      },
      auth: {
        missingStatus: 401,
        invalidStatus: 401,
      },
    },
  };

  const text = formatTextSummary(repoRoot, summary);

  assert.match(text, /mode: async-queue/);
  assert.match(text, /async job: HTTP 202, polls=3, status=succeeded, outputChars=42/);
  assert.match(text, /async observability: health=200, metrics=200, totalJobs=1/);
  assert.match(text, /async job auth: missing=401, invalid=401/);
});

test("runGatewaySmokeCli starts the tiny profile and verifies inference", async () => {
  const capture = createIoCapture();

  const exitCode = await runGatewaySmokeCli(["--cwd", repoRoot, "--json"], capture.io);

  assertCliSucceeded(exitCode, capture);

  const summary = JSON.parse(capture.stdout()) as GatewaySmokeSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "basic");
  assert.equal(summary.profile, "tiny");
  assert.equal(summary.modelId, "tiny-dev");
  assert.equal(summary.host, "127.0.0.1");
  assert.equal(summary.livezStatus, 200);
  assert.equal(summary.readyzStatus, 200);
  assert.equal(summary.inferStatus, 200);
  assert.ok(summary.port > 0);
  assert.ok(summary.outputChars > 0);
});

test("runGatewaySmokeCli rejects malformed direct io before parsing", async () => {
  await assert.rejects(
    () => runGatewaySmokeCli([], null as never),
    /gateway smoke io must be an object/,
  );

  await assert.rejects(
    () =>
      runGatewaySmokeCli(["--help"], {
        stdout: {},
        stderr: {
          write() {
            return true;
          },
        },
      } as never),
    /gateway smoke io\.stdout\.write must be a function/,
  );

  await assert.rejects(
    () =>
      runGatewaySmokeCli(["--unknown"], {
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {},
      } as never),
    /gateway smoke io\.stderr\.write must be a function/,
  );
});

test("runGatewaySmokeCli verifies public auth guards and rate limiting", async () => {
  const capture = createIoCapture();

  const exitCode = await runGatewaySmokeCli(
    ["--cwd", repoRoot, "--public-safety", "--json"],
    capture.io,
  );

  assertCliSucceeded(exitCode, capture);

  const summary = JSON.parse(capture.stdout()) as GatewaySmokeSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "public-safety");
  assert.equal(summary.profile, "tiny");
  assert.equal(summary.livezStatus, 200);
  assert.equal(summary.readyzStatus, 200);
  assert.equal(summary.inferStatus, 200);
  assert.equal(summary.publicSafety?.livezUnauthStatus, 200);
  assert.equal(summary.publicSafety?.readyzUnauthStatus, 200);
  assert.equal(summary.publicSafety?.rateLimitStatus, 429);
  assert.deepEqual(summary.publicSafety?.protectedMissingStatuses, {
    "/v1/infer": 401,
    "/v1/jobs": 401,
    "/v1/jobs/job_missing": 401,
    "/health": 401,
    "/metrics": 401,
    "/v1/config": 401,
  });
  assert.deepEqual(summary.publicSafety?.protectedInvalidStatuses, {
    "/v1/infer": 401,
    "/v1/jobs": 401,
    "/v1/jobs/job_missing": 401,
    "/health": 401,
    "/metrics": 401,
    "/v1/config": 401,
  });
  assert.deepEqual(summary.publicSafety?.protectedValidStatuses, {
    "/health": 200,
    "/metrics": 200,
    "/v1/config": 200,
    "/v1/infer": 200,
  });
});

test("runGatewaySmokeCli verifies async queue submission and completion", async () => {
  const capture = createIoCapture();

  const exitCode = await runGatewaySmokeCli(
    ["--cwd", repoRoot, "--async-queue", "--json"],
    capture.io,
  );

  assertCliSucceeded(exitCode, capture);

  const summary = JSON.parse(capture.stdout()) as GatewaySmokeSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "async-queue");
  assert.equal(summary.profile, "tiny");
  assert.equal(summary.livezStatus, 200);
  assert.equal(summary.readyzStatus, 200);
  assert.equal(summary.inferStatus, 202);
  assert.equal(summary.asyncQueue?.createStatus, 202);
  assert.equal(summary.asyncQueue?.finalStatus, "succeeded");
  assert.match(summary.asyncQueue?.location ?? "", /^\/v1\/jobs\//);
  assert.ok((summary.asyncQueue?.pollCount ?? 0) > 0);
  assert.ok((summary.asyncQueue?.outputChars ?? 0) > 0);
  assert.equal(summary.asyncQueue?.observability.healthStatus, 200);
  assert.equal(summary.asyncQueue?.observability.metricsStatus, 200);
  assert.ok((summary.asyncQueue?.observability.healthTotalJobs ?? 0) >= 1);
  assert.equal(
    summary.asyncQueue?.observability.metricsTotalJobs,
    summary.asyncQueue?.observability.healthTotalJobs,
  );
  assert.equal(summary.asyncQueue?.observability.callbackConcurrency, 1);
  assert.equal(summary.asyncQueue?.observability.activeInferenceJobs, 0);
  assert.equal(summary.asyncQueue?.observability.activeCallbackDeliveries, 0);
});

test("runGatewaySmokeCli verifies authenticated public async queue submission", async () => {
  const capture = createIoCapture();

  const exitCode = await runGatewaySmokeCli(
    ["--cwd", repoRoot, "--public-safety", "--async-queue", "--json"],
    capture.io,
  );

  assertCliSucceeded(exitCode, capture);

  const summary = JSON.parse(capture.stdout()) as GatewaySmokeSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "public-async-queue");
  assert.equal(summary.profile, "tiny");
  assert.equal(summary.livezStatus, 200);
  assert.equal(summary.readyzStatus, 200);
  assert.equal(summary.inferStatus, 202);
  assert.equal(summary.asyncQueue?.auth?.missingStatus, 401);
  assert.equal(summary.asyncQueue?.auth?.invalidStatus, 401);
  assert.equal(summary.asyncQueue?.createStatus, 202);
  assert.equal(summary.asyncQueue?.finalStatus, "succeeded");
  assert.match(summary.asyncQueue?.location ?? "", /^\/v1\/jobs\//);
  assert.ok((summary.asyncQueue?.pollCount ?? 0) > 0);
  assert.ok((summary.asyncQueue?.outputChars ?? 0) > 0);
  assert.equal(summary.asyncQueue?.observability.healthStatus, 200);
  assert.equal(summary.asyncQueue?.observability.metricsStatus, 200);
  assert.ok((summary.asyncQueue?.observability.healthTotalJobs ?? 0) >= 1);
  assert.equal(
    summary.asyncQueue?.observability.metricsTotalJobs,
    summary.asyncQueue?.observability.healthTotalJobs,
  );
  assert.equal(summary.asyncQueue?.observability.callbackConcurrency, 1);
  assert.equal(summary.asyncQueue?.observability.activeInferenceJobs, 0);
  assert.equal(summary.asyncQueue?.observability.activeCallbackDeliveries, 0);
});
