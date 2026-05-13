# ray

> Shrink AI to run on cheap VPS infrastructure.

`ray` is an open-source monorepo for a lean AI hosting runtime aimed at the machines most builders can actually afford.

The premise is simple: a lot of inference stacks assume GPUs, clusters, sidecars, dashboards, and operational overhead that make sense once scale is already solved. Most builders do not start there. They start with one box, one model, one budget, and a need to ship.

`ray` exists to compress the infrastructure burden of hosting intelligence:

- single-node first
- quantized-model friendly
- low-memory runtime surface
- fast cold-start expectations
- simple deployment on commodity VPS hardware
- minimal operational drag

This is a sister monorepo to [`iso`](https://github.com/razroo/iso).

- `iso` is the broader sovereignty, runtime, and environment layer.
- `ray` is the AI serving layer that shrinks model hosting down to something a cheap VPS can plausibly carry.

The name is literal: this is the shrink ray for AI infrastructure.

Ray is not trying to be the best general-purpose LLM gateway in TypeScript.

It is trying to be the best runtime for this narrower job:

- run small, quantized models on cheap VPS hardware
- sit in front of local backends such as `llama.cpp`
- stay predictable under memory pressure
- keep the deploy story boring enough for one operator to own

## What Ray Is

Ray is a lightweight inference gateway/runtime built around a few hard constraints:

- the first deployment target is a cheap VPS, not a cluster
- the first model target is small and medium open models, not giant multi-GPU serving
- local development and production should feel nearly identical
- the runtime should stay thin while model backends remain swappable

Phase 1 is intentionally adapter-driven. Ray does not try to embed heavyweight inference kernels into the gateway process. Instead, it provides the control plane that small-model hosting actually needs on day one:

- a simple inference API
- configuration profiles for tiny, sub1b, 1b, VPS, and balanced setups
- backend-aware health and readiness checks
- request scheduling and backpressure
- prompt/result caching
- request deduplication
- graceful degradation under tight hardware constraints
- Bearer API key auth for inference and detailed operational routes
- fixed-window rate limiting
- JSON logging and lightweight metrics
- deployment scaffolding for a single VPS

That keeps the Ray process lean while letting builders pair it with lightweight local backends such as `llama.cpp` speaking an OpenAI-compatible API.

## Where Ray Competes

Ray does not win by supporting the most providers, the most enterprise integrations, or the broadest AI application surface.

Ray should win on a different axis:

- better defaults for one-box, self-hosted inference
- better behavior on low-RAM commodity VPS machines
- better handling of local backend reality such as quantized models and `llama.cpp`-style servers
- better operational simplicity for solo builders and small teams

If you need a broad multi-provider gateway, there are stronger projects for that job.

If you need a lean runtime that helps one cheap machine host useful intelligence without turning into platform engineering work, that is the slot Ray is built for.

## Why It Exists

Cheap VPS AI hosting matters because it changes who can deploy intelligence.

If every useful inference stack assumes oversized infrastructure, then self-hosting stays expensive, brittle, and operationally exclusive. Ray is built to make the opposite path credible:

- a solo builder can run it
- a small team can maintain it
- the production story does not demand platform engineering first
- sovereignty does not require enterprise complexity

## What Ray Is Not

Ray is not trying to become:

- Kubernetes for LLMs
- a giant distributed inference control plane on day one
- a universal SDK for every hosted model provider
- another UI-first wrapper around existing hosted APIs
- an enterprise observability bundle with AI branding

Ray is trying to be the smallest credible runtime layer for self-hosted AI inference.

That means some features are deliberately not the priority in the first versions:

- huge provider matrices
- SaaS-first routing abstractions
- broad tool-calling frameworks
- agent orchestration
- generalized enterprise control-plane features

## Stack choice

The stack is intentionally pragmatic:

- **Bun** workspace (Bun **1.3+**, Node **20.11+** per `engines`; GitHub Actions runs the gate under Node 20 and Node 22 for CI parity)
- TypeScript with a project reference build (`bun run build` / `bun run typecheck`)
- Bare `http` gateway — no mandatory web framework on the hot path
- ESLint + Prettier + Changesets at the repo root

Adapter-based providers keep inference outside the gateway process where possible; heavier cores can land later without rewriting the whole product boundary.

## Monorepo layout

```text
apps/
  gateway/
  control-panel/        # deferred workspace placeholder (no UI yet)
packages/
  core/                 # shared types (published as @razroo/ray-core)
  runtime/
  models/
  scheduler/
  cache/
  deploy/
  config/
  telemetry/
  sdk/                  # HTTP client (published as @razroo/ray-sdk)
.changeset/             # Changesets config + pending release notes
docs/
examples/
scripts/
```

## MVP scope

The scaffold targets a credible first version:

- `apps/gateway`: HTTP inference gateway with `/v1/infer`, `/v1/jobs`, `/livez`, `/readyz`, `/health`, `/metrics`, and `/v1/config`
- `packages/runtime`: request normalization, degradation policy, cache integration, and provider orchestration
- `packages/models`: provider abstraction with `mock` and `openai-compatible` adapters
- `packages/scheduler`: lightweight queueing, token-aware admission, concurrency limits, and in-flight deduplication
- `packages/cache`: byte- and entry-bounded TTL cache for prompt/result reuse
- `packages/config`: profile defaults and JSON config loading
- `packages/telemetry`: JSON logger and lightweight in-memory metrics
- `packages/deploy`: systemd and Caddy scaffolding for cheap VPS deployment
- `packages/sdk`: minimal TypeScript client (`RayClient`), published as **`@razroo/ray-sdk`**

Deliberate omissions in the MVP:

- no attempt to be a universal provider switchboard
- no heavy tracing stack in the hot path
- no cluster scheduler
- no database requirement
- no mandatory control plane

## Quick start

### Install

```bash
bun install
```

### Run locally (tiny profile — mock provider)

No external model server required:

```bash
bun run dev:tiny
```

In another terminal:

```bash
curl -fsS --connect-timeout 2 --max-time 30 http://127.0.0.1:3000/v1/infer \
  -H 'content-type: application/json' \
  -d '{"input":"Explain why cheap VPS inference matters."}'
```

Async durable queue on the same gateway:

```bash
curl -fsS --connect-timeout 2 --max-time 30 http://127.0.0.1:3000/v1/jobs \
  -H 'content-type: application/json' \
  -d '{"input":"Draft a follow-up email body."}'
```

The durable queue caps retained job records with `asyncQueue.maxJobs`, rejects new jobs when free queue storage falls below `asyncQueue.minFreeStorageMiB`, and prunes completed jobs after `asyncQueue.completedTtlMs`, while pending callbacks remain protected until delivery succeeds or callback attempts are exhausted. Deploy doctor warns when `asyncQueue.maxJobs` can retain more persisted job data than the configured storage reserve, so a cheap VPS does not silently trade disk headroom for durable-job capacity. Add `callbackUrl` only for an endpoint you control. Job and callback retry counts are capped at 100, crash-recovered callbacks with exhausted attempts are marked failed, callback failure text is truncated before persistence so a bad endpoint cannot bloat the on-disk job store, and malformed recovered records are pruned after logging so restart scans do not keep paying for corrupted files.

Gateway startup binds the HTTP listener before provider warmup finishes, so `/livez` can keep systemd and reverse proxies pointed at the running process while `/readyz` returns 503 until the provider is available and warmed, then reports backend-aware readiness with provider status, queue depth, in-flight requests, pressure booleans, and non-secret reason codes for provider, queue, provider-preparation, memory, CPU, and async-queue degradation. JSON POST endpoints require `application/json` or `application/*+json` before reading request bodies, queue-full, async-storage, and timeout backpressure responses include `Retry-After`, and expected parser, client, queue, and timeout rejections log as warning-level events without stacks, so clients can back off instead of retrying into a saturated VPS while logs stay focused on unexpected failures. Gateway HTTP sockets also cap total header bytes, header count, keep-alive churn, and concurrent connections before application admission, giving cheap nodes a fixed resource ceiling under noisy clients. If the first warmup attempt races a still-booting backend, the gateway retries warmup in the background until it succeeds or the process is stopped. On shutdown the gateway stops accepting new HTTP sockets and force-closes lingering active connections after 30 seconds, leaving the generated `TimeoutStopSec=35` unit enough room to restart cleanly even when a slow client is stuck.

### Build

```bash
bun run build
```

### Default cheap-VPS profile (sub-1B llama.cpp backend)

Expects a local `llama.cpp` server on `127.0.0.1:8081` (see [ray.sub1b.json](examples/config/ray.sub1b.json)). The default sub-1B path is tuned for a CX23-class 2 vCPU / 4 GB x86 VPS; use [ray.sub1b.cax11.json](examples/config/ray.sub1b.cax11.json) for the ARM CAX11 variant.

```bash
bun run start
```

For the roomier 3B-style OpenAI-compatible profile, use `bun run start:vps`.

### Portable 1B llama.cpp profiles

Use the 1B profile when the product needs better instruction following than the sub-1B default and can tolerate lower throughput on the same cheap-VPS class. Ray's 1B support is intended to be model-family and VPS-provider agnostic: pick a machine class, point Ray at a local GGUF/model backend, then tune context, slots, cache RAM, and scheduler budgets to the actual box.

The generic starting points are [ray.1b.generic.json](examples/config/ray.1b.generic.json) for a conservative 4 GB single-slot VPS and [ray.1b.8gb.generic.json](examples/config/ray.1b.8gb.generic.json) for an 8 GB two-slot node. Use `RAY_PROFILE=1b-8gb` when selecting the roomier 8 GB defaults through environment-only config. The Qwen/Hetzner configs remain checked-in reference baselines, not the product boundary.

```bash
bun run start:1b:generic
bun run start:1b:8gb:generic
```

Common portable deploy and model overrides can live in `/etc/ray/ray.env`, so operators do not need to fork JSON for every 1B model:

```dotenv
RAY_DEPLOY_SERVICE_USER=ray
RAY_DEPLOY_DOMAIN=ray.local
RAY_DEPLOY_MEMORY_MIB=4096
RAY_DEPLOY_MIN_FREE_STORAGE_MIB=1024
RAY_DEPLOY_READY_TIMEOUT_SECONDS=120
RAY_GATEWAY_RUNTIME_BINARY=/usr/local/bin/bun
RAY_DEPLOY_CADDY_BINARY=/usr/bin/caddy
RAY_MODEL_ID=local-1b-q4
RAY_MODEL_REF=local-1b-q4
RAY_MODEL_FAMILY=llama-compatible
RAY_MODEL_QUANTIZATION=q4_k_m
RAY_MODEL_WARM_ON_BOOT=true
RAY_MODEL_PATH=/var/lib/ray/models/local-1b-q4.gguf
RAY_LLAMA_CPP_BINARY_PATH=/usr/local/bin/llama-server
RAY_LLAMA_CPP_CTX_SIZE=2048
RAY_LLAMA_CPP_PARALLEL=1
RAY_LLAMA_CPP_THREADS=2
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
RAY_ASYNC_QUEUE_ENABLED=true
RAY_DEGRADATION_MEMORY_RSS_THRESHOLD_MIB=512
RAY_DEGRADATION_MEMORY_CGROUP_PRESSURE_RATIO_THRESHOLD=0.9
RAY_DEGRADATION_CPU_THROTTLED_RATIO_THRESHOLD=0.2
RAY_DEGRADATION_MEMORY_PSI_SOME_AVG10_THRESHOLD=10
RAY_DEGRADATION_MEMORY_PSI_FULL_AVG10_THRESHOLD=1
RAY_DEGRADATION_CPU_PSI_SOME_AVG10_THRESHOLD=50
RAY_DEGRADATION_CPU_PSI_FULL_AVG10_THRESHOLD=5
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
RAY_ASYNC_QUEUE_MAX_JOBS=128
RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB=256
RAY_ASYNC_QUEUE_COMPLETED_TTL_MS=86400000
RAY_ASYNC_QUEUE_CALLBACK_ALLOWED_HOSTS=callback.example,*.trusted.example
RAY_AUTH_ENABLED=true
RAY_AUTH_API_KEY_ENV=RAY_API_KEYS
RAY_RATE_LIMIT_ENABLED=true
RAY_RATE_LIMIT_WINDOW_MS=60000
RAY_RATE_LIMIT_MAX_REQUESTS=75
RAY_RATE_LIMIT_MAX_KEYS=4096
RAY_RATE_LIMIT_KEY_STRATEGY=ip+api-key
```

`RAY_DEPLOY_SERVICE_USER`, `RAY_DEPLOY_DOMAIN`, `RAY_DEPLOY_MEMORY_MIB`,
`RAY_GATEWAY_RUNTIME_BINARY`, and `RAY_DEPLOY_CADDY_BINARY` are consumed by the
deploy CLI while rendering units or running doctor. Explicit CLI flags win over
env-file values. `RAY_DEPLOY_SERVICE_USER` accepts an account name or numeric
UID; workflow deploys create missing named accounts, while numeric UIDs must
already resolve to an account on the VPS.
The GitHub VPS workflow also honors `RAY_DEPLOY_DOMAIN`,
`RAY_DEPLOY_INSTALL_CADDY`, `RAY_DEPLOY_MEMORY_MIB`,
`RAY_DEPLOY_MIN_FREE_STORAGE_MIB`, `RAY_DEPLOY_READY_TIMEOUT_SECONDS`,
`RAY_DEPLOY_SERVICE_USER`, `RAY_GATEWAY_RUNTIME_BINARY`, and
`RAY_DEPLOY_CADDY_BINARY` from
`RAY_ENV_FILE_CONTENTS` before repository variables when wiring remote
prerequisites, storage preflight, doctor, render, readiness waits, and generated
service commands.
When no explicit deploy memory override is set, render, doctor, and model
staging use `model.operational.memoryClassMiB` before falling back to the
launch-profile preset, while still clamping to lower detected host RAM.
When those CLI-consumed settings come from repository variables instead, the
workflow appends the resolved non-secret values to `/etc/ray/ray.env` when they
are absent so later manual `doctor`, `render`, and `model:stage` runs read the
same service user, domain, memory target, storage cushion, readiness timeout,
and runtime paths.
Set `RAY_DEPLOY_MIN_FREE_STORAGE_MIB` when the workflow or manual
`bun run deploy:storage -- --ray-env-file /etc/ray/ray.env` check should require
more or less than the default 1024 MiB free on the root, checkout, Ray state,
`/tmp`, `/var/tmp`, and repo-scoped Bun install-cache volumes before package
bootstrap, rsync follow-up, or the remote Bun production install. Set it to `0`
only when you intentionally want to skip that preflight.

Create `/var/lib/ray/models` on the VPS and put the GGUF at `RAY_MODEL_PATH`
before starting the generated llama.cpp service or running doctor.

Use `bun run model:stage -- --config ./examples/config/ray.1b.generic.public.json --ray-env-file /etc/ray/ray.env --binary-source ./llama-server --source ./local-1b-q4.gguf`
to print the exact install, ownership, optional checksum, target storage-headroom,
GGUF header, and service-user read/execute plus `llama-server --help` startup
and generated launch-flag support checks for the resolved `llama-server` and
`RAY_MODEL_PATH`.
Printed install commands copy through same-directory `.ray-stage-*` temp files
and only move them into place after the temp artifact passes service-user checks,
so an interrupted copy does not overwrite the last working binary or GGUF.
Instead of passing source and checksum flags every time, `/etc/ray/ray.env` may
include `RAY_LLAMA_CPP_BINARY_SOURCE_PATH`, `RAY_LLAMA_CPP_BINARY_SHA256`,
`RAY_MODEL_SOURCE_PATH`, and `RAY_MODEL_SHA256`; explicit CLI flags still win.
Use `--commands-only` when you want reviewed shell commands without the
explanatory staging summary.
Use `--check-sources` to fail early when the local `llama-server` or GGUF source
path is missing, unreadable, not executable, fails the `llama-server --help`
startup probe, lacks generated launch-flag support, lacks a GGUF header, or does
not match a provided checksum before reviewing the plan.
Use `--apply` on the VPS after reviewing those source paths to verify and copy
the artifacts into the resolved binary and model locations with the generated
service ownership, then run the staged `llama-server --help` and launch-flag
support probe as that service identity. Apply checks that the model source has a
GGUF header and that the target model filesystem can hold the GGUF source while
keeping a 256 MiB post-copy reserve, then verifies that the generated service
identity can read the installed GGUF.

Deployment walkthrough: [examples/deploy/vps/README.md](examples/deploy/vps/README.md).

The repo also includes an opt-in GitHub Actions VPS deploy workflow for the
gateway itself: [.github/workflows/deploy-vps.yml](.github/workflows/deploy-vps.yml).
That workflow is generic and only uses repository secrets/variables supplied by
the operator.

### Render / validate / doctor

```bash
bun packages/deploy/dist/cli.js --help
bun run render:service
bun run render:service:cax11
bun run render:service:hetzner-email-ai
bun run render:service:1b
bun run render:service:1b:generic
bun run render:service:1b:8gb
bun run render:service:1b:8gb:generic
bun run render:service:vps
bun run validate:config
bun run validate:config:all
bun run validate:config:vps
bun run deploy:storage
bun run deploy:smoke
bun run smoke:tiny
bun run smoke:tiny:public
bun run smoke:tiny:async
bun run smoke:tiny:public-async
bun run deploy:scripts
bun run package:runtime
bun run docs:links
bun run model:stage:smoke
bun run model:stage
bun run model:stage:cax11
bun run model:stage:1b
bun run model:stage:1b:generic
bun run model:stage:1b:8gb
bun run model:stage:1b:8gb:generic
bun run model:stage:hetzner-email-ai
bun run swap:plan
bun run doctor
bun run doctor:cax11
bun run doctor:hetzner-email-ai
bun run doctor:1b
bun run doctor:1b:generic
bun run doctor:1b:8gb
bun run doctor:1b:8gb:generic
bun run doctor:vps
```

`bun run render:service*` prints deployable systemd/Caddy output with `EnvironmentFile=/etc/ray/ray.env` already wired into the gateway unit and does not require local secret material. Use `--ray-env-file` only when the env file exists and render should load its values. `bun run validate:config:all` scans every checked-in example config and prints compact warning/error counts; run `bun ./scripts/validate-configs.ts --verbose` when warning details are needed. `bun run deploy:storage` checks free storage on the checkout, repo-scoped Bun install cache, Ray state, `/tmp`, and `/var/tmp` volumes before manual VPS install work consumes disk; it honors `RAY_DEPLOY_MIN_FREE_STORAGE_MIB` and defaults to 1024 MiB. `bun run deploy:smoke` dry-renders every public deploy profile plus the roomier `ray.vps.json` OpenAI-compatible profile into systemd/Caddy bundles without loading local secrets, so config changes can be checked before touching a VPS. `bun run smoke:tiny` starts the tiny mock-provider gateway on an ephemeral loopback port and verifies `/livez`, `/readyz`, and `/v1/infer` without an external model server; `bun run smoke:tiny:public` repeats that path with auth and rate limiting enabled, verifies unauthenticated liveness/readiness, rejects missing and invalid API keys on protected routes including `/v1/jobs`, accepts a valid key, and proves repeated inference is rate limited; `bun run smoke:tiny:async` enables the durable queue with a temp storage dir and verifies `/v1/jobs` submission plus status polling through successful completion; `bun run smoke:tiny:public-async` enables auth, rate limiting, and the durable queue together, rejects missing and invalid job API keys, and verifies authenticated `/v1/jobs` submission plus status polling through successful completion. `bun run deploy:scripts` verifies that every public llama.cpp deploy profile has package aliases for validate, render, doctor, and model staging, and that the roomier `ray.vps.json` OpenAI-compatible profile has validate, render, and doctor aliases. `bun run package:runtime` verifies that package manifests, GitHub workflow commands, README examples, integration docs, release docs, and deployment docs stay Bun-first and do not drift back to pnpm/yarn/npm-run scripts or non-Bun lockfiles; `npm publish` remains allowed in release workflows. `bun run docs:links` verifies checked-in Markdown local links so operator docs do not point at missing configs, workflows, or walkthroughs. `bun run model:stage:smoke` dry-renders llama.cpp binary and GGUF staging plans for every public deploy profile without loading local secrets. `bun run model:stage*` reads the same config and optional `/etc/ray/ray.env` overrides, including staging source/checksum variables, then prints the concrete timeout-bounded `llama-server` install, GGUF install, ownership, checksum, generated backend `MemoryMax` memory-fit and storage-headroom checks before either target is replaced, source GGUF header check, service-user read/execute-test, binary startup-probe commands, and generated launch-flag support checks for the generated llama.cpp service. `bun run swap:plan` prints guarded, timeout-bounded commands for adding the 1 GiB swap cushion that 4 GB llama.cpp VPS profiles expect, first checks that the swap parent filesystem can still retain the configured free-space cushion after creation, and persists a conservative `vm.swappiness=10` setting by default; use `bun run swap:plan -- --min-free-after-mib 1024` to preserve more disk headroom, or `bun run swap:plan -- --sysctl-only --swappiness 10` when doctor only needs the swappiness setting corrected on a host that already has swap. `bun run doctor` targets the public CX23-class `sub1b` deploy profile. `bun run render:service:cax11`, `bun run model:stage:cax11`, and `bun run doctor:cax11` target the public ARM CAX11 `sub1b` deploy profile. `bun run render:service:hetzner-email-ai`, `bun run model:stage:hetzner-email-ai`, and `bun run doctor:hetzner-email-ai` target the public razroo-email-ai Hetzner CX23/Qwen 0.6B profile with a 4 GB memory budget. The 1B render, model staging, and doctor commands target both Qwen reference and portable generic public 1B deploy profiles with explicit 4 GB and 8 GB memory budgets; `render:service:vps`, `validate:config:vps`, and `doctor:vps` target the roomier `ray.vps.json` OpenAI-compatible profile. Run doctor on the VPS after the GGUF exists at the configured path and `/etc/ray/ray.env` is populated. Doctor also verifies that the host is booted with systemd, has `systemctl`, and accepts the generated unit files through `systemd-analyze verify`, Caddy is installed and accepts the generated Caddyfile for the reverse proxy (`caddy` on `PATH`, `RAY_DEPLOY_CADDY_BINARY`, or `--caddy-binary`), the generated systemd service user, service-user access to the rendered config file, Bun runtime (`/usr/local/bin/bun` by default, `RAY_GATEWAY_RUNTIME_BINARY`, or `--gateway-runtime-binary`) including service-user-scoped Bun/Node version compatibility, WorkingDirectory access and free-space headroom for the synced checkout and Bun production install, built gateway entrypoint plus configured-runtime importability, configured `llama-server` binary service-user startup and generated launch-flag support, adapter base URL targeting, generated gateway/backend port separation, IP rate-limit proxy-header posture for Caddy-backed deploys, gateway cache, rate-limit key, and scheduler token-buffer budgets against generated `MemoryMax`, scheduler concurrency against detected host vCPUs, deploy memory overrides against detected host RAM, GGUF model file presence and header, and async queue storage, env-file permissions, host CPU architecture for architecture-specific sub-1B profiles, host CPU/thread headroom, async queue storage headroom, small-VPS swap cushion and currently free swap, host swappiness, and whether generated gateway or llama.cpp service paths sit under `/home`, `/root`, `/run/user`, `/tmp`, or `/var/tmp` where `ProtectHome=true` or `PrivateTmp=true` would hide them. The GitHub deploy workflow only changes ownership on the checkout root, sets service-readable checkout modes during rsync, prunes stale `node_modules` under a timeout, pins the remote Bun install cache under `/srv/ray/.ray/bun-install-cache`, and runs the remote Bun production install with `umask 022` so old dev dependencies and home-directory cache growth do not accumulate even when ownership changed, and deploys do not recursively chown or chmod the synced repository.

### Benchmark Contract

On a real Hetzner box, the benchmark script can now emit structured JSON and assert against checked-in baselines:

```bash
bun run benchmark:assert:cx23
bun run benchmark:assert:cax11
bun run benchmark:assert:cx23:1b
bun run benchmark:assert:8gb:1b
bun run benchmark:1b:prompt-formats
```

Those commands write the latest report to `.ray/benchmarks/`, append JSONL history when configured, and compare the run against the baseline JSON in `examples/benchmarks/baselines/`. Autotune keeps scheduler sweeps to the 64 closest candidates by default on small VPS hardware; pass `--autotune-max-candidates <n>` when a longer run is worth the extra gateway restarts. Full autotune starts `llama-server` with the same first-class launch-profile flags rendered into the generated systemd unit, so backend candidates are measured with the same bind, model, context, batching, thread, cache, slot, metrics, and warmup settings used in deployment. The 1B workload also checks scored output quality signals such as JSON validity, prompt echo, stop-token leakage, call-to-action presence, forbidden wrappers, and generic email filler.

For prompt-family quality checks across cold outreach, follow-up, classification, rewrite, and section generation:

```bash
bun run eval:prompt-families:1b
```

The structured benchmark output includes provider diagnostics such as prompt format, request shape, model ref, launch preset, slot reuse, cached tokens, JSON repair attempts, and context window so a quality regression can be tied back to the backend path Ray chose. `/readyz` stays unauthenticated but only returns minimal readiness fields and reason codes; `/health` exposes detected backend capabilities plus runtime queue, token, and provider-preparation saturation ratios, durable async-queue pressure, process RSS pressure ratio, Linux PSI memory/CPU stall signals, cgroup CPU quota and throttling, cgroup memory/swap gauges and event counters, CPU and memory pressure diagnostics, and whether pressure is causing graceful output clamps. `/metrics` refreshes live preparation, queue, cache, async-job saturation, async storage headroom, gateway HTTP socket saturation, gateway warmup retry, process RSS headroom, Linux PSI pressure, cgroup CPU pressure, cgroup memory/swap pressure ratios, cgroup swap pressure thresholds, and cgroup resource gauges before responding, and `/v1/config` includes sanitized capability hints for the configured profile.

### Quality gate (matches CI)

Same command **[Quality checks](.github/workflows/quality.yml)** runs on **`main`** under Node 20 and Node 22:

```bash
bun run release:gate
bun run release:check-source -- <version>
```

`release:gate` runs lint, Prettier `--check`, tests (`bun run test` builds, runs the compiled Tap suite, then runs script tests with Bun), all checked-in config validation, auth-backed public config validation, automated tiny gateway inference (`bun run smoke:tiny`), public safety (`bun run smoke:tiny:public`), async queue (`bun run smoke:tiny:async`), and public async queue (`bun run smoke:tiny:public-async`) smokes, deploy bundle smoke rendering for public profiles plus `ray.vps.json`, public model staging smoke rendering, deploy package-script coverage, Bun-first package, workflow, runtime-doc coverage, Markdown local-link validation, and Bun pack smoke checks for the public packages. `release:check-source` verifies the linked publishable package manifests match the release tag before npm workflows publish.

## Example config profiles

- [examples/config/ray.tiny.json](examples/config/ray.tiny.json) — mock provider; boots immediately
- [examples/config/ray.sub1b.json](examples/config/ray.sub1b.json) — default private/local sub-1B `llama.cpp` profile for CX23-class x86 boxes
- [examples/config/ray.sub1b.public.json](examples/config/ray.sub1b.public.json) — public-safe CX23-class sub-1B `llama.cpp` profile with auth enabled and bounded cache RAM
- [examples/config/ray.sub1b.cax11.json](examples/config/ray.sub1b.cax11.json) — private/local CAX11-class ARM variant with tighter queue and single-slot defaults; use `RAY_PROFILE=sub1b-cax11` for env-only profile selection
- [examples/config/ray.sub1b.cax11.public.json](examples/config/ray.sub1b.cax11.public.json) — public-safe CAX11-class ARM variant
- [examples/config/ray.sub1b.classifier.json](examples/config/ray.sub1b.classifier.json) — below-1B classifier-oriented profile with shorter outputs, JSON-mode warmup, and tighter context
- [examples/config/ray.sub1b.drafter.json](examples/config/ray.sub1b.drafter.json) — below-1B email drafting profile with warmer prompt-family defaults
- [examples/config/ray.1b.generic.json](examples/config/ray.1b.generic.json) — portable private/local 1B-class `llama.cpp` profile for generic 4 GB VPS boxes
- [examples/config/ray.1b.generic.public.json](examples/config/ray.1b.generic.public.json) — public-safe generic 4 GB 1B-class profile with auth and async queue enabled
- [examples/config/ray.1b.8gb.generic.json](examples/config/ray.1b.8gb.generic.json) — portable private/local 1B-class profile for generic 8 GB VPS boxes
- [examples/config/ray.1b.8gb.generic.public.json](examples/config/ray.1b.8gb.generic.public.json) — public-safe generic 8 GB 1B-class profile
- [examples/config/ray.1b.json](examples/config/ray.1b.json) — private/local 1B-class `llama.cpp` profile for 4 GB CX23-class boxes
- [examples/config/ray.1b.public.json](examples/config/ray.1b.public.json) — public-safe 4 GB 1B-class profile with auth and async queue enabled
- [examples/config/ray.1b.8gb.json](examples/config/ray.1b.8gb.json) — private/local 1B-class profile for 8 GB single-node boxes
- [examples/config/ray.1b.8gb.public.json](examples/config/ray.1b.8gb.public.json) — public-safe 8 GB 1B-class profile
- [examples/config/ray.vps.json](examples/config/ray.vps.json) — roomier single-node profile for a local OpenAI-compatible 3B-style backend
- [examples/config/ray.balanced.json](examples/config/ray.balanced.json) — slightly roomier single-node defaults
- [examples/config/ray.hetzner-cx23-qwen0.6b.public.json](examples/config/ray.hetzner-cx23-qwen0.6b.public.json) — public-safe Hetzner CX23-class (2 vCPU / 4 GB) deployment profile with auth enabled and llama.cpp cache RAM pinned
- [examples/config/ray.hetzner-cx23-qwen0.6b.json](examples/config/ray.hetzner-cx23-qwen0.6b.json) — local/private Hetzner CX23-class dev profile for the same ~0.6B Qwen workload; see [docs/integrations/razroo-email-ai.md](docs/integrations/razroo-email-ai.md)

## Published npm packages

TypeScript libraries for integrating with the gateway:

| Package                | Role                         |
| ---------------------- | ---------------------------- |
| **`@razroo/ray-core`** | Shared types and errors      |
| **`@razroo/ray-sdk`**  | `RayClient` for the HTTP API |

Install: `bun add @razroo/ray-sdk` (pulls **`@razroo/ray-core`**).

### Versioning and releases

- **Changesets** — [`iso`](https://github.com/razroo/iso)-style workflow: `bun run changeset` on PRs that affect publishable APIs, then `bun run version` on `main` to bump linked packages and **`CHANGELOG.md`** ([`.changeset/config.json`](.changeset/config.json)).
- **GitHub Releases** — tags `core-v…` and `sdk-v…`, then **`gh release create`** (shortcut: **`bun run release:github -- --yes`** after `bun run version` is on `main`); workflows publish with provenance. Details: [docs/npm-publishing.md](docs/npm-publishing.md).
- **Post-publish check** — `bun run release:verify-npm -- <version>` against the npm registry.

### Security and repository hygiene

- Vulnerability reports: [SECURITY.md](SECURITY.md).
- Recommend **branch protection** so `main` requires **Quality checks**: [docs/branch-protection.md](docs/branch-protection.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: keep changes scoped, run **`bun run release:gate`** before pushing, add a **changeset** when **`@razroo/ray-core`** or **`@razroo/ray-sdk`** behavior changes.

## Architecture notes

- [docs/architecture.md](docs/architecture.md)
- [docs/principles.md](docs/principles.md)
- [docs/portable-1b.md](docs/portable-1b.md)
- [docs/roadmap.md](docs/roadmap.md)

Release smoke checklist: [docs/release-checklist.md](docs/release-checklist.md).

## What comes next

The roadmap is staged:

1. Single-node VPS inference runtime
2. Better model optimization and cache behavior
3. Multi-model routing and smarter scheduling
4. Distributed or edge-aware deployment
5. Deeper integration with `iso`

The order matters. Ray should get very good at one cheap box before it tries to orchestrate many.
