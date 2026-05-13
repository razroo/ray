# Portable 1B Deployment

Ray's 1B support is meant to work across model families, quantization choices, CPU architectures, and VPS providers. The built-in configs are machine-class starting points, not vendor or model lock-in.

## Pick A Machine Class

Use the 4 GB profile when the VPS has roughly:

- 2 vCPU
- 4 GB RAM
- one active llama.cpp slot
- 1B-class Q4/IQ4 GGUF that comfortably fits after OS, Ray, KV cache, and prompt cache reserve

Use the 8 GB profile when the VPS can afford:

- 4-ish vCPU or enough CPU headroom for two useful slots
- 8 GB RAM
- larger context and prompt cache
- two active llama.cpp slots

## Start From Generic Configs

- [ray.1b.generic.json](../examples/config/ray.1b.generic.json) — local/private 4 GB 1B profile
- [ray.1b.generic.public.json](../examples/config/ray.1b.generic.public.json) — public 4 GB 1B profile with auth and async queue
- [ray.1b.8gb.generic.json](../examples/config/ray.1b.8gb.generic.json) — local/private 8 GB 1B profile
- [ray.1b.8gb.generic.public.json](../examples/config/ray.1b.8gb.generic.public.json) — public 8 GB 1B profile with auth and async queue

The Qwen and Hetzner configs are reference baselines. They are useful for benchmark reproducibility, but they are not required for running another 1B model or another VPS provider.

## Override The Actual Model

Keep model-specific and cheap-node sizing values in `/etc/ray/ray.env` when possible:

