import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectConfigPaths,
  formatTextSummary,
  parseArgs,
  validateConfigFiles,
} from "./validate-configs.ts";

test("parseArgs accepts strict config validation options", () => {
  const args = parseArgs([
    "--cwd",
    "/srv/ray",
    "--config-dir",
    "examples/config",
    "--fail-on-warn",
    "--json",
    "--verbose",
  ]);

  assert.equal(args.cwd, "/srv/ray");
  assert.equal(args.configDir, "examples/config");
  assert.equal(args.failOnWarn, true);
  assert.equal(args.json, true);
  assert.equal(args.verbose, true);
});

test("parseArgs rejects malformed config validation argv", () => {
  assert.throws(() => parseArgs(null as unknown as string[]), /argv must be an array/);
  assert.throws(
    () => parseArgs(["--cwd", 42] as unknown as string[]),
    /argv\[1\] must be a string/,
  );
  assert.throws(() => parseArgs(["--config-dir"]), /--config-dir requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option: --unknown/);
  assert.throws(() => parseArgs(["examples/config"]), /Unexpected positional argument/);
});

test("collectConfigPaths returns sorted JSON config paths only", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-config-collector-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  const configDir = path.join(tempDir, "configs");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "b.json"), "{}", "utf8");
  await writeFile(path.join(configDir, "notes.txt"), "ignored", "utf8");
  await writeFile(path.join(configDir, "a.json"), "{}", "utf8");

  assert.deepEqual(await collectConfigPaths(tempDir, "configs"), [
    path.join(configDir, "a.json"),
    path.join(configDir, "b.json"),
  ]);
});

test("collectConfigPaths rejects excessive configs while streaming", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-config-collector-cap-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configDir = path.join(tempDir, "configs");
  await mkdir(configDir);
  await Promise.all(
    Array.from({ length: 129 }, (_value, index) =>
      writeFile(path.join(configDir, `${index.toString().padStart(3, "0")}.json`), "{}"),
    ),
  );

  await assert.rejects(
    () => collectConfigPaths(tempDir, "configs"),
    /Config directory must contain at most 128 JSON files/,
  );
});

