# Publishing to npm

Ray publishes **library** packages from this monorepo for TypeScript consumers. The gateway app (`apps/gateway`) stays source-first in the repo and is not published as an npm CLI in the current layout.

## Packages

| Package     | Purpose                                                         |
| ----------- | --------------------------------------------------------------- |
| `@ray/core` | Shared types, errors, and utilities used by the SDK and gateway |
| `@ray/sdk`  | Minimal HTTP client for the gateway API (`RayClient`)           |

Both are **scoped** packages. Publishing requires an npm organization or team that owns the `@ray` scope on [npm](https://www.npmjs.com/). If that scope is unavailable, rename the packages in each `package.json` and update workspace imports accordingly before publishing.

## Prerequisites

- Node 20+ and `pnpm` 9+
- npm login with permission to publish to the scope (`npm login`)

## Versioning

Keep `@ray/core` and `@ray/sdk` on the **same semver** for each release unless you have a deliberate reason not to (SDK always depends on the matching core release).

Bump `version` in:

- `packages/core/package.json`
- `packages/sdk/package.json`

## Build

From the repository root:

```bash
pnpm install
pnpm build
```

Confirm `packages/core/dist` and `packages/sdk/dist` exist.

## Publish

`pnpm` rewrites `workspace:*` dependencies to concrete versions when you publish.

From the repo root, publish core first, then the SDK:

```bash
pnpm publish --filter @ray/core --access public --no-git-checks
pnpm publish --filter @ray/sdk --access public --no-git-checks
```

Omit `--no-git-checks` if you publish from a clean git state and want `pnpm` to enforce its publish branch/dirty-tree rules.

After publishing, verify installs:

```bash
npm view @ray/core version
npm view @ray/sdk version
```

## Consumers

```bash
npm install @ray/sdk
```

The SDK lists `@ray/core` as a dependency; npm installs both.
