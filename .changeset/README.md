# Changesets

Version bumps and `CHANGELOG.md` updates for publishable packages (**`@razroo/ray-core`**, **`@razroo/ray-sdk`**) are driven by [@changesets/cli](https://github.com/changesets/changesets). Private workspace packages are **not** versioned (`privatePackages.version: false` in `config.json`).

Quick reference:

```bash
pnpm run changeset          # add a changeset after you change publishable APIs or behavior
pnpm run changeset:status   # preview what the next version step would touch
pnpm run version            # apply pending changesets → bump versions + write changelogs + refresh lockfile
```

Then commit the version bump, tag (`core-v…`, `sdk-v…`), and create GitHub Releases per [docs/npm-publishing.md](../docs/npm-publishing.md).
