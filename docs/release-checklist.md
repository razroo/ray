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
   ```

5. **VPS-oriented checks** (when exercising the OpenAI-compatible adapter path)
   - Gateway serves `/health` and `/metrics`.
   - With auth enabled in config, `/v1/infer` rejects missing or invalid API keys.
   - Rate limiting behaves as configured.

## npm packages

Published libraries are `@ray/core` and `@ray/sdk`. Use **GitHub Releases** on tags `core-v…` and `sdk-v…` (see [npm-publishing.md](npm-publishing.md)); CI must be green: the **build-test-lint** job on the release commit is checked before `npm publish` (with provenance), and the tag is checked against `package.json` via `release:check-source`. Add the **`NPM_TOKEN`** repository secret for the publish step.

## Docs

- Update version numbers in package manifests when cutting a release.
- If behavior or deployment steps change, update `README.md`, `examples/`, and `docs/architecture.md` as appropriate.
