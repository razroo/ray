#!/usr/bin/env bash
# Tag + GitHub Releases for linked @razroo/ray-core and @razroo/ray-sdk.
# NPM publish runs via .github/workflows/ray-*-release.yml when each release is published.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  sed -n '1,80p' <<'EOF'
Usage: bash scripts/release/gh-release.sh [--dry-run | --yes]

  Reads versions from packages/core and packages/sdk (must match), then:
  1) creates annotated tags  core-v<ver>  and  sdk-v<ver>  on HEAD
  2) git push origin <tags>
  3) gh release create for each tag (triggers npm publish Actions)

  Prereqs: gh auth, clean working tree, main is what you intend to release.
  Push main first:  git push origin main

  --dry-run   print plan only
  --yes       perform tag + push + gh release create
EOF
  exit 1
}

DRY=false
YES=false
for arg in "$@"; do
  case "$arg" in
  --dry-run) DRY=true ;;
  --yes) YES=true ;;
  -h | --help) usage ;;
  *) echo "unknown arg: $arg" >&2; usage ;;
  esac
done

CORE_VER=$(bun --print 'require("./packages/core/package.json").version')
SDK_VER=$(bun --print 'require("./packages/sdk/package.json").version')
if [ "$CORE_VER" != "$SDK_VER" ]; then
  fail "linked packages must share version; core=$CORE_VER sdk=$SDK_VER"
fi

VER="$CORE_VER"
TAG_CORE="core-v$VER"
TAG_SDK="sdk-v$VER"

bun ./scripts/release/check-source.mjs "$VER" >/dev/null

echo "Version:  $VER"
echo "Packages: @razroo/ray-core  @razroo/ray-sdk"
echo "Tags:     $TAG_CORE  $TAG_SDK"

if [ "$DRY" = true ]; then
  echo "[dry-run] ok"
  exit 0
fi

if [ "$YES" != true ]; then
  echo "Re-run with --yes to create tags, push, and run gh release create for each." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh (GitHub CLI) not on PATH"
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  fail "working tree is not clean; commit or stash first"
fi

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  fail "release helper must run from main; current branch is ${BRANCH:-detached}"
fi

git fetch --tags origin refs/heads/main:refs/remotes/origin/main
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  fail "local HEAD $LOCAL_HEAD does not match origin/main $REMOTE_HEAD; push or pull main before releasing"
fi

for tag in "$TAG_CORE" "$TAG_SDK"; do
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    fail "local tag already exists: $tag"
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    fail "remote tag already exists: $tag"
  fi
  if gh release view "$tag" >/dev/null 2>&1; then
    fail "GitHub release already exists: $tag"
  fi
done

if ! gh auth status >/dev/null; then
  fail "gh is not authenticated"
fi

git tag -a "$TAG_CORE" -m "Release $TAG_CORE (@razroo/ray-core v$VER)"
git tag -a "$TAG_SDK" -m "Release $TAG_SDK (@razroo/ray-sdk v$VER)"
git push origin "$TAG_CORE" "$TAG_SDK"
gh release create "$TAG_CORE" --generate-notes --title "$TAG_CORE"
gh release create "$TAG_SDK" --generate-notes --title "$TAG_SDK"
echo "Done. Actions publish to npm when each release is in published state."