test("validateConfigFiles requires explicit public runtime guardrails", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ray-config-public-policy-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const configPath = path.join(tempDir, "ray.policy-missing.public.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profile: "1b",
      auth: {
        enabled: true,
        apiKeyEnv: "RAY_API_KEYS",
      },
      rateLimit: {
        enabled: true,
        maxRequests: 75,
      },
      tags: {
        exposure: "public",
      },
    }),
    "utf8",
  );

  const summary = await validateConfigFiles({
    cwd: process.cwd(),
    configPaths: [configPath],
    env: {
      ...process.env,
      RAY_API_KEYS: "smoke",
    },
  });
  const codes = summary.results.flatMap((result) =>
    result.diagnostics.map((diagnostic) => diagnostic.code),
  );

  assert.equal(summary.ok, false);
  assert.ok(codes.includes("public_config_server_host_explicit"));
  assert.ok(codes.includes("public_config_request_body_limit_explicit"));
  assert.ok(codes.includes("public_config_rate_limit_window_explicit"));
  assert.ok(codes.includes("public_config_rate_limit_key_strategy_explicit"));
  assert.ok(codes.includes("public_config_rate_limit_proxy_headers_explicit"));
  assert.ok(codes.includes("public_config_scheduler_concurrency_explicit"));
  assert.ok(codes.includes("public_config_scheduler_max_queue_explicit"));
  assert.ok(codes.includes("public_config_scheduler_queued_tokens_explicit"));
  assert.ok(codes.includes("public_config_scheduler_inflight_tokens_explicit"));
  assert.ok(codes.includes("public_config_scheduler_request_timeout_explicit"));
  assert.ok(codes.includes("public_config_scheduler_dedupe_explicit"));
  assert.ok(codes.includes("public_config_scheduler_batch_window_explicit"));
  assert.ok(codes.includes("public_config_scheduler_affinity_lookahead_explicit"));
  assert.ok(codes.includes("public_config_scheduler_short_job_tokens_explicit"));
  assert.ok(codes.includes("public_config_async_queue_enabled_explicit"));
  assert.ok(codes.includes("public_config_async_queue_storage_explicit"));
  assert.ok(codes.includes("public_config_async_queue_max_jobs_explicit"));
  assert.ok(codes.includes("public_config_async_queue_storage_reserve_explicit"));
  assert.ok(codes.includes("public_config_async_queue_completed_ttl_explicit"));
  assert.ok(codes.includes("public_config_async_queue_poll_interval_explicit"));
  assert.ok(codes.includes("public_config_async_queue_dispatch_concurrency_explicit"));
  assert.ok(codes.includes("public_config_async_queue_max_attempts_explicit"));
  assert.ok(codes.includes("public_config_async_queue_callback_timeout_explicit"));
  assert.ok(codes.includes("public_config_async_queue_callback_attempts_explicit"));
  assert.ok(codes.includes("public_config_async_queue_private_callbacks_explicit"));
  assert.ok(codes.includes("public_config_async_queue_callback_hosts_explicit"));
  assert.ok(codes.includes("public_config_cache_enabled_explicit"));
  assert.ok(codes.includes("public_config_cache_entries_explicit"));
  assert.ok(codes.includes("public_config_cache_bytes_explicit"));
  assert.ok(codes.includes("public_config_cache_ttl_explicit"));
  assert.ok(codes.includes("public_config_cache_key_strategy_explicit"));
  assert.ok(codes.includes("public_config_degradation_enabled_explicit"));
  assert.ok(codes.includes("public_config_degradation_queue_depth_explicit"));
  assert.ok(codes.includes("public_config_degradation_prompt_chars_explicit"));
  assert.ok(codes.includes("public_config_degradation_tokens_explicit"));
  assert.ok(codes.includes("public_config_degradation_memory_rss_explicit"));
  assert.ok(codes.includes("public_config_degradation_cpu_throttled_ratio_explicit"));
  assert.ok(codes.includes("public_config_prompt_compiler_enabled_explicit"));
  assert.ok(codes.includes("public_config_prompt_compiler_collapse_whitespace_explicit"));
  assert.ok(codes.includes("public_config_prompt_compiler_dedupe_lines_explicit"));
  assert.ok(codes.includes("public_config_prompt_compiler_family_keys_explicit"));
  assert.ok(codes.includes("public_config_adaptive_enabled_explicit"));
  assert.ok(codes.includes("public_config_adaptive_sample_size_explicit"));
  assert.ok(codes.includes("public_config_adaptive_queue_latency_explicit"));
  assert.ok(codes.includes("public_config_adaptive_min_tps_explicit"));
  assert.ok(codes.includes("public_config_adaptive_reduction_ratio_explicit"));
  assert.ok(codes.includes("public_config_adaptive_min_output_tokens_explicit"));
  assert.ok(codes.includes("public_config_adaptive_learned_cap_explicit"));
  assert.ok(codes.includes("public_config_adaptive_family_history_explicit"));
  assert.ok(codes.includes("public_config_adaptive_learned_cap_samples_explicit"));
  assert.ok(codes.includes("public_config_adaptive_draft_percentile_explicit"));
  assert.ok(codes.includes("public_config_adaptive_short_percentile_explicit"));
  assert.ok(codes.includes("public_config_adaptive_headroom_tokens_explicit"));
});

test("validateConfigFiles accepts every checked-in example config", async () => {
  const cwd = process.cwd();
  const configPaths = await collectConfigPaths(cwd, "examples/config");
  const summary = await validateConfigFiles({
    cwd,
    configPaths,
    env: {
      ...process.env,
      RAY_API_KEYS: "smoke",
      RAY_LLAMA_CPP_CTX_SIZE: "not-a-number",
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.errorCount, 0);
  assert.ok(summary.configCount >= 19);
  assert.ok(summary.warningCount > 0);
  assert.equal(
    summary.results
      .flatMap((result) => result.diagnostics)
      .some((diagnostic) =>
        [
          "async_queue_storage_low",
          "async_queue_storage_ok",
          "async_queue_storage_not_directory",
          "async_queue_storage_unreadable",
          "async_queue_storage_service_user_inaccessible",
        ].includes(diagnostic.code),
      ),
    false,
  );
  assert.ok(
    summary.results.some(
      (result) =>
        result.configPath.endsWith("ray.sub1b.cax11.public.json") &&
        result.profile === "sub1b-cax11",
    ),
  );
  const compactSummary = formatTextSummary(cwd, summary);
  assert.match(compactSummary, /Run with --verbose to print warning diagnostics/);
  assert.doesNotMatch(compactSummary, /warn auth_disabled:/);
  const verboseSummary = formatTextSummary(cwd, summary, { verbose: true });
  assert.match(verboseSummary, /warn auth_disabled:/);
  assert.doesNotMatch(verboseSummary, /async_queue_storage_(?:low|ok|not_directory|unreadable)/);
  assert.match(compactSummary, /Summary: warnings=\d+ errors=0/);
});
