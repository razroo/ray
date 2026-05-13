# Repository Guidance

Ray is an open-source package and monorepo for people to run on their own VPS infrastructure. Treat this repository as a distributable project, not as the source of truth for an active Razroo-operated production VPS.

## Deployment Boundary

- Do not add, broaden, or enable automation that deploys this repository to a live VPS unless the user explicitly asks for that deployment behavior.
- GitHub Actions should default to open-source-safe behavior: quality checks, tests, package validation, and intentional npm package publishing.
- VPS deployment scripts and examples are reference/operator tooling for downstream users and maintainers. They should be manual, clearly gated, and safe to leave unused in forks.
- This repository should not include a repo-owned `.github/workflows/deploy-vps.yml` workflow. If a user explicitly asks to add deployment automation, make it manual-only, clearly scoped to their fork/repo, and guarded by explicit secrets, protected environments, and canonical-repo checks.
- Do not assume repository secrets identify a production target. Never introduce hard-coded hosts, domains, keys, service users, or VPS-specific state.

## Release Boundary

- Publishing `@razroo/ray-core` and `@razroo/ray-sdk` to npm is valid release automation when triggered by explicit release tags and guarded by the existing quality checks.
- Do not conflate package release with runtime deployment. A successful release should not imply that a gateway was deployed anywhere.

## Documentation Tone

- Present VPS setup as something users run on their own machines.
- Keep deployment examples generic and copyable.
- Avoid language that implies this repo automatically manages an active hosted Ray service.
