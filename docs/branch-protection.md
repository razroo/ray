# Branch protection for `main`

GitHub branch rules are **not stored in git**; a repo admin applies them in the GitHub UI. Configure **`main`** so merges only land when **[Quality checks](../.github/workflows/quality.yml)** is green.

## Recommended rule set

1. Open **Settings → Rules → Rulesets** (or **Branches → Branch protection rules** on older UIs).

2. Target **`main`** (and optionally **`release/**`\*\* if you add that pattern later).

3. Enable:
   - **Require a pull request before merging**  
     Require approvals as your team prefers (often **1** for small teams).

   - **Require status checks to pass**  
     Require **Quality checks / `quality`** (the workflow job that runs `pnpm release:gate`).  
     Leave **“Require branches to be up to date before merging”** on if you want linear history.

   - **Require conversation resolution before merging** (optional but useful).

4. Optionally **restrict who can push** to `main` (admins only, or disable force-push).

5. Save the ruleset.

After this, contributors cannot merge PRs until lint, format check, tests, and npm pack smoke checks match what `pnpm run release:gate` runs locally.
