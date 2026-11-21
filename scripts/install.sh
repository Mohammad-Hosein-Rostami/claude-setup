#!/usr/bin/env bash
# Purpose: install, update or remove the Claude Code setup on macOS, Linux and Git Bash: find Node and run scripts/install.mjs,
#   the one installer logic (its header lists the flags).
# Usage: scripts/install.sh [--update [--to <tag>]] [--uninstall] [--dry-run] [--no-plugins] [--no-tools] [--project-workflows <repo> [--copy]]
# Invariants: holds no install step of its own; the exit code is install.mjs's (0 done, 1 a step failed, 2 bad usage).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR_MIN=22 # the Node the tools and hooks are written for

command -v node >/dev/null || { echo "missing required tool: node ${NODE_MAJOR_MIN}+ (macOS: brew install node; Linux: your package manager or nvm)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge "$NODE_MAJOR_MIN" ] || { echo "node $major found; the setup needs node ${NODE_MAJOR_MIN}+" >&2; exit 1; }
exec node "$REPO/scripts/install.mjs" "$@"
