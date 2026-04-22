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

1. Install Node 20+ and `pnpm`.
2. Run `pnpm install`.
3. Start the gateway with `pnpm dev`.
4. Build with `pnpm build`.
5. Run tests with `pnpm test`.
6. Run `pnpm run release:gate` before opening a PR — same command CI runs (**Quality checks** → **`quality`** job: lint, format check, tests).

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
- For user-visible or API changes in **`@razroo/ray-core`** or **`@razroo/ray-sdk`**, add a [Changeset](https://github.com/changesets/changesets) (`pnpm run changeset`). For repo-only or private-package work, add an empty changeset if `pnpm run changeset:status` requires it: `pnpm exec changeset add --empty`.
- Call out memory, cold-start, or deployment tradeoffs in the PR description.
