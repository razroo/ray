# Publishing to npm

Ray publishes **library** packages from this monorepo for TypeScript consumers. The gateway app (`apps/gateway`) stays source-first in the repo and is not published as an npm CLI in this layout.

Push-time automation follows [**geometra**](https://github.com/razroo/geometra)-style naming: [**Quality checks**](../.github/workflows/quality.yml) runs a single job **`quality`** that executes **`bun run release:gate`** under Node 20 and Node 22. The gate covers lint, format check, full test build, all checked-in config validation, public deploy bundle smoke rendering, public deploy package-script coverage, Bun-first package, workflow, and runtime-doc coverage, public model staging smoke rendering, and Bun pack smoke checks. Tags and **`gh release create`** follow the **`iso`** pattern ([**ray-core-release.yml**](../.github/workflows/ray-core-release.yml), [**ray-sdk-release.yml**](../.github/workflows/ray-sdk-release.yml)); publish workflows poll for the **`quality`** check run before `npm publish`, same idea as geometra's release workflow waiting on **`quality`**.

## Packages

| Package            | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `@razroo/ray-core` | Shared types, errors, and utilities used by the SDK and gateway |
| `@razroo/ray-sdk`  | Minimal HTTP client for the gateway API (`RayClient`)           |

Both are **scoped** packages under **`@razroo`**. Publishing requires an npm org or user that can publish **`@razroo/*`** on [npm](https://www.npmjs.com/) (create the **`razroo`** org or use an npm account with that scope).

## Prerequisites

### Repository secrets

Configure **`NPM_TOKEN`** on the GitHub repo (fine-grained or classic token allowed to publish to your scope).

### Maintain your machine

- Node 20+ matches the supported runtime; CI also runs the gate under Node 22.
- [GitHub CLI](https://cli.github.com/) (`gh`) for releases.
- Bun 1.3+ and repo install as in the root `README.md`.

### Tag naming

Releases use **distinct tags per package**, like `iso`:

| Workflow                     | Tag prefix | Example tag   |
| ---------------------------- | ---------- | ------------- |
| `@razroo/ray-core` publishes | `core-v`   | `core-v0.2.0` |
| `@razroo/ray-sdk` publishes  | `sdk-v`    | `sdk-v0.2.0`  |

The **`v` is literal** (`core-v` then semver). Strip logic in workflows turns `core-v1.2.3` → version `1.2.3` checked against `packages/*/package.json`.

Publish **`@razroo/ray-core`** before **`@razroo/ray-sdk`** when both change, so the SDK tarball can resolve the correct core range on npm.

## Versioning with Changesets (same idea as **`iso`**)

`@razroo/ray-core` and `@razroo/ray-sdk` are **linked** in [`.changeset/config.json`](../.changeset/config.json): one release line keeps both on the **same semver**.

During development, when a PR changes publishable APIs or behavior, add a changeset:

```bash
bun run changeset
```

Inspect what the next merge would release:

```bash
bun run changeset:status
```

On **`main`**, when you are ready to apply pending changesets and refresh **CHANGELOG.md** files:

```bash
bun run version
```

That runs `changeset version` and then **`bun install`** to sync `bun.lock`. Commit the result (version bumps + changelogs + `bun.lock`).

Infrastructure-only PRs can add an empty changeset: `bunx changeset add --empty`.

## Cut a release (GH + npm)

1. Ensure **`bun run version`** has been run and the version bump is committed on **`main`**.

2. Create **annotated tags** pointing at that commit:

   ```bash
   TAG_CORE="core-v$(bun -e 'console.log(require("./packages/core/package.json").version)')"
   TAG_SDK="sdk-v$(bun -e 'console.log(require("./packages/sdk/package.json").version)')"
   git tag "$TAG_CORE"
   git tag "$TAG_SDK"
   git push origin "$TAG_CORE" "$TAG_SDK"
   ```

   Only push the tag(s) you are releasing in this pass.

3. Create GitHub Releases (fires the npm workflows):

   ```bash
   gh release create "$TAG_CORE" --generate-notes --title "$TAG_CORE"
   gh release create "$TAG_SDK" --generate-notes --title "$TAG_SDK"
   ```

4. Workflow behavior:
   - Uses **`gh api`** to confirm the **`quality`** check run on the tagged commit succeeded (geometra-style gate before npm).
   - Runs **`packages/*/scripts/release/check-source.mjs`** so the tag matches `package.json`.
   - **`bun run build`**, **`bun pm pack`**, then **`npm publish <tarball> --provenance`** with OIDC provenance (`id-token: write`).

5. Omit or delete a faulty GitHub Release and tag before re-cutting; avoid amending published tags.

### One-command tags + GitHub Releases (`gh`)

After **`bun run version`** is committed on **`main`** and pushed (`git push origin main`), you can create both tags and GitHub Releases with:

```bash
bun run release:github -- --dry-run   # plan only
bun run release:github -- --yes     # tag, git push tags, gh release create ×2
```

Requires [**GitHub CLI**](https://cli.github.com/) (`gh`) authenticated (`gh auth login`). NPM publish still runs in Actions when each release is **published**.

## Verify locally before tagging

From the repo root (mirrors CI’s **`release:gate`**):

```bash
bun install
bun run release:gate
```

After a successful publish, confirm **`latest`** on npm (optional smoke, like geometra’s **`verify-npm`**):

```bash
bun run release:verify-npm -- <version-you-just-published>
```

Sanity-check `package.json` matches the semver you intend for the tag:

```bash
cd packages/core && bun run release:check-source -- "$(bun -e 'console.log(require("./package.json").version)')"
cd packages/sdk && bun run release:check-source -- "$(bun -e 'console.log(require("./package.json").version)')"
```

## Consumers

```bash
npm install @razroo/ray-sdk
```

The SDK lists `@razroo/ray-core` as a dependency; npm installs both.
