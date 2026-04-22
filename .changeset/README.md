# Changesets

Version bumps and `CHANGELOG.md` updates for publishable packages (`@ray/core`, `@ray/sdk`) are driven by [@changesets/cli](https://github.com/changesets/changesets).

Quick reference:

```bash
pnpm run changeset          # add a changeset after you change publishable APIs or behavior
pnpm run changeset:status   # preview what the next version step would touch
pnpm run version            # apply pending changesets → bump versions + write changelogs + refresh lockfile
```

Then commit the version bump, tag (`core-v…`, `sdk-v…`), and create GitHub Releases per [docs/npm-publishing.md](../docs/npm-publishing.md).
