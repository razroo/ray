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
  assert.equal(args.sysctlOnly, false);
  assert.equal(args.json, true);

  const sysctlOnlyArgs = parseArgs(["--sysctl-only", "--swappiness", "10"]);
  assert.equal(sysctlOnlyArgs.sysctlOnly, true);
  assert.equal(sysctlOnlyArgs.swappiness, 10);
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
  assert.throws(() => parseArgs(["--sysctl-only", "--path", "/swapfile"]), /--path cannot/);
  assert.throws(() => parseArgs(["--sysctl-only", "--size-mib", "1024"]), /--size-mib cannot/);
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
  assert.match(plan.commands.join("\n"), /cat \/proc\/sys\/vm\/swappiness/);
  assert.match(plan.commands.join("\n"), /timeout 30s swapon --show/);
});

test("createSwapPlan can print swappiness-only commands without touching swap files", () => {
  const plan = createSwapPlan({
    swappiness: 10,
    sysctlOnly: true,
  });

  assert.equal(plan.sysctlOnly, true);
  assert.equal(plan.swappiness, 10);
  assert.equal(plan.commands.length, 3);
  assert.doesNotMatch(plan.commands.join("\n"), /fallocate|mkswap|swapon --show|\/etc\/fstab/);
  assert.match(
    plan.commands.join("\n"),
    /timeout 60s sudo tee \/etc\/sysctl\.d\/99-ray-swap\.conf/,
  );
  assert.match(plan.commands.join("\n"), /timeout 60s sudo sysctl 'vm\.swappiness=10'/);
  assert.match(plan.commands.join("\n"), /cat \/proc\/sys\/vm\/swappiness/);
  assert.throws(() => createSwapPlan({ path: "/swapfile", sysctlOnly: true }), /path cannot/);
  assert.throws(() => createSwapPlan({ sizeMiB: 1024, sysctlOnly: true }), /sizeMiB cannot/);
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

test("formatTextPlan prints operator-ready swappiness-only instructions", () => {
  const text = formatTextPlan(createSwapPlan({ sysctlOnly: true, swappiness: 10 }));

  assert.match(text, /Ray small-VPS swappiness plan:/);
  assert.doesNotMatch(text, /swap file:/);
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

test("runSwapPlanCli prints JSON sysctl-only output", async () => {
  let stdout = "";
  let stderr = "";
  const exitCode = await runSwapPlanCli(["--sysctl-only", "--swappiness", "10", "--json"], {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  const parsed = JSON.parse(stdout) as { sysctlOnly: boolean; commands: string[] };
  assert.equal(parsed.sysctlOnly, true);
  assert.equal(parsed.commands.length, 3);
  assert.doesNotMatch(parsed.commands.join("\n"), /fallocate|mkswap|swapon --show/);
});