```dotenv
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_MEMORY_MIB=4096
RAY_GATEWAY_RUNTIME_BINARY=/usr/local/bin/bun
RAY_DEPLOY_CADDY_BINARY=/usr/bin/caddy
RAY_PROFILE=1b
RAY_HOST=127.0.0.1
RAY_PORT=3000
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_BASE_URL=http://127.0.0.1:8081
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_WARM_ON_BOOT=true
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_MODEL_TIMEOUT_MS=28000
RAY_MODEL_CONTEXT_WINDOW=8192
RAY_MODEL_MAX_OUTPUT_TOKENS=192
RAY_MODEL_TOKENS_PER_SECOND_TARGET=10
RAY_MODEL_MEMORY_CLASS_MIB=4096
RAY_MODEL_PREFERRED_CTX_SIZE=2048
RAY_LLAMA_CPP_BASE_URL=http://127.0.0.1:8081
RAY_LLAMA_CPP_MODEL_REF=local-1b-q4
RAY_LLAMA_CPP_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_ALIAS=local-1b-q4
RAY_LLAMA_CPP_HOST=127.0.0.1
RAY_LLAMA_CPP_PORT=8081
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
RAY_LLAMA_CPP_THREADS_BATCH=2
RAY_LLAMA_CPP_THREADS_HTTP=2
RAY_LLAMA_CPP_BATCH_SIZE=192
RAY_LLAMA_CPP_UBATCH_SIZE=96
RAY_LLAMA_CPP_CACHE_REUSE=192
RAY_LLAMA_CPP_CACHE_RAM_MIB=384
RAY_LLAMA_CPP_CACHE_PROMPT=true
RAY_LLAMA_CPP_SLOT_STATE_TTL_MS=250
RAY_LLAMA_CPP_SLOT_SNAPSHOT_TIMEOUT_MS=300
RAY_LLAMA_CPP_PROMPT_SCAFFOLD_CACHE_ENTRIES=384
RAY_LLAMA_CPP_CONTINUOUS_BATCHING=true
RAY_LLAMA_CPP_ENABLE_METRICS=true
RAY_LLAMA_CPP_EXPOSE_SLOTS=true
RAY_LLAMA_CPP_WARMUP=true
RAY_LLAMA_CPP_ENABLE_UNIFIED_KV=true
RAY_LLAMA_CPP_CACHE_IDLE_SLOTS=true
RAY_LLAMA_CPP_CONTEXT_SHIFT=true
RAY_LOG_LEVEL=info
RAY_TELEMETRY_SERVICE_NAME=ray-gateway
RAY_TELEMETRY_INCLUDE_DEBUG_METRICS=true
RAY_TELEMETRY_SLOW_REQUEST_THRESHOLD_MS=2200
RAY_REQUEST_BODY_LIMIT_BYTES=48000
RAY_SCHEDULER_CONCURRENCY=1
RAY_SCHEDULER_MAX_QUEUE=40
RAY_SCHEDULER_MAX_QUEUED_TOKENS=18000
RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=2048
RAY_SCHEDULER_REQUEST_TIMEOUT_MS=32000
RAY_SCHEDULER_DEDUPE_INFLIGHT=true
RAY_SCHEDULER_BATCH_WINDOW_MS=5
RAY_SCHEDULER_AFFINITY_LOOKAHEAD=12
RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=96
RAY_CACHE_ENABLED=true
RAY_CACHE_MAX_ENTRIES=256
RAY_CACHE_MAX_BYTES=2097152
RAY_CACHE_TTL_MS=120000
RAY_CACHE_KEY_STRATEGY=input+params
RAY_PROMPT_COMPILER_ENABLED=true
RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=true
RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=true
RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=promptFamily,taskTemplate,template,useCase
RAY_GRACEFUL_DEGRADATION_ENABLED=true
RAY_DEGRADATION_QUEUE_DEPTH_THRESHOLD=10
RAY_DEGRADATION_MAX_PROMPT_CHARS=5000
RAY_DEGRADATION_MAX_TOKENS=128
RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=512
RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=0.2
RAY_ASYNC_QUEUE_ENABLED=true
RAY_ADAPTIVE_TUNING_ENABLED=true
RAY_ADAPTIVE_SAMPLE_SIZE=32
RAY_ADAPTIVE_QUEUE_LATENCY_THRESHOLD_MS=600
RAY_ADAPTIVE_MIN_COMPLETION_TOKENS_PER_SECOND=8
RAY_ADAPTIVE_MAX_OUTPUT_REDUCTION_RATIO=0.5
RAY_ADAPTIVE_MIN_OUTPUT_TOKENS=64
RAY_ADAPTIVE_LEARNED_FAMILY_CAP_ENABLED=true
RAY_ADAPTIVE_FAMILY_HISTORY_SIZE=64
RAY_ADAPTIVE_LEARNED_CAP_MIN_SAMPLES=8
RAY_ADAPTIVE_DRAFT_PERCENTILE=0.95
RAY_ADAPTIVE_SHORT_PERCENTILE=0.9
RAY_ADAPTIVE_LEARNED_CAP_HEADROOM_TOKENS=24
RAY_ASYNC_QUEUE_STORAGE_DIR=/var/lib/ray/async-queue
RAY_ASYNC_QUEUE_MAX_JOBS=1000
RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=256
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
RAY_ASYNC_QUEUE_POLL_INTERVAL_MS=1000
RAY_ASYNC_QUEUE_DISPATCH_CONCURRENCY=1
RAY_ASYNC_QUEUE_MAX_ATTEMPTS=3
RAY_ASYNC_QUEUE_CALLBACK_TIMEOUT_MS=5000
RAY_ASYNC_QUEUE_MAX_CALLBACK_ATTEMPTS=5
RAY_ASYNC_QUEUE_CALLBACK_ALLOW_PRIVATE_NETWORK=false
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example,*.trusted.example
RAY_AUTH_ENABLED=true
RAY_RATE_LIMIT_ENABLED=true
RAY_RATE_LIMIT_WINDOW_MS=60000
RAY_RATE_LIMIT_MAX_REQUESTS=75
RAY_RATE_LIMIT_MAX_KEYS=4096
RAY_RATE_LIMIT_KEY_STRATEGY=ip+api-key
RAY_RATE_LIMIT_TRUST_PROXY_HEADERS=true
```

`RAY_DEPLOY_SERVICE_USER` accepts an account name or numeric UID. Workflow
deploys create missing named accounts, while numeric UIDs must already resolve
to an account on the VPS.

Create `/var/lib/ray/models` on the VPS and place the GGUF at `RAY_MODEL_PATH`
before starting the generated llama.cpp service or running doctor.

Print the exact staging commands for the resolved config and env-file values:

```bash
timeout 300s bun run model:stage:1b:generic -- --ray-env-file /etc/ray/ray.env --binary-source ./llama-server --source ./local-1b-q4.gguf
timeout 300s bun run model:stage:1b:8gb:generic -- --ray-env-file /etc/ray/ray.env --binary-source ./llama-server --source ./local-1b-q4.gguf
```

