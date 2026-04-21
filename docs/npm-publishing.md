# Publishing to npm

Ray publishes **library** packages from this monorepo for TypeScript consumers. The gateway app (`apps/gateway`) stays source-first in the repo and is not published as an npm CLI in this layout.

This mirrors the **`iso`** repo: [**CI**](../.github/workflows/ci.yml) runs a single job named **`build-test-lint`** on pushes and PRs to `main`. Publishing uses [**ray-core-release.yml**](../.github/workflows/ray-core-release.yml) and [**ray-sdk-release.yml**](../.github/workflows/ray-sdk-release.yml), triggered when you **publish a GitHub Release** for tags starting with `core-v` or `sdk-v`.

## Packages

| Package     | Purpose                                                         |
| ----------- | --------------------------------------------------------------- |
| `@ray/core` | Shared types, errors, and utilities used by the SDK and gateway |
| `@ray/sdk`  | Minimal HTTP client for the gateway API (`RayClient`)           |

Both are **scoped** packages. Publishing requires an npm organization or account that owns the **`@ray`** scope on [npm](https://www.npmjs.com/).

## Prerequisites

### Repository secrets

Configure **`NPM_TOKEN`** on the GitHub repo (fine-grained or classic token allowed to publish to your scope).

### Maintain your machine

- Node 22+ matches CI (Ray still supports Node 20+ locally via `engines`).
- [GitHub CLI](https://cli.github.com/) (`gh`) for releases.
- `pnpm` 9 and repo install as in the root `README.md`.

### Tag naming

Releases use **distinct tags per package**, like `iso`:

| Workflow              | Tag prefix | Example tag   |
| --------------------- | ---------- | ------------- |
| `@ray/core` publishes | `core-v`   | `core-v0.2.0` |
| `@ray/sdk` publishes  | `sdk-v`    | `sdk-v0.2.0`  |

The **`v` is literal** (`core-v` then semver). Strip logic in workflows turns `core-v1.2.3` → version `1.2.3` checked against `packages/*/package.json`.

Publish **`@ray/core`** before **`@ray/sdk`** when both change, so the SDK tarball can resolve the correct core range on npm.

## Cut a release (GH + npm)

1. Bump **`version`** in **`packages/core/package.json`** and/or **`packages/sdk/package.json`** on `main`.

2. Commit and push those bumps.

3. Create **annotated tags** pointing at that commit:

   ```bash
   TAG_CORE="core-v$(node -p 'require("./packages/core/package.json").version')"
   TAG_SDK="sdk-v$(node -p 'require("./packages/sdk/package.json").version')"
   git tag "$TAG_CORE"
   git tag "$TAG_SDK"
   git push origin "$TAG_CORE" "$TAG_SDK"
   ```

   Only push the tag(s) you are releasing in this pass.

4. Create GitHub Releases (fires the npm workflows):

   ```bash
   gh release create "$TAG_CORE" --generate-notes --title "$TAG_CORE"
   gh release create "$TAG_SDK" --generate-notes --title "$TAG_SDK"
   ```

   Workflow behavior:
   - Uses **`gh api`** to confirm the **`build-test-lint`** check run on the tagged commit succeeded (same pattern as **`iso`**).
   - Runs **`packages/*/scripts/release/check-source.mjs`** so the tag matches `package.json`.
   - **`pnpm build`** then **`pnpm publish --filter … --provenance`** with OIDC provenance (`id-token: write`).

5. Omit or delete a faulty GitHub Release and tag before re-cutting; avoid amending published tags.

## Verify locally before tagging

From the repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint && pnpm format:check
```

Sanity-check `package.json` matches the semver you intend for the tag:

```bash
pnpm --filter @ray/core run release:check-source -- "$(node -p 'require("./packages/core/package.json").version')"
pnpm --filter @ray/sdk run release:check-source -- "$(node -p 'require("./packages/sdk/package.json").version')"
```

## Consumers

```bash
npm install @ray/sdk
```

The SDK lists `@ray/core` as a dependency; npm installs both.
