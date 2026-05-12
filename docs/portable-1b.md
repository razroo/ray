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

Keep model-specific values in `/etc/ray/ray.env` when possible:

```dotenv
RAY_API_KEYS=replace-with-comma-separated-client-api-keys
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_MODEL_TIMEOUT_MS=28000
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
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
RAY_SCHEDULER_CONCURRENCY=1
RAY_SCHEDULER_MAX_QUEUE=40
RAY_SCHEDULER_MAX_QUEUED_TOKENS=18000
RAY_SCHEDULER_MAX_INFLIGHT_TOKENS=2560
RAY_SCHEDULER_DEDUPE_INFLIGHT=true
RAY_SCHEDULER_BATCH_WINDOW_MS=5
RAY_SCHEDULER_AFFINITY_LOOKAHEAD=12
RAY_SCHEDULER_SHORT_JOB_MAX_TOKENS=96
RAY_CACHE_ENABLED=true
RAY_CACHE_MAX_ENTRIES=256
RAY_CACHE_TTL_MS=120000
RAY_CACHE_KEY_STRATEGY=input+params
RAY_PROMPT_COMPILER_ENABLED=true
RAY_PROMPT_COMPILER_COLLAPSE_WHITESPACE=true
RAY_PROMPT_COMPILER_DEDUPE_REPEATED_LINES=true
RAY_PROMPT_COMPILER_FAMILY_METADATA_KEYS=promptFamily,taskTemplate,template,useCase
RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=512
RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=0.2
RAY_ASYNC_QUEUE_MAX_JOBS=1000
RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=256
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
```

Create `/var/lib/ray/models` on the VPS and place the GGUF at `RAY_MODEL_PATH`
before starting the generated llama.cpp service or running doctor.

For 8 GB nodes, start by raising context, slots, and cache RAM through the 8 GB generic profile before adding more overrides.

## Validate On The VPS

Run the doctor command on the target machine after the GGUF exists and `/etc/ray/ray.env` is populated:

```bash
bun run doctor:1b:generic
bun run doctor:1b:8gb:generic
```

Doctor checks auth/env readiness, env-file permissions, generated systemd user readiness, service-user access to the rendered config file, Bun runtime (`/usr/local/bin/bun` by default, or `--gateway-runtime-binary`) including identifiable Bun/Node version compatibility, generated WorkingDirectory, built gateway entrypoint, `llama-server` binary, GGUF model file, and async queue storage, launch profile consistency, projected memory fit against the selected memory budget, async queue storage headroom, and swap cushion for the 4 GB llama.cpp profile before the service starts.

## Benchmark The Actual Workload

The checked-in 1B email workload is a starter quality gate, not a universal benchmark:

```bash
bun run benchmark:assert:cx23:1b
bun run benchmark:assert:8gb:1b
bun run benchmark:1b:prompt-formats
bun run autotune:1b
```

For a different product, keep the benchmark harness and replace the workload JSONL with prompts that represent the real application. The important metrics are prompt/cache reuse, queue delay, TTFT, completion tokens per second, and output quality checks that match the product.
