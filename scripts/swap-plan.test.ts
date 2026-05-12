import assert from "node:assert/strict";
import test from "node:test";
import { createSwapPlan, formatTextPlan, parseArgs, runSwapPlanCli } from "./swap-plan.ts";

test("parseArgs accepts strict swap plan options", () => {
  const args = parseArgs([
    "--path",
    "/var/lib/ray/swapfile",
    "--size-mib",
    "2048",
    "--swappiness",
    "5",
    "--json",
  ]);

  assert.equal(args.path, "/var/lib/ray/swapfile");
  assert.equal(args.sizeMiB, 2_048);
  assert.equal(args.swappiness, 5);
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
  assert.throws(() => parseArgs(["--swappiness", "-1"]), /integer from 0/);
  assert.throws(() => parseArgs(["--swappiness", "201"]), /integer from 0/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["/swapfile"]), /Unexpected positional argument/);
});

test("createSwapPlan prints guarded swap-file commands", () => {
  const plan = createSwapPlan({
    path: "/var/lib/ray/swapfile",
    sizeMiB: 2_048,
    swappiness: 5,
  });

  assert.equal(plan.path, "/var/lib/ray/swapfile");
  assert.equal(plan.sizeMiB, 2_048);
  assert.equal(plan.swappiness, 5);
  assert.match(plan.commands[0] ?? "", /timeout 30s sudo test ! -e '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands[0] ?? "", /elif \[ "\$status" -ne 0 \]; then exit "\$status"; fi/);
  assert.match(
    plan.commands[1] ?? "",
    /timeout 300s sudo fallocate -l 2048M '\/var\/lib\/ray\/swapfile'/,
  );
  assert.match(plan.commands[1] ?? "", /timeout 300s sudo dd/);
  assert.match(plan.commands.join("\n"), /timeout 60s sudo chmod 600 '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /timeout 60s sudo mkswap '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /timeout 60s sudo swapon '\/var\/lib\/ray\/swapfile'/);
  assert.match(plan.commands.join("\n"), /\/var\/lib\/ray\/swapfile none swap sw 0 0/);
  assert.match(plan.commands.join("\n"), /timeout 30s sudo grep -Fq/);
  assert.match(plan.commands.join("\n"), /timeout 60s sudo tee -a \/etc\/fstab/);
  assert.match(plan.commands.join("\n"), /vm\.swappiness=5/);
  assert.match(
    plan.commands.join("\n"),
    /timeout 60s sudo tee \/etc\/sysctl\.d\/99-ray-swap\.conf/,
  );
  assert.match(plan.commands.join("\n"), /timeout 60s sudo sysctl 'vm\.swappiness=5'/);
  assert.match(plan.commands.join("\n"), /timeout 30s swapon --show/);
});

test("createSwapPlan scales creation timeout for large swap files", () => {
  const plan = createSwapPlan({
    sizeMiB: 16_384,
  });

  assert.match(plan.commands[1] ?? "", /timeout 2048s sudo fallocate -l 16384M '\/swapfile'/);
});

test("formatTextPlan prints operator-ready swap instructions", () => {
  const text = formatTextPlan(createSwapPlan());

  assert.match(text, /Ray small-VPS swap file plan:/);
  assert.match(text, /swap file: \/swapfile/);
  assert.match(text, /size: 1024 MiB/);
  assert.match(text, /vm\.swappiness: 10/);
  assert.match(text, /Run on the VPS:/);
  assert.match(text, /Then run doctor again/);
});

test("runSwapPlanCli prints JSON output", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runSwapPlanCli(
    ["--path", "/var/lib/ray/swapfile", "--size-mib", "1536", "--swappiness", "1", "--json"],
    {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { path: string; sizeMiB: number; swappiness: number };
  assert.equal(parsed.path, "/var/lib/ray/swapfile");
  assert.equal(parsed.sizeMiB, 1_536);
  assert.equal(parsed.swappiness, 1);
});
