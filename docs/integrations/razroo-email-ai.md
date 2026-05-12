# razroo-email-ai on Hetzner + Ray

This describes a **single-node** setup for **razroo-email-ai**: a **~0.6B Qwen** (finetuned, quantized) behind **llama.cpp** with **Ray** as the HTTP gateway (queue, cache, rate limits, optional auth).

## Target hardware

Typical match: **2 vCPU / 4 GB RAM** with the defaults in [ray.sub1b.public.json](../../examples/config/ray.sub1b.public.json), or the tighter ARM defaults in [ray.sub1b.cax11.public.json](../../examples/config/ray.sub1b.cax11.public.json). For better instruction following on the email workload, use the portable [ray.1b.generic.public.json](../../examples/config/ray.1b.generic.public.json) on a 4 GB VPS, or [ray.1b.8gb.generic.public.json](../../examples/config/ray.1b.8gb.generic.public.json) when an 8 GB node is available. The Qwen/Hetzner configs remain benchmark baselines for this integration, while the generic profiles are the default starting point for other 1B models and VPS providers. The older [ray.vps.json](../../examples/config/ray.vps.json) remains the roomier 3B-style OpenAI-compatible path.

## Example config

Use [ray.hetzner-cx23-qwen0.6b.public.json](../../examples/config/ray.hetzner-cx23-qwen0.6b.public.json) as the starting point for a public VPS. Keep [ray.hetzner-cx23-qwen0.6b.json](../../examples/config/ray.hetzner-cx23-qwen0.6b.json) for local or private-loopback development inside this repo. Copy the public profile to the server (e.g. `/etc/ray/ray.json`) and adjust:

- **`model.adapter.baseUrl`** — where your OpenAI-compatible server listens (often `http://127.0.0.1:8081`).
- **`model.adapter.modelRef`** — must match the model name exposed by llama.cpp (often the GGUF stem or `--model` label you use at startup).
- **`server.port`** — Ray’s listen port; set **`RAY_PORT`** in the environment if you prefer not to edit JSON.
- **`asyncQueue.storageDir`** — durable on-disk queue location. On a real VPS, keep it on persistent local storage such as `/var/lib/ray/async-queue`.
- **`asyncQueue.maxJobs`**, **`asyncQueue.minFreeStorageMiB`**, and **`asyncQueue.completedTtlMs`** — retained job record budget, free-space floor, and completed-job retention. The public examples cap retained jobs at `1000`, reserve queue storage headroom, and prune completed records after 24 hours so a small VPS does not fill its disk or permanently wedge the async endpoint. Override them with `RAY_ASYNC_QUEUE_MAX_JOBS`, `RAY_ASYNC_QUEUE_MIN_FREE_STORAGE_MIB`, and `RAY_ASYNC_QUEUE_COMPLETED_TTL_MS` in `/etc/ray/ray.env` when a deployment needs a smaller or larger backlog.
- **`model.adapter.launchProfile.cacheRamMiB`** — pinned prompt-cache RAM budget for llama.cpp. The example sets **`512` MiB** instead of inheriting the upstream `8192` MiB default, which is a better fit for a 4 GB VPS.
- **`auth.apiKeyEnv`** — public profile auth is enabled by default. Populate **`RAY_API_KEYS`** before starting the gateway.

For the portable 1B path, use [ray.1b.generic.public.json](../../examples/config/ray.1b.generic.public.json) or [ray.1b.8gb.generic.public.json](../../examples/config/ray.1b.8gb.generic.public.json). Set `RAY_MODEL_ID`, `RAY_MODEL_REF`, `RAY_MODEL_PATH`, and the `RAY_LLAMA_CPP_*` sizing overrides in `/etc/ray/ray.env` for the actual model and VPS. The Qwen-specific profiles switch the default GGUF path to `qwen2.5-1.5b-instruct-q4_k_m.gguf` and exist to make the checked-in benchmark baselines reproducible.

For below-1B split-role experiments, use [ray.sub1b.classifier.json](../../examples/config/ray.sub1b.classifier.json) for short JSON/classification traffic and [ray.sub1b.drafter.json](../../examples/config/ray.sub1b.drafter.json) for draft generation. These stay on the 0.5B-class GGUF path but use different output caps, warmups, and scheduler pressure limits.

## Local development (this repo)

```bash
bun run build
bun run dev:hetzner-email-ai
```

Ensure an OpenAI-compatible backend is up at the URL in `model.adapter` before sending traffic.

## Calling Ray from the app

The gateway exposes:

