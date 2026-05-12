# Contributing to Ray

Ray is being built as a lean inference runtime for cheap VPS hardware. Contributions should preserve that constraint instead of treating it as branding.

## What belongs here

- Smaller-model hosting and routing primitives
- Configuration, scheduling, caching, and observability that help a single node perform well
- Deployment ergonomics for self-hosted builders
- Adapter work that keeps the runtime backend-agnostic without bloating the core

## What does not belong here

- Kubernetes-first control planes
- Cluster complexity before single-node reliability is solid
- Heavy optional dependencies pulled into the hot path
- Product surface that duplicates broader sovereignty concerns already better owned by `iso`

## Development

1. Install Node 20+ and Bun 1.3+.
2. Run `bun install`.
3. Start the default sub-1B `llama.cpp` path with `bun run dev`, or use `bun run dev:tiny` if you do not have a local model backend running yet.
4. Build with `bun run build`.
5. Run tests with `bun run test`.
6. Run `bun run release:gate` before opening a PR — same command CI runs (**Quality checks** → **`quality`** job: lint, format check, tests).

## Engineering bar

- Keep the runtime dependency graph small.
- Prefer stable primitives over feature sprawl.
- Explain why added memory or operational cost is worth it.
- Favor explicit configuration over framework magic.
- Make local development and single-VPS production behave the same way whenever possible.

## Pull requests

- Keep changes scoped.
- Include doc updates when architecture or operator-facing behavior changes.
- Add or extend tests when changing scheduler, cache, config, or transport behavior.
- For user-visible or API changes in **`@razroo/ray-core`** or **`@razroo/ray-sdk`**, add a [Changeset](https://github.com/changesets/changesets) (`bun run changeset`). For repo-only or private-package work, add an empty changeset if `bun run changeset:status` requires it: `bunx changeset add --empty`.
- Call out memory, cold-start, or deployment tradeoffs in the PR description.
