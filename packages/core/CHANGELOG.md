# @razroo/ray-core

## 0.3.0

### Minor Changes

- 2b644b9: Add explicit CX23 and CAX11 llama.cpp launch presets, richer runtime metrics for small VPS deployments, and benchmark baseline contracts for Hetzner runner checks.
- ef907fe: Add async durable inference jobs with `POST /v1/jobs`, deterministic `seed` support, `stop` and `responseFormat` request controls, OpenAI-compatible `warmupRequests`, and token-aware scheduler budgets.
- 71d4154: Add JSON repair diagnostics for tiny model classification, task-routing diagnostics, prompt-format benchmark sweeps, scored quality metrics, benchmark history output, and sanitized capability hints.
- b71a4e0: Add the `1b-8gb` Ray profile identifier for roomier single-node 1B deployments.
- 013d405: Add first-class 1B Ray profiles, llama.cpp prompt-format diagnostics, and benchmark quality gates for 1B email inference workloads.
- 19c8f77: Add the `sub1b-cax11` Ray profile identifier for ARM single-slot sub-1B VPS
  deployments.
- 2b644b9: Add a first-class `sub1b` profile for bounded `llama.cpp` deployments on cheap VPS hardware and make it the default config baseline.
- f25eb5a: Add llama.cpp capability detection, prompt-format auto fallback diagnostics, prompt-family eval workloads, below-1B profile variants, and richer benchmark provider diagnostics.

### Patch Changes

- f02d0b2: Expose durable async-queue pressure in health snapshots and metrics.
- db0a791: Expose async queue free storage headroom in health snapshots and metrics.
- 40394af: Expose cgroup CPU pressure diagnostics and clamp output under sustained CPU throttling.
- 4cf462c: Expose cgroup CPU quota and effective core limits in runtime health diagnostics and metrics.
- a3f9d79: Expose cgroup CPU throttling counters in runtime health diagnostics and metrics.
- aae5d7f: Expose cgroup v2 memory event counters in runtime diagnostics and metrics.
- fe2e458: Expose cgroup `memory.high` in runtime diagnostics and use it as the cgroup pressure threshold when present.
- 4f06c40: Add a configurable graceful-degradation threshold for cgroup CPU throttling pressure.
- 4cabc6c: Add explicit package export type conditions so TypeScript consumers resolving through `exports` find the published declarations.
- 52dce17: Add config fields for bounded rate-limit key storage, private-network callback protection, and configurable llama.cpp slot snapshot timeouts.
- a3f56c5: Expose scheduler queue capacity and token-budget headroom in runtime health diagnostics.
- 25e79f7: Expose provider-preparation pressure in runtime health snapshots and metrics.
- b3800c6: Expose process RSS pressure ratio in runtime health snapshots and metrics.
- 5a98882: Use recent cgroup CPU throttling counter deltas for runtime pressure decisions so a recovered single-node VPS is not kept degraded by historical throttling.
- fb588e2: Expose runtime queue and token saturation ratios in health snapshots.

## 0.2.0

### Minor Changes

- Publish libraries on npm under `@razroo/ray-core` and `@razroo/ray-sdk` (replacing the previous `@ray/*` package names). Update imports to the new scope.

## 0.1.0

### Major changes

- Initial published types and shared primitives for the Ray gateway and SDK.

### Patch changes

- _Changelog from this point forward is updated by [Changesets](https://github.com/changesets/changesets) when you run `bun run version` at the repo root._