Add `--sha256 <expected-hex-digest>` when the model source publishes a checksum.
Add `--binary-sha256 <expected-hex-digest>` when the compiled `llama-server`
source publishes or produces a checksum. The output includes the resolved binary
and model paths, install commands, checksum commands, model target storage
headroom, GGUF header check, ownership, service-user execute/read tests, and a bounded
`llama-server --help` startup probe. Printed install commands copy through
same-directory `.ray-stage-*` temp files and only move them into place after the
temp artifact passes service-user checks, so an interrupted copy does not replace
the last working binary or GGUF.
You can also put those staging inputs in `/etc/ray/ray.env` as
`RAY_LLAMA_CPP_BINARY_SOURCE_PATH`, `RAY_LLAMA_CPP_BINARY_SHA256`,
`RAY_MODEL_SOURCE_PATH`, and `RAY_MODEL_SHA256`; explicit source/checksum flags
override env-file values.
Use `--commands-only` when you want reviewed shell commands without the
explanatory staging summary.
Use `--check-sources` when the source artifacts are already on the VPS and you
want the helper to verify file access, binary startup, GGUF header, and any
provided checksums before printing the staging plan.
Use `--apply` on the VPS after reviewing those source paths to verify and stage
the configured `llama-server` and GGUF into their resolved target locations,
then run the staged `llama-server --help` probe as the service identity. Apply
checks that the model source has a GGUF header and that the model target
filesystem can hold the GGUF source while keeping a 256 MiB post-copy reserve,
then verifies that the generated service identity can read the installed GGUF.

Set `RAY_AUTH_API_KEY_ENV` when an existing secret manager or deployment workflow
uses a different environment variable for the Bearer keys.
Set `RAY_MODEL_API_KEY_ENV` only when the local or OpenAI-compatible model
backend expects an upstream Bearer token.

The generated `ray.env.example` from `bun run render:service:1b:generic` includes
the same categories of runtime, deploy, and artifact-staging overrides as
comments. Keep `RAY_LLAMA_CPP_THREADS` and `RAY_LLAMA_CPP_THREADS_BATCH` within
the VPS vCPU count when retuning the launch profile.

For 8 GB nodes, start by raising context, slots, batch threads, cache RAM, async
queue storage headroom, gateway RSS headroom, and adaptive latency/throughput
thresholds through the 8 GB generic profile before adding more overrides. Use
`RAY_PROFILE=1b-8gb` when selecting those defaults without a JSON config file.

## Validate On The VPS

Run the doctor command on the target machine after the GGUF exists and `/etc/ray/ray.env` is populated:

```bash
timeout 300s bun run doctor:1b:generic
timeout 300s bun run doctor:1b:8gb:generic
```

Doctor checks auth/env readiness, env-file permissions, systemd host readiness and generated unit-file verification, Caddy availability and generated Caddyfile validation for the reverse proxy (`caddy` on `PATH`, `RAY_DEPLOY_CADDY_BINARY`, or `--caddy-binary`), generated systemd user readiness, service-user access to the rendered config file, Bun runtime (`/usr/local/bin/bun` by default, `RAY_GATEWAY_RUNTIME_BINARY`, or `--gateway-runtime-binary`) including identifiable Bun/Node version compatibility, generated WorkingDirectory access and free-space headroom for the synced checkout and Bun production install, built gateway entrypoint, `llama-server` binary startup, GGUF model file presence and header, and async queue storage, launch profile consistency, architecture compatibility for ARM CAX11 versus x64 CX23 sub-1B profiles, generated gateway and llama.cpp paths that would be hidden by `ProtectHome=true` or `PrivateTmp=true`, projected memory fit against the selected memory budget, async queue storage headroom, swap cushion, and `vm.swappiness` for the 4 GB llama.cpp profile before the service starts.
If doctor reports a missing swap cushion on a 4 GB VPS, run `bun run swap:plan`
to print guarded commands for creating the default 1 GiB swap file and
persisting `vm.swappiness=10`, then rerun doctor before sustained inference.

## Benchmark The Actual Workload

The checked-in 1B email workload is a starter quality gate, not a universal benchmark:

```bash
timeout 1800s bun run benchmark:assert:cx23:1b
timeout 1800s bun run benchmark:assert:8gb:1b
timeout 3600s bun run benchmark:1b:prompt-formats
timeout 7200s bun run autotune:1b
```

For a different product, keep the benchmark harness and replace the workload JSONL with prompts that represent the real application. The important metrics are prompt/cache reuse, queue delay, TTFT, completion tokens per second, and output quality checks that match the product. Autotune caps scheduler sweeps to the 64 closest candidates by default so a small VPS does not spend hours restarting the gateway; use `--autotune-max-candidates <n>` for deeper runs.
