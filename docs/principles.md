# Principles

## Keep It Lean

Every dependency, process, and abstraction should justify its memory and operational cost.

If a feature needs three supporting systems before it helps a single-node deployment, it probably does not belong in the first versions of Ray.

## Depth Over Breadth

Ray should prefer being excellent at one constrained deployment model over being mediocre across every provider and runtime shape.

If a choice trades cheap-VPS clarity for generic gateway breadth, the cheap-VPS path should usually win.

## Single Node First

Ray should become excellent at one inexpensive machine before it expands toward distributed orchestration.

A strong single-node product is not a toy. It is the foundation.

## Self-Hosting Is The Baseline

The default operator is a builder running their own box. Documentation, tooling, and configuration should assume that reality instead of treating it as an advanced edge case.

## Small Models Matter

Ray is optimized for small and medium open models, especially quantized variants that make cheap hardware viable.

This repo is not organized around giant-cluster assumptions.

## Local Backend Reality Beats Provider Abstraction

Abstract provider interfaces are useful, but Ray should not hide the realities of local inference:

- model load time
- quantization tradeoffs
- context size pressure
- CPU saturation
- backend restarts

The runtime should expose and handle those realities, not pretend they are incidental.

## Local And Production Should Feel Similar

The closer local development is to VPS production, the less accidental complexity the operator pays later.

Profiles can tune behavior, but the architecture should not fork into entirely different worlds between dev and prod.

## Explicit Over Magical

Configuration, queue limits, cache sizes, and degradation policy should be visible and understandable.

A builder should be able to read the config and know what the runtime will do.

## Backpressure Is Part Of The Product

On constrained hardware, refusing, delaying, deduplicating, or degrading work is often the correct behavior.

Ray should make that behavior explicit and configurable instead of burying it under optimistic abstractions.

## Predictable Failure Is Better Than Pretend Scale

On a small machine, graceful degradation and honest limits are better than hidden overload.

Ray should fail in ways an operator can understand:

- bounded queues
- clear health states
- explicit timeouts
- conservative defaults

## Preserve The Path To Sovereignty

Ray should integrate cleanly with broader sovereignty tooling later, but it should not become vague or overgeneralized in anticipation of that future.

The repo should remain a focused runtime layer for self-hosted AI.
