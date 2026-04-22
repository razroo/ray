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
- configuration profiles for tiny, VPS, and balanced setups
- backend-aware health and readiness checks
- request scheduling and backpressure
- prompt/result caching
- request deduplication
- graceful degradation under tight hardware constraints
- Bearer API key auth for inference routes
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

## Stack Choice

The current stack is intentionally pragmatic:

- TypeScript workspace
- Node 20+
- bare `http` server for the gateway
- no required runtime framework dependencies
- adapter-based model provider layer

Why this choice:

- TypeScript keeps iteration speed high for an OSS monorepo.
- Bare Node keeps memory overhead and dependency count low.
- Adapter-based providers let Ray stay lean while backends like `llama.cpp` or other OpenAI-compatible local servers do the heavy inference work.
- The repo is structured so performance-critical pieces can move to Go or native code later without rewriting the product boundary first.

This is a deliberate MVP tradeoff. It optimizes for maintainability, fast iteration, and a credible single-node product surface instead of premature systems maximalism.

## Monorepo Layout

```text
apps/
  gateway/
  control-panel/        # intentionally deferred placeholder
packages/
  core/
  runtime/
  models/
  scheduler/
  cache/
  deploy/
  config/
  telemetry/
  sdk/
docs/
examples/
scripts/
```

## MVP Scope

The current scaffold is aimed at a serious first version:

- `apps/gateway`: HTTP inference gateway with `/v1/infer`, `/health`, `/metrics`, and `/v1/config`
- `packages/runtime`: request normalization, degradation policy, cache integration, and provider orchestration
- `packages/models`: provider abstraction with `mock` and `openai-compatible` adapters
- `packages/scheduler`: lightweight queueing, concurrency limits, and in-flight deduplication
- `packages/cache`: TTL cache for prompt/result reuse
- `packages/config`: profile defaults and JSON config loading
- `packages/telemetry`: JSON logger and lightweight in-memory metrics
- `packages/deploy`: systemd and Caddy scaffolding for cheap VPS deployment
- `packages/sdk`: minimal TypeScript client

Deliberate omissions in the MVP:

- no attempt to be a universal provider switchboard
- no heavy tracing stack in the hot path
- no cluster scheduler
- no database requirement
- no mandatory control plane

## Quick Start

### 1. Install

```bash
pnpm install
```

### 2. Boot the scaffold locally

The default `tiny` profile uses the built-in mock provider so the repo starts without external model infrastructure:

```bash
pnpm dev:tiny
```

In another terminal:

```bash
curl -s http://127.0.0.1:3000/v1/infer \
  -H 'content-type: application/json' \
  -d '{"input":"Explain why cheap VPS inference matters."}'
```

### 3. Build

```bash
pnpm build
```

### 4. Run the VPS profile

The VPS profile expects an OpenAI-compatible local backend on `127.0.0.1:8081`:

```bash
pnpm start
```

See [examples/deploy/vps/README.md](examples/deploy/vps/README.md) for the intended single-node deployment flow.

### 5. Validate the deployment shape

```bash
pnpm validate:config
pnpm doctor
```

## Example Config Profiles

- [examples/config/ray.tiny.json](examples/config/ray.tiny.json): boots immediately with the mock provider
- [examples/config/ray.vps.json](examples/config/ray.vps.json): tuned for a cheap VPS with a local OpenAI-compatible backend
- [examples/config/ray.balanced.json](examples/config/ray.balanced.json): slightly roomier settings for a stronger single node

## npm packages

Library packages published for TypeScript consumers:

- `@ray/core` — shared types and errors used by the gateway and SDK
- `@ray/sdk` — minimal HTTP client for the gateway (`RayClient`)

- **Versioning:** [Changesets](https://github.com/changesets/changesets) on `main` — `pnpm run changeset` in PRs, `pnpm run version` to apply (same idea as **`iso`**; `@ray/core` and `@ray/sdk` are **linked** in [`.changeset/config.json`](.changeset/config.json)).
- **Publish:** Tags `core-v…` / `sdk-v…`, `gh release create`, and **`NPM_TOKEN`** — see [docs/npm-publishing.md](docs/npm-publishing.md).
- **Security:** [SECURITY.md](SECURITY.md).
- **Branch rules:** Prefer [branch protection](docs/branch-protection.md) so **`main`** requires **Quality checks**.
- **CI:** **[Quality checks](.github/workflows/quality.yml)** (`pnpm release:gate`; publish workflows wait on the **`quality`** check run, **`geometra`**-style).
- **Smoke before release:** [docs/release-checklist.md](docs/release-checklist.md).

## Architecture Notes

Read:

- [docs/architecture.md](docs/architecture.md)
- [docs/principles.md](docs/principles.md)
- [docs/roadmap.md](docs/roadmap.md)

## What Comes Next

The roadmap is staged:

1. Single-node VPS inference runtime
2. Better model optimization and cache behavior
3. Multi-model routing and smarter scheduling
4. Distributed or edge-aware deployment
5. Deeper integration with `iso`

The order matters. Ray should get very good at one cheap box before it tries to orchestrate many.
