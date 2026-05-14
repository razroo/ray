# Release checklist

Use this before tagging a release or publishing npm packages.

## Phase 1 smoke (single-node runtime)

Aligned with [roadmap Phase 1 exit criteria](roadmap.md) and day-one operator expectations:

1. **Clean install and build**

   ```bash
   bun install
   bun run build
   ```

2. **Tiny profile (mock provider)**

   ```bash
   bun run smoke:tiny
   bun run smoke:tiny:public
   bun run smoke:tiny:async
   bun run smoke:tiny:public-async
   ```

   These start the tiny mock-provider gateway on ephemeral loopback ports and verify `/livez`, `/readyz`, `/v1/infer`, protected `/v1/jobs` auth guards, rate limiting, standalone async submission/status completion, and the public-auth async submission/status path without an external model server.

3. **Tests**

   ```bash
   bun run test
   ```

4. **Config validation**

   ```bash
   bun run validate:config
   bun run validate:config:all
   bun run smoke:tiny
   bun run smoke:tiny:public
   bun run smoke:tiny:async
   bun run smoke:tiny:public-async
   bun run deploy:smoke
   bun run deploy:scripts
   bun run package:runtime
   bun run docs:links
   bun run model:stage:smoke
   RAY_API_KEYS=smoke bun run validate:config:public
   ```

5. **VPS-oriented checks** (when exercising the default `sub1b` / `llama.cpp` path)
   - Gateway serves unauthenticated `/livez` for reverse-proxy health checks.
   - Gateway serves unauthenticated `/readyz` with minimal provider status, queue, pressure, and readiness reason codes.
   - With auth enabled in config, `/v1/infer`, `/health`, `/metrics`, and `/v1/config` reject missing or invalid API keys.
   - Rate limiting behaves as configured.
   - On a real Hetzner runner, `bun run benchmark:assert:cx23` or `bun run benchmark:assert:cax11` passes for the target machine class.

## npm packages

Use [Changesets](https://github.com/changesets/changesets) on `main` (`bun run version`) to bump **linked** `@razroo/ray-core` and `@razroo/ray-sdk` and update their `CHANGELOG.md` files, then tag and use **GitHub Releases** on `core-v...` and `sdk-v...` (see [npm-publishing.md](npm-publishing.md)). **[Quality checks](../.github/workflows/quality.yml)** must succeed (job **`quality`** / `bun run release:gate`); release workflows poll for that check run before `npm publish` (with provenance). Before tagging, run `bun run release:check-source -- <version>` to verify the linked package manifests match the release version. After publishing, run `bun run release:verify-npm -- <version>` to verify npm `latest`, the published version metadata, integrity, and registry tarball URL. Add repository secret **`NPM_TOKEN`**. [Branch protection for `main`](branch-protection.md) is recommended in GitHub settings.

## Docs

- Update version numbers in package manifests when cutting a release.
- If behavior or deployment steps change, update `README.md`, `examples/`, and `docs/architecture.md` as appropriate.
