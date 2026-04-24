# Release checklist

Use this before tagging a release or publishing npm packages.

## Phase 1 smoke (single-node runtime)

Aligned with [roadmap Phase 1 exit criteria](roadmap.md) and day-one operator expectations:

1. **Clean install and build**

   ```bash
   pnpm install
   pnpm build
   ```

2. **Tiny profile (mock provider)**

   ```bash
   pnpm dev:tiny
   ```

   In another terminal:

   ```bash
   curl -s http://127.0.0.1:3000/v1/infer \
     -H 'content-type: application/json' \
     -d '{"input":"Smoke test."}'
   ```

   Expect a JSON inference response without an external model server.

3. **Tests**

   ```bash
   pnpm test
   ```

4. **Config validation**

   ```bash
   pnpm validate:config
   RAY_API_KEYS=smoke pnpm validate:config:public
   ```

5. **VPS-oriented checks** (when exercising the default `sub1b` / `llama.cpp` path)
   - Gateway serves unauthenticated `/livez` for reverse-proxy health checks.
   - With auth enabled in config, `/v1/infer`, `/health`, `/metrics`, and `/v1/config` reject missing or invalid API keys.
   - Rate limiting behaves as configured.
   - On a real Hetzner runner, `pnpm benchmark:assert:cx23` or `pnpm benchmark:assert:cax11` passes for the target machine class.

## npm packages

Use [Changesets](https://github.com/changesets/changesets) on `main` (`pnpm run version`) to bump **linked** `@razroo/ray-core` and `@razroo/ray-sdk` and update their `CHANGELOG.md` files, then tag and use **GitHub Releases** on `core-v…` and `sdk-v…` (see [npm-publishing.md](npm-publishing.md)). **[Quality checks](../.github/workflows/quality.yml)** must succeed (job **`quality`** / `pnpm release:gate`); release workflows poll for that check run before `npm publish` (with provenance). The tag is validated with **`release:check-source`**. Add repository secret **`NPM_TOKEN`**. [Branch protection for `main`](branch-protection.md) is recommended in GitHub settings.

## Docs

- Update version numbers in package manifests when cutting a release.
- If behavior or deployment steps change, update `README.md`, `examples/`, and `docs/architecture.md` as appropriate.
