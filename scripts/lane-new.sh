#!/usr/bin/env bash
# Purpose: start a parallel lane: a new worktree and branch with the tool dependencies already installed.
# Usage: scripts/lane-new.sh <name> [base]   (creates ../claude-setup-wt/<name> on branch lane/<name>; base defaults to the
#   branch checked out in the main checkout, and is then recorded as git config branch.lane/<name>.cs-lane-base for land)
# Invariants: refuses an existing branch or folder, and no base while the main checkout is detached; installs with `npm ci`
# in each tool listed in install.mjs's TOOLS_WITH_DEPS that has a package-lock.json (a fresh worktree has no node_modules, so
# e.g. the env-names tests would fail); prints the path last.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-}"
BASE="${2:-}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "usage: scripts/lane-new.sh <name> [base]  (name: letters, digits, . _ -)" >&2; exit 2; }

[[ "$BASE" != -* ]] || { echo "unknown base $BASE (a base cannot start with -)" >&2; exit 2; }

# Lanes sit next to the main checkout (<main>-wt/<name>), also when this script runs from another lane.
MAIN="$(cd "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
BRANCH="lane/$NAME"
LANE_DIR="$MAIN-wt/$NAME"
RECORD_BASE=""
if [ -z "$BASE" ]; then
  BASE="$(git -C "$MAIN" symbolic-ref --short -q HEAD)" || { echo "the main checkout is detached; pass a base or check out a branch" >&2; exit 2; }
  RECORD_BASE=1
fi

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then echo "branch $BRANCH already exists" >&2; exit 1; fi
if [ -e "$LANE_DIR" ]; then echo "folder $LANE_DIR already exists" >&2; exit 1; fi
git -C "$MAIN" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || { echo "unknown base $BASE" >&2; exit 2; }

git -C "$MAIN" worktree add -b "$BRANCH" -- "$LANE_DIR" "$BASE" >&2
# The lane's base, for git-tidy and land: the lane lands on this branch even after the main checkout switches to another.
[ -z "$RECORD_BASE" ] || git -C "$MAIN" config "branch.$BRANCH.cs-lane-base" "$BASE"

# The tool list lives in install.mjs (the one installer; one list): `export const TOOLS_WITH_DEPS = ['a', 'b'];`.
TOOLS="$(sed -n "s/^export const TOOLS_WITH_DEPS = \[\(.*\)\];$/\1/p" "$REPO/scripts/install.mjs" | tr -d "',")"
[ -n "$TOOLS" ] || { echo "TOOLS_WITH_DEPS not found in $REPO/scripts/install.mjs" >&2; exit 1; }
for tool in $TOOLS; do
  [ -f "$LANE_DIR/home/tools/$tool/package-lock.json" ] || continue
  if ! npm ci --prefix "$LANE_DIR/home/tools/$tool" >&2; then
    {
      echo "lane not ready: npm ci failed for $tool"
      echo "  worktree: $LANE_DIR (branch $BRANCH)"
      echo "  to finish:  npm ci --prefix $LANE_DIR/home/tools/$tool"
      echo "  to remove:  git worktree remove $LANE_DIR && git branch -D $BRANCH"
    } >&2
    exit 1
  fi
done

echo "$LANE_DIR"
