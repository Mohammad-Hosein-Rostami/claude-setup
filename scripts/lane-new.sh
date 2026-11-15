#!/usr/bin/env bash
# Purpose: start a parallel lane: a new worktree and branch with the tool dependencies already installed.
# Usage: scripts/lane-new.sh <name> [base]   (creates ../claude-setup-wt/<name> on branch lane/<name>; base defaults to main)
# Invariants: refuses an existing branch or folder; installs with `npm ci` in each tool listed in install.sh's TOOLS_WITH_DEPS
# that has a package-lock.json (a fresh worktree has no node_modules, so e.g. the env-names tests would fail); prints the path last.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-}"
BASE="${2:-main}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "usage: scripts/lane-new.sh <name> [base]  (name: letters, digits, . _ -)" >&2; exit 2; }

# Lanes sit next to the main checkout (<main>-wt/<name>), also when this script runs from another lane.
MAIN="$(cd "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
BRANCH="lane/$NAME"
LANE_DIR="$MAIN-wt/$NAME"

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then echo "branch $BRANCH already exists" >&2; exit 1; fi
if [ -e "$LANE_DIR" ]; then echo "folder $LANE_DIR already exists" >&2; exit 1; fi

git -C "$MAIN" worktree add "$LANE_DIR" -b "$BRANCH" "$BASE" >&2

# The tool list lives in install.sh (one list).
TOOLS="$(sed -n 's/^TOOLS_WITH_DEPS=(\(.*\))$/\1/p' "$REPO/scripts/install.sh")"
[ -n "$TOOLS" ] || { echo "TOOLS_WITH_DEPS not found in $REPO/scripts/install.sh" >&2; exit 1; }
for tool in $TOOLS; do
  if [ -f "$LANE_DIR/home/tools/$tool/package-lock.json" ]; then npm ci --prefix "$LANE_DIR/home/tools/$tool" >&2; fi
done

echo "$LANE_DIR"
