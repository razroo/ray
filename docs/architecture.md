# Architecture

## Thesis

Ray is built to shrink AI serving down to infrastructure a builder can realistically own.

That means the first architecture target is not a cluster scheduler or a fleet manager. It is a single node with tight memory, modest CPU, limited operator time, and a requirement that the whole system still feels trustworthy.

This repo is intentionally not optimized for breadth-first gateway competition.

Ray does not need to be the gateway that supports the most providers, the most enterprise integrations, or the widest SDK surface. It needs to be the runtime that behaves correctly on a constrained self-hosted box.

## Why This Monorepo Is Structured This Way

The repo is split by stable responsibility boundaries rather than by future marketing surface.

```text
apps/gateway
packages/core
packages/runtime
packages/models
packages/scheduler
packages/cache
packages/deploy
packages/config
packages/telemetry
packages/sdk
```

Reasoning:

- `apps/gateway` is the first product surface. It exposes the runtime over HTTP and stays thin.
- `packages/core` holds durable types, errors, and small shared utilities.
- `packages/runtime` composes the actual serving behavior: request normalization, degradation policy, cache use, and provider orchestration.
- `packages/models` isolates model/backend adapters so the runtime does not depend on a single inference engine.
- `packages/scheduler` owns queueing, concurrency, and request deduplication.
- `packages/cache` owns prompt/result reuse without dragging a distributed cache into the MVP.
- `packages/config` makes profile-driven single-node operation explicit.
- `packages/telemetry` provides low-cost logging and metrics without a heavy observability stack.
- `packages/deploy` codifies the intended VPS story instead of leaving it as tribal knowledge.
- `packages/sdk` keeps client integration simple and typed.

This is structured to keep stable primitives small and reusable while leaving room for the experimental edges to evolve without contaminating everything else.

It also keeps the product boundary honest: the repo is organized around operating a small-model runtime, not around building a maximal abstraction layer over every AI vendor.

## Stable Primitives vs Experimental Areas

Stable primitives:

- request and response shapes
- config loading and profile defaults
- single-node scheduling semantics
- cache interfaces
- runtime composition boundaries
- HTTP gateway surface

Experimental areas:

- model adapters beyond the initial mock and OpenAI-compatible paths
- backend-specific quantization strategies
- first-class `llama.cpp` or GGUF-specific operational adapters
- batching policy
- cross-model routing
- distributed placement or edge-aware scheduling
- future `iso` integration surfaces

The rule is straightforward: stable primitives should stay boring. Experimental areas can move quickly as long as they do not force churn across the whole repo.

## Why TypeScript, Why Not Start in Go

Go is a credible future option for the gateway or hot-path runtime pieces if operational evidence says it is necessary.

It is not the right first move for this repo.

The current MVP needs:

- fast iteration
- easy contribution paths for OSS builders
- strong type boundaries across many packages
- minimal operational complexity

A TypeScript workspace on Node 20 gets there quickly while keeping the actual runtime dependency graph extremely small. The gateway currently uses the bare `http` module rather than a framework to avoid adding memory and abstraction overhead where it is not buying much.

This architecture keeps the migration path open:

- model adapters can be swapped
- runtime boundaries are explicit
- the HTTP surface is small
- performance-sensitive pieces can be rewritten later without changing the product contract

## What Ray Refuses To Optimize For

Ray should be clear about the axes it is not trying to win.

Non-goals for the early project:

- being the broadest provider matrix in the ecosystem
- serving as a universal hosted-model switchboard
- turning into an all-in-one agent platform
- assuming Kubernetes or multi-node control planes from day one
- treating a tiny VPS as if it were just a badly provisioned cluster node

Those are not bad problems. They are just different problems.

## Keeping The Runtime Lightweight

Ray stays light by making a few opinionated choices.

### The gateway does not pretend to be the model kernel

In phase 1, Ray is the runtime layer around inference, not the implementation of every inference backend.

That means:

- the gateway can stay small
- model execution can target local lightweight backends such as `llama.cpp`
- backend-specific complexity stays out of the core runtime

### Memory is treated as a design constraint

Current design choices that reflect this:

- no heavy HTTP framework
- no required database
- no required message broker
- no distributed cache in the MVP
- in-memory TTL cache with bounded entry count
- bounded request queue with explicit backpressure

The next layer of work should make this more concrete:

- concurrency and queue defaults that reflect small-box CPU inference
- backend-aware health and warmup behavior
- stronger GGUF and quantization-aware operator defaults

### Degradation is a feature, not an afterthought

On small hardware, graceful degradation is more honest than pretending every request deserves infinite latency and full output budgets.

The runtime already has policy hooks for:

- prompt truncation
- output token clamping under pressure
- bounded queue depth
- in-flight request deduplication

That is a meaningful architectural distinction. On cheap hardware, overload behavior is part of the runtime contract, not an implementation detail.

## Local Backend Reality Matters

Broad AI gateways often optimize for provider abstraction first. Ray has a narrower job.

Ray needs to understand the reality of local backends:

- one model process can dominate the box
- quantization choice changes the deployment envelope
- a backend restart is an operational event, not an abstract transport retry
- context size, queue depth, and max tokens are budget decisions

That is why the runtime is adapter-driven but still opinionated. The provider layer exists to keep the core small, but the product direction should move toward first-class support for local backends such as `llama.cpp`, not away from them.

## How Ray Shrinks The Infrastructure Burden

Large-model infrastructure is often expensive because every layer assumes abundance:

- abundant RAM
- abundant concurrency headroom
- abundant operator time
- abundant supporting infrastructure

Ray intentionally assumes the opposite.

It shrinks infrastructure burden by:

- targeting a single cheap node first
- favoring quantized small and medium models
- using adapter-backed local inference backends
- keeping config explicit
- making deployment systemd-and-reverse-proxy simple
- keeping runtime dependencies low

The repo name is not metaphorical fluff. The architecture is designed to turn an oversized inference setup into something compact enough to deploy, reason about, and maintain.

## Relation To Sovereignty And `iso`

`iso` is the larger sovereignty and environment layer.

Ray complements it by focusing on the narrower but essential problem of self-hosted intelligence:

- what runs the gateway
- how inference requests are shaped and scheduled
- how small models are routed and cached
- how an operator deploys that runtime onto hardware they control

Later integration points with `iso` likely include:

- environment and secret management
- machine/runtime provisioning
- deployment packaging
- host identity and policy
- operator UX across services

Ray should remain sharp even when that integration lands. It should not dissolve into a generic platform abstraction.
