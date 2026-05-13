import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTextSummary,
  parseArgs,
  runGatewaySmokeCli,
  type GatewaySmokeSummary,
} from "./gateway-smoke.ts";

const repoRoot = process.cwd();

function createIoCapture(): {
  io: Pick<NodeJS.Process, "stdout" | "stderr">;
  stdout: () => string;
  stderr: () => string;
} {
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
    "--json",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configPath, "./examples/config/ray.tiny.json");
  assert.equal(args.host, "127.0.0.1");
  assert.equal(args.port, 3017);
  assert.equal(args.timeoutMs, 5000);
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed gateway smoke argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(() => parseArgs(["--port", "0"]), /--port must be a positive integer/);
  assert.throws(
    () => parseArgs(["--timeout-ms", "120001"]),
    /--timeout-ms must be a positive integer/,
  );
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["config.json"]), /Unexpected positional argument/);
});

test("formatTextSummary reports the checked gateway endpoints", () => {
  const summary: GatewaySmokeSummary = {
    ok: true,
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
  };

  const text = formatTextSummary(repoRoot, summary);

  assert.match(text, /examples\/config\/ray\.tiny\.json/);
  assert.match(text, /livez: HTTP 200/);
  assert.match(text, /readyz: HTTP 200/);
  assert.match(text, /infer: HTTP 200, outputChars=42/);
});

test("runGatewaySmokeCli starts the tiny profile and verifies inference", async () => {
  const capture = createIoCapture();

  const exitCode = await runGatewaySmokeCli(["--cwd", repoRoot, "--json"], capture.io);

  assert.equal(exitCode, 0);
  assert.equal(capture.stderr(), "");

  const summary = JSON.parse(capture.stdout()) as GatewaySmokeSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.profile, "tiny");
  assert.equal(summary.modelId, "tiny-dev");
  assert.equal(summary.host, "127.0.0.1");
  assert.equal(summary.livezStatus, 200);
  assert.equal(summary.readyzStatus, 200);
  assert.equal(summary.inferStatus, 200);
  assert.ok(summary.port > 0);
  assert.ok(summary.outputChars > 0);
});
