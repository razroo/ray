#!/usr/bin/env bash
# Tag + GitHub Releases for linked @razroo/ray-core and @razroo/ray-sdk.
# NPM publish runs via .github/workflows/ray-*-release.yml when each release is published.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

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

CORE_VER=$(node -p 'require("./packages/core/package.json").version')
SDK_VER=$(node -p 'require("./packages/sdk/package.json").version')
if [ "$CORE_VER" != "$SDK_VER" ]; then
  echo "error: linked packages must share version; core=$CORE_VER sdk=$SDK_VER" >&2
  exit 1
fi

VER="$CORE_VER"
TAG_CORE="core-v$VER"
TAG_SDK="sdk-v$VER"

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

if ! git diff --quiet; then
  echo "error: uncommitted changes; commit or stash first" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) not on PATH" >&2
  exit 1
fi

if ! git rev-parse "$TAG_CORE" >/dev/null 2>&1; then
  git tag -a "$TAG_CORE" -m "Release $TAG_CORE (@razroo/ray-core v$VER)"
else
  echo "note: tag $TAG_CORE already exists"
fi
if ! git rev-parse "$TAG_SDK" >/dev/null 2>&1; then
  git tag -a "$TAG_SDK" -m "Release $TAG_SDK (@razroo/ray-sdk v$VER)"
else
  echo "note: tag $TAG_SDK already exists"
fi

git push origin "$TAG_CORE" "$TAG_SDK"
gh release create "$TAG_CORE" --generate-notes --title "$TAG_CORE"
gh release create "$TAG_SDK" --generate-notes --title "$TAG_SDK"
echo "Done. Actions publish to npm when each release is in published state."
