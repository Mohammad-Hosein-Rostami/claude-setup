#!/usr/bin/env bash
# Purpose: install, update or remove the Claude Code setup on macOS, Linux and Git Bash: find Node and run scripts/install.mjs,
#   the one installer logic (its header lists the flags).
# Usage: scripts/install.sh [--update [--to <tag>]] [--uninstall] [--dry-run] [--no-plugins] [--no-tools]
# Invariants: holds no install step of its own; the exit code is install.mjs's (0 done, 1 a step failed, 2 bad usage).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The one Node floor (major.minor), the same in install.ps1 and scripts/doctor/checks-machine.sh: the guard's Windows path tests need
# module.registerHooks, which Node has from 22.15, and doctor FAILs below it.
NODE_FLOOR=22.15

command -v node >/dev/null || { echo "missing required tool: node ${NODE_FLOOR}+ (macOS: brew install node; Linux: your package manager or nvm)" >&2; exit 1; }
version="$(node -p 'process.versions.node')"
IFS=. read -r major minor _ <<<"$version"
IFS=. read -r floor_major floor_minor <<<"$NODE_FLOOR"
if [ "$major" -lt "$floor_major" ] || { [ "$major" -eq "$floor_major" ] && [ "$minor" -lt "$floor_minor" ]; }; then
  echo "node $version found; the setup needs node ${NODE_FLOOR}+" >&2
  exit 1
fi
exec node "$REPO/scripts/install.mjs" "$@"
