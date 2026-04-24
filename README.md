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

- **pnpm** workspace (`pnpm` 9+, Node **20.11+** per `engines`; GitHub Actions uses Node 22 for CI parity)
- TypeScript with a project reference build (`pnpm build` / `pnpm typecheck`)
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

- `apps/gateway`: HTTP inference gateway with `/v1/infer`, `/v1/jobs`, `/livez`, `/health`, `/metrics`, and `/v1/config`
- `packages/runtime`: request normalization, degradation policy, cache integration, and provider orchestration
- `packages/models`: provider abstraction with `mock` and `openai-compatible` adapters
- `packages/scheduler`: lightweight queueing, token-aware admission, concurrency limits, and in-flight deduplication
- `packages/cache`: TTL cache for prompt/result reuse
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
pnpm install
```

### Run locally (tiny profile — mock provider)

No external model server required:

```bash
pnpm dev:tiny
```

In another terminal:

```bash
curl -s http://127.0.0.1:3000/v1/infer \
  -H 'content-type: application/json' \
  -d '{"input":"Explain why cheap VPS inference matters."}'
```

Async durable queue on the same gateway:

```bash
curl -s http://127.0.0.1:3000/v1/jobs \
  -H 'content-type: application/json' \
  -d '{"input":"Draft a follow-up email body.","callbackUrl":"https://example.com/ray-callback"}'
```

### Build

```bash
pnpm build
```

### Default cheap-VPS profile (sub-1B llama.cpp backend)

Expects a local `llama.cpp` server on `127.0.0.1:8081` (see [ray.sub1b.json](examples/config/ray.sub1b.json)). The default sub-1B path is tuned for a CX23-class 2 vCPU / 4 GB x86 VPS; use [ray.sub1b.cax11.json](examples/config/ray.sub1b.cax11.json) for the ARM CAX11 variant.

```bash
pnpm start
```

For the roomier 3B-style OpenAI-compatible profile, use `pnpm start:vps`.

### 1B llama.cpp profile

Use the 1B profile when the product needs better instruction following than the sub-1B default and can tolerate lower throughput on the same cheap-VPS class. The default [ray.1b.json](examples/config/ray.1b.json) target is a conservative 4 GB CX23-class single-slot setup for a Qwen2.5 1.5B Q4 GGUF. The [ray.1b.8gb.json](examples/config/ray.1b.8gb.json) variant raises context, cache, and parallelism for an 8 GB single node.

```bash
pnpm start:1b
pnpm start:1b:8gb
```

Deployment walkthrough: [examples/deploy/vps/README.md](examples/deploy/vps/README.md).

The repo also includes an opt-in GitHub Actions VPS deploy workflow for the
gateway itself: [.github/workflows/deploy-vps.yml](.github/workflows/deploy-vps.yml).
That workflow is generic and only uses repository secrets/variables supplied by
the operator.

### Validate config / doctor

```bash
pnpm validate:config
pnpm doctor
```

`pnpm doctor` targets the public `sub1b` deploy profile. Run it on the VPS after the GGUF exists at the configured path and `/etc/ray/ray.env` is populated.

### Benchmark Contract

On a real Hetzner box, the benchmark script can now emit structured JSON and assert against checked-in baselines:

```bash
pnpm benchmark:assert:cx23
pnpm benchmark:assert:cax11
pnpm benchmark:assert:cx23:1b
pnpm benchmark:assert:8gb:1b
pnpm benchmark:1b:prompt-formats
```

Those commands write the latest report to `.ray/benchmarks/`, append JSONL history when configured, and compare the run against the baseline JSON in `examples/benchmarks/baselines/`. The 1B workload also checks scored output quality signals such as JSON validity, prompt echo, stop-token leakage, call-to-action presence, forbidden wrappers, and generic email filler.

For prompt-family quality checks across cold outreach, follow-up, classification, rewrite, and section generation:

```bash
pnpm eval:prompt-families:1b
```

The structured benchmark output includes provider diagnostics such as prompt format, request shape, model ref, launch preset, slot reuse, cached tokens, JSON repair attempts, and context window so a quality regression can be tied back to the backend path Ray chose. `/health` also exposes detected backend capabilities, and `/v1/config` includes sanitized capability hints for the configured profile.

### Quality gate (matches CI)

Same command **[Quality checks](.github/workflows/quality.yml)** runs on **`main`** under Node 20 and Node 22:

```bash
pnpm run release:gate
```

That runs lint, Prettier `--check`, tests (`pnpm test` builds then runs the Tap suite), and npm pack smoke checks for the public packages.

## Example config profiles

- [examples/config/ray.tiny.json](examples/config/ray.tiny.json) — mock provider; boots immediately
- [examples/config/ray.sub1b.json](examples/config/ray.sub1b.json) — default private/local sub-1B `llama.cpp` profile for CX23-class x86 boxes
- [examples/config/ray.sub1b.public.json](examples/config/ray.sub1b.public.json) — public-safe CX23-class sub-1B `llama.cpp` profile with auth enabled and bounded cache RAM
- [examples/config/ray.sub1b.cax11.json](examples/config/ray.sub1b.cax11.json) — private/local CAX11-class ARM variant with tighter queue and single-slot defaults
- [examples/config/ray.sub1b.cax11.public.json](examples/config/ray.sub1b.cax11.public.json) — public-safe CAX11-class ARM variant
- [examples/config/ray.sub1b.classifier.json](examples/config/ray.sub1b.classifier.json) — below-1B classifier-oriented profile with shorter outputs, JSON-mode warmup, and tighter context
- [examples/config/ray.sub1b.drafter.json](examples/config/ray.sub1b.drafter.json) — below-1B email drafting profile with warmer prompt-family defaults
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

Install: `npm install @razroo/ray-sdk` (pulls **`@razroo/ray-core`**).

### Versioning and releases

- **Changesets** — [`iso`](https://github.com/razroo/iso)-style workflow: `pnpm run changeset` on PRs that affect publishable APIs, then `pnpm run version` on `main` to bump linked packages and **`CHANGELOG.md`** ([`.changeset/config.json`](.changeset/config.json)).
- **GitHub Releases** — tags `core-v…` and `sdk-v…`, then **`gh release create`** (shortcut: **`pnpm run release:github -- --yes`** after `pnpm run version` is on `main`); workflows publish with provenance. Details: [docs/npm-publishing.md](docs/npm-publishing.md).
- **Post-publish check** — `pnpm run release:verify-npm -- <version>` against the npm registry.

### Security and repository hygiene

- Vulnerability reports: [SECURITY.md](SECURITY.md).
- Recommend **branch protection** so `main` requires **Quality checks**: [docs/branch-protection.md](docs/branch-protection.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: keep changes scoped, run **`pnpm run release:gate`** before pushing, add a **changeset** when **`@razroo/ray-core`** or **`@razroo/ray-sdk`** behavior changes.

## Architecture notes

- [docs/architecture.md](docs/architecture.md)
- [docs/principles.md](docs/principles.md)
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
