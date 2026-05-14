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

run_bounded() {
  local seconds="$1"
  shift

  if ! [[ "$seconds" =~ ^[1-9][0-9]*$ ]]; then
    fail "timeout must be a positive integer number of seconds"
  fi
  if [ "$#" -eq 0 ]; then
    fail "run_bounded requires a command"
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}s" "$@"
    return
  fi

  local marker
  marker="$(mktemp "${TMPDIR:-/tmp}/ray-gh-release-timeout.XXXXXX")"
  rm -f "$marker"

  "$@" &
  local command_pid=$!
  (
    sleep "$seconds"
    if kill -0 "$command_pid" 2>/dev/null; then
      : >"$marker"
      kill -TERM "$command_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$command_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!
  local status=0

  wait "$command_pid" || status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [ -e "$marker" ]; then
    rm -f "$marker"
    return 124
  fi

  rm -f "$marker"
  return "$status"
}

run_required_bounded() {
  local description="$1"
  local seconds="$2"
  shift 2

  local status=0
  run_bounded "$seconds" "$@" || status=$?
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  if [ "$status" -eq 124 ]; then
    fail "timed out after ${seconds}s while ${description}"
  fi

  fail "${description} failed (exit $status)"
}

remote_tag_exists() {
  local tag="$1"
  local status=0
  run_bounded 60 git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 ||
    status=$?

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ "$status" -eq 2 ]; then
    return 1
  fi

  fail "could not check remote tag $tag (exit $status)"
}

github_release_exists() {
  local tag="$1"
  local stderr_file
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/ray-gh-release-view.XXXXXX")"

  local status=0
  run_bounded 60 gh release view "$tag" >/dev/null 2>"$stderr_file" || status=$?
  if [ "$status" -eq 0 ]; then
    rm -f "$stderr_file"
    return 0
  fi

  local message
  message="$(head -n 1 "$stderr_file" | tr -d '\r' || true)"
  rm -f "$stderr_file"

  if [ "$status" -eq 124 ]; then
    fail "timed out checking GitHub release: $tag"
  fi

  if printf '%s\n' "$message" | grep -Eiq '(^|[[:space:]])release[[:space:]-]+not[[:space:]-]+found|no release found'; then
    return 1
  fi

  if [ -n "$message" ]; then
    fail "could not check GitHub release $tag (exit $status): $message"
  fi

  fail "could not check GitHub release $tag (exit $status)"
}

usage() {
  sed -n '1,80p' <<'EOF'
Usage: bash scripts/release/gh-release.sh [--dry-run | --yes]

  Reads versions from packages/core and packages/sdk (must match), then:
  1) creates annotated tags  core-v<ver>  and  sdk-v<ver>  on HEAD
  2) git push --atomic origin <tags>
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

run_required_bounded \
  "fetching origin/main and release tags" \
  120 \
  git fetch --tags origin refs/heads/main:refs/remotes/origin/main
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  fail "local HEAD $LOCAL_HEAD does not match origin/main $REMOTE_HEAD; push or pull main before releasing"
fi

run_required_bounded "checking GitHub CLI authentication" 60 gh auth status >/dev/null

for tag in "$TAG_CORE" "$TAG_SDK"; do
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    fail "local tag already exists: $tag"
  fi
  if remote_tag_exists "$tag"; then
    fail "remote tag already exists: $tag"
  fi
  if github_release_exists "$tag"; then
    fail "GitHub release already exists: $tag"
  fi
done

git tag -a "$TAG_CORE" -m "Release $TAG_CORE (@razroo/ray-core v$VER)"
git tag -a "$TAG_SDK" -m "Release $TAG_SDK (@razroo/ray-sdk v$VER)"
run_required_bounded "pushing release tags atomically" 120 git push --atomic origin "$TAG_CORE" "$TAG_SDK"
run_required_bounded \
  "creating GitHub release $TAG_CORE" \
  120 \
  gh release create "$TAG_CORE" --generate-notes --title "$TAG_CORE"
run_required_bounded \
  "creating GitHub release $TAG_SDK" \
  120 \
  gh release create "$TAG_SDK" --generate-notes --title "$TAG_SDK"
echo "Done. Actions publish to npm when each release is in published state."