- `POST /v1/infer` — synchronous inference (JSON body: `input`, optional `system`, `maxTokens`, `temperature`, `topP`, `seed`, `stop`, `responseFormat`, `cache`, `dedupeKey`, `metadata`).
- `POST /v1/jobs` — async durable submission (same inference fields, plus optional `callbackUrl`). Returns `202 Accepted` and a job location.
- `GET /v1/jobs/:id` — durable job state and final result/error.
- `GET /livez` — lightweight unauthenticated liveness for reverse proxies.
- `GET /readyz` — minimal unauthenticated readiness that checks backend/runtime health without exposing provider details.
- `GET /health` — detailed queue/provider snapshot, detected backend capabilities (`applyTemplate`, `chatTemplate`, `jsonMode`, context window, slots), plus `asyncQueue` when enabled. Public profiles require Bearer auth.
- `GET /v1/config` — non-secret config (sanitized) with capability hints for the configured model/profile. Public profiles require Bearer auth.

With the public profile, a minimal `curl` check is:

```bash
curl -sS http://127.0.0.1:3000/v1/infer \
  -H 'authorization: Bearer replace-with-real-key' \
  -H 'content-type: application/json' \
  -d '{"input":"Hello"}'
```

If you use the local profile for private-only development, auth stays disabled there for convenience.

For `razroo-email-ai`, pass a deterministic `seed` per lead or per variant. That preserves the repo's current "stable for the same lead, different across leads" inference behavior instead of collapsing every repeated prompt onto the same sampling path.

Use `stop` for hard section boundaries when you know the completion should terminate on a fixed delimiter, and `responseFormat: { "type": "json_object" }` for classification-style calls that need structured output from llama.cpp.

If `razroo-email-ai` checks availability before sending inference, point a process-only check at `GET /livez` or a backend-aware check at `GET /readyz`. Public Ray profiles intentionally protect detailed `/health` with Bearer auth, while `/livez` and `/readyz` stay minimal and unauthenticated for health checks. The gateway starts listening before provider warmup finishes, so callers that need usable inference should prefer `/readyz` over process liveness alone.

Benchmark the 1B email path with:

```bash
bun run benchmark:assert:cx23:1b
bun run benchmark:assert:8gb:1b
bun run benchmark:1b:prompt-formats
bun run autotune:1b
```

The workload in [email-1b-workload.jsonl](../../examples/workloads/email-1b-workload.jsonl) exercises cold outreach, follow-up, reply classification, reply rewrite, and a direct section-generation prompt shaped like the app's product flow. It asserts JSON validity for classification and rejects common prompt echo, stop-token leakage, and generic email filler. Benchmark runs can append JSONL history under `.ray/benchmarks/history` so prompt/config changes can be compared over time.

[email-prompt-families-1b.json](../../examples/evals/email-prompt-families-1b.json) is the smaller golden eval set for prompt wording changes. Run it with `bun run eval:prompt-families:1b` against a live Ray gateway. The output includes provider diagnostics for `promptFormat`, `promptFormatReason`, `modelRef`, `launchPreset`, cached tokens, slot reuse, and context window.

For longer-running or high-volume work, prefer `POST /v1/jobs` over holding an HTTP connection open. Ray persists the job to disk, processes it in the background, and can `POST` the terminal payload to `callbackUrl` when the work completes. Completed jobs stay queryable until `asyncQueue.completedTtlMs` expires, while pending callbacks are preserved until delivery succeeds or callback attempts are exhausted. Callback URLs must resolve to global public network addresses by default; private, local, benchmark, documentation, multicast, and other special-use ranges are rejected unless the async queue allowlist explicitly trusts the callback host. Doctor warns when a config enables the global private-network callback bypass or callback host allowlist, so public VPS operators see that trust boundary before deploying. When a callback allowlist is required, use exact host/IP literals such as `callback.example.com` or `127.0.0.1`, or wildcard DNS suffix patterns such as `*.example.com`; full URLs and `host:port` entries are rejected.

## llama.cpp on the same VPS

Run the OpenAI-compatible server in a **separate** process (systemd unit or `screen`). For 2 vCPU, common choices are **2 threads** (`-t 2` or equivalent) and a quant that fits RAM (Q4 / IQ4 for 0.6B is usually small). **GPU (`-ngl`)** is optional on these plans; if none, keep layers on CPU. Point Ray’s `baseUrl` at that server’s HTTP bind address.

If you know the main prompt families ahead of time, add `model.adapter.warmupRequests` to the Ray config. That lets boot-time warmup hit the real email prefixes you care about instead of a generic probe, which is a better fit for llama.cpp prefix caching on a single-node box.

The scheduler is now token-aware as well as request-count aware. For this repo, that matters because a few oversized prompts can stall a cheap CPU box even when the raw request count looks small. Keep `scheduler.maxInflightTokens` conservative for 2 vCPU hardware and scale `maxQueuedTokens` to the backlog you are willing to absorb.

## Product note

The razroo-email-ai repository may still document a **deterministic, no-LLM** runtime path. Treat this integration as the **optional inference path** when (or if) the product calls a hosted model through Ray. No change to Ray is required for the deterministic build.

## Operational note

Ray now covers the single-node durable queue itself. If you later want a separate sidecar to batch completed webhooks or replicate jobs off-node, treat that as an operational optimization on top of the current queue, not as a prerequisite for using the async path.
