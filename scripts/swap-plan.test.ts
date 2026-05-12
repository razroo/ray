import assert from "node:assert/strict";
import test from "node:test";
import { createSwapPlan, formatTextPlan, parseArgs, runSwapPlanCli } from "./swap-plan.ts";

test("parseArgs accepts strict swap plan options", () => {
  const args = parseArgs(["--path", "/var/lib/ray/swapfile", "--size-mib", "2048", "--json"]);

  assert.equal(args.path, "/var/lib/ray/swapfile");
  assert.equal(args.sizeMiB, 2_048);
  assert.equal(args.json, true);
});

test("parseArgs rejects malformed swap plan argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(() => parseArgs(["--path"]), /--path requires a value/);
  assert.throws(() => parseArgs(["--path", "swapfile"]), /swap path must be absolute/);
  assert.throws(() => parseArgs(["--path", "/var/lib/ray/swap file"]), /must not contain/);
  assert.throws(() => parseArgs(["--path", "/"]), /must point to a file/);
  assert.throws(() => parseArgs(["--size-mib", "0"]), /integer from 1/);
  assert.throws(() => parseArgs(["--size-mib", "65537"]), /integer from 1/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["/swapfile"]), /Unexpected positional argument/);
});

test("createSwapPlan prints guarded swap-file commands", () => {
  const plan = createSwapPlan({
    path: "/var/lib/ray/swapfile",
    sizeMiB: 2_048,
  });

  assert.equal(plan.path, "/var/lib/ray/swapfile");
  assert.equal(plan.sizeMiB, 2_048);
  assert.match(plan.commands[0] ?? "", /test ! -e '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands[1] ?? "", /fallocate -l 2048M '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /chmod 600 '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /mkswap '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /swapon '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /\/var\/lib\/ray\/swapfile none swap sw 0 0/);
});

test("formatTextPlan prints operator-ready swap instructions", () => {
  const text = formatTextPlan(createSwapPlan());

  assert.match(text, /Ray small-VPS swap file plan:/);
  assert.match(text, /swap file: \/swapfile/);
  assert.match(text, /size: 1024 MiB/);
  assert.match(text, /Run on the VPS:/);
  assert.match(text, /Then run doctor again/);
});

test("runSwapPlanCli prints JSON output", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runSwapPlanCli(
    ["--path", "/var/lib/ray/swapfile", "--size-mib", "1536", "--json"],
    {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { path: string; sizeMiB: number };
  assert.equal(parsed.path, "/var/lib/ray/swapfile");
  assert.equal(parsed.sizeMiB, 1_536);
});
