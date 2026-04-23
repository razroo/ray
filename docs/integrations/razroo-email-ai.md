# razroo-email-ai on Hetzner + Ray

This describes a **single-node** setup for **razroo-email-ai**: a **~0.6B Qwen** (finetuned, quantized) behind **llama.cpp** with **Ray** as the HTTP gateway (queue, cache, rate limits, optional auth).

## Target hardware

Typical match: **Hetzner CX23** (2 vCPU, 4 GB RAM) with the defaults in [ray.sub1b.public.json](../../examples/config/ray.sub1b.public.json), or **CAX11** (2 vCPU, 4 GB ARM) with the tighter single-slot defaults in [ray.sub1b.cax11.public.json](../../examples/config/ray.sub1b.cax11.public.json). The example config here tightens queue, cache size, and output limits further for the `razroo-email-ai` workload. The older [ray.vps.json](../../examples/config/ray.vps.json) remains the roomier 3B-style OpenAI-compatible path.

## Example config

Use [ray.hetzner-cx23-qwen0.6b.public.json](../../examples/config/ray.hetzner-cx23-qwen0.6b.public.json) as the starting point for a public VPS. Keep [ray.hetzner-cx23-qwen0.6b.json](../../examples/config/ray.hetzner-cx23-qwen0.6b.json) for local or private-loopback development inside this repo. Copy the public profile to the server (e.g. `/etc/ray/ray.json`) and adjust:

- **`model.adapter.baseUrl`** — where your OpenAI-compatible server listens (often `http://127.0.0.1:8081`).
- **`model.adapter.modelRef`** — must match the model name exposed by llama.cpp (often the GGUF stem or `--model` label you use at startup).
- **`server.port`** — Ray’s listen port; set **`RAY_PORT`** in the environment if you prefer not to edit JSON.
- **`asyncQueue.storageDir`** — durable on-disk queue location. On a real VPS, keep it on persistent local storage such as `/var/lib/ray/async-queue`.
- **`model.adapter.launchProfile.cacheRamMiB`** — pinned prompt-cache RAM budget for llama.cpp. The example sets **`512` MiB** instead of inheriting the upstream `8192` MiB default, which is a better fit for a 4 GB VPS.
- **`auth.apiKeyEnv`** — public profile auth is enabled by default. Populate **`RAY_API_KEYS`** before starting the gateway.

## Local development (this repo)

```bash
pnpm build
pnpm dev:hetzner-email-ai
```

Ensure an OpenAI-compatible backend is up at the URL in `model.adapter` before sending traffic.

## Calling Ray from the app

The gateway exposes:

- `POST /v1/infer` — synchronous inference (JSON body: `input`, optional `system`, `maxTokens`, `temperature`, `topP`, `seed`, `stop`, `responseFormat`, `cache`, `dedupeKey`, `metadata`).
- `POST /v1/jobs` — async durable submission (same inference fields, plus optional `callbackUrl`). Returns `202 Accepted` and a job location.
- `GET /v1/jobs/:id` — durable job state and final result/error.
- `GET /health` — liveness and queue/provider snapshot, plus `asyncQueue` when enabled.
- `GET /v1/config` — non-secret config (sanitized).

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

For longer-running or high-volume work, prefer `POST /v1/jobs` over holding an HTTP connection open. Ray persists the job to disk, processes it in the background, and can `POST` the terminal payload to `callbackUrl` when the work completes.

## llama.cpp on the same VPS

Run the OpenAI-compatible server in a **separate** process (systemd unit or `screen`). For 2 vCPU, common choices are **2 threads** (`-t 2` or equivalent) and a quant that fits RAM (Q4 / IQ4 for 0.6B is usually small). **GPU (`-ngl`)** is optional on these plans; if none, keep layers on CPU. Point Ray’s `baseUrl` at that server’s HTTP bind address.

If you know the main prompt families ahead of time, add `model.adapter.warmupRequests` to the Ray config. That lets boot-time warmup hit the real email prefixes you care about instead of a generic probe, which is a better fit for llama.cpp prefix caching on a single-node box.

The scheduler is now token-aware as well as request-count aware. For this repo, that matters because a few oversized prompts can stall a cheap CPU box even when the raw request count looks small. Keep `scheduler.maxInflightTokens` conservative for 2 vCPU hardware and scale `maxQueuedTokens` to the backlog you are willing to absorb.

## Product note

The razroo-email-ai repository may still document a **deterministic, no-LLM** runtime path. Treat this integration as the **optional inference path** when (or if) the product calls a hosted model through Ray. No change to Ray is required for the deterministic build.

## Operational note

Ray now covers the single-node durable queue itself. If you later want a separate sidecar to batch completed webhooks or replicate jobs off-node, treat that as an operational optimization on top of the current queue, not as a prerequisite for using the async path.
