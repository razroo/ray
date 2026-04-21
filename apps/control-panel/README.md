# Control Panel

This app is **deferred**. The workspace entry exists so the monorepo layout stays honest and `pnpm` can resolve `apps/*` consistently.

Ray should earn a UI after the single-node runtime, configuration model, and deployment workflow are stable. Until then, the gateway, docs, example configs, and the published `@ray/sdk` client are the product surface.

When work starts here, prefer a thin UI that reads the same JSON config and HTTP API as operators use today, rather than a parallel control plane.
