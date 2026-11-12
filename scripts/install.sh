#!/usr/bin/env bash
# Purpose: install the portable Claude Code setup on macOS/Linux (also Git Bash on Windows).
# Usage: scripts/install.sh [--dry-run] [--no-plugins] [--no-tools]
# Invariants: never deletes; anything replaced in ~/.claude is moved to ~/.claude-backup-<stamp>/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/.claude-backup-$STAMP"
LINKS=(CLAUDE.md rules skills agents standards hooks tools project-notes statusline.mjs)
DRY_RUN=0
WITH_PLUGINS=1
WITH_TOOLS=1
DONE=()

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-plugins) WITH_PLUGINS=0 ;;
    --no-tools) WITH_TOOLS=0 ;;
    *) echo "unknown flag: $arg (use --dry-run, --no-plugins, --no-tools)" >&2; exit 2 ;;
  esac
done

# Run a mutating command, or only print it under --dry-run.
act() { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
note() { DONE+=("$1"); echo "  $1"; }
summary() { echo; echo "Completed so far:"; printf '  - %s\n' "${DONE[@]:-nothing}"; }
trap 'rc=$?; [ $rc -ne 0 ] && { echo "FAILED (exit $rc). Already done:" >&2; summary >&2; }' EXIT

need() { command -v "$1" >/dev/null || { echo "missing required tool: $1 (see tools/Brewfile)" >&2; exit 1; }; }

# Move an existing, non-matching target into the backup dir.
backup() {
  local target="$1"
  [ -e "$target" ] || [ -L "$target" ] || return 0
  act mkdir -p "$BACKUP_DIR"
  act mv "$target" "$BACKUP_DIR/$(basename "$target")"
  note "backed up $(basename "$target") -> $BACKUP_DIR"
}

is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

# Link one item; on Windows fall back to copying when symlinks are not permitted.
link_item() {
  local name="$1" src="$REPO/home/$1" dst="$CLAUDE_DIR/$1"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then note "ok $name"; return; fi
  backup "$dst"
  if act ln -s "$src" "$dst" 2>/dev/null; then note "linked $name"; return; fi
  if is_windows; then
    echo "WARNING: symlink failed for $name (enable Developer Mode); copying instead" >&2
    act cp -R "$src" "$dst"; note "copied $name (not live-linked)"
  else
    echo "symlink failed for $name" >&2; exit 1
  fi
}

link_all() {
  act mkdir -p "$CLAUDE_DIR"
  for name in "${LINKS[@]}"; do link_item "$name"; done
  if [ -d "$REPO/home/commands" ] && [ -n "$(ls -A "$REPO/home/commands")" ]; then link_item commands; fi
}

detect_os() {
  case "$(uname -s)" in Darwin) echo macos ;; Linux) echo linux ;; *) echo windows ;; esac
}

# Deep-merge base + <os> + optional local, then substitute {{CLAUDE_HOME}}. Hook lists are appended per event (a plain
# jq `*` would let local.json's hooks replace base.json's), so a machine can add hooks without restating the shared ones.
MERGE_SETTINGS='reduce .[] as $f ({}; (. * ($f | del(.hooks)))
  | if $f.hooks then .hooks = reduce ($f.hooks | to_entries[]) as $e (.hooks // {}; .[$e.key] = ((.[$e.key] // []) + $e.value))
    else . end)'
build_settings() {
  need jq
  local os files=("$REPO/settings/base.json") out="$CLAUDE_DIR/settings.json" home_path="$CLAUDE_DIR"
  os="$(detect_os)"
  [ -f "$REPO/settings/$os.json" ] && files+=("$REPO/settings/$os.json")
  [ -f "$REPO/settings/local.json" ] && files+=("$REPO/settings/local.json")
  if is_windows; then home_path="$(cygpath -m "$CLAUDE_DIR" 2>/dev/null || echo "${CLAUDE_DIR//\\//}")"; fi
  local merged
  merged="$(jq -s "$MERGE_SETTINGS" "${files[@]}" | sed "s|{{CLAUDE_HOME}}|$home_path|g")"
  echo "$merged" | jq -e . >/dev/null
  if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] would write $out (${#files[@]} source files)"; return; fi
  if [ -f "$out" ]; then backup "$out"; fi
  echo "$merged" > "$out"
  note "wrote settings.json from: ${files[*]##*/}"
}

# Run `claude plugin` subcommands; print manual steps if the CLI lacks them.
install_plugins() {
  local manifest="$REPO/plugins/plugins.json"
  if ! command -v claude >/dev/null || ! claude plugin marketplace --help >/dev/null 2>&1; then
    echo "claude CLI plugin commands unavailable. Manual steps: run /plugin in Claude Code, add the marketplaces and plugins listed in plugins/plugins.json."
    return
  fi
  local repo_src
  while read -r repo_src; do act claude plugin marketplace add "$repo_src"; note "marketplace $repo_src"; done \
    < <(jq -r '.marketplaces[] | select(.source|startswith("github:")) | .source|sub("github:";"")' "$manifest")
  local id
  while read -r id; do act claude plugin install "$id"; note "plugin $id"; done \
    < <(jq -r '(.enabled + .disabled)[] | select(endswith("@gitkraken")|not)' "$manifest")
  echo "Note: enabled/disabled state comes from settings.json enabledPlugins. gitkraken is installed by the GitKraken app."
}

# Install ui-check's dependencies (odiff-bin, pngjs) from its lockfile; falls back to a plain install without one.
install_tool_deps() {
  local dir="$CLAUDE_DIR/tools/ui-check"
  if [ "$DRY_RUN" != 1 ] && [ ! -d "$dir" ]; then echo "skip ui-check deps: $dir not found" >&2; return; fi
  # npm ci --prefix through the ~/.claude/tools symlink reports a false lockfile mismatch: use the real path.
  [ -d "$dir" ] && dir=$(cd "$dir" && pwd -P)
  if [ -f "$REPO/home/tools/ui-check/pnpm-lock.yaml" ] && command -v pnpm >/dev/null; then act pnpm --dir "$dir" install --frozen-lockfile
  elif [ -f "$REPO/home/tools/ui-check/package-lock.json" ]; then act npm ci --prefix "$dir"
  else act npm install --prefix "$dir" --no-audit --no-fund; fi
  note "ui-check dependencies"
}

enable_hooks() {
  if [ -d "$REPO/.git" ]; then act git -C "$REPO" config core.hooksPath .githooks; note "git hooksPath = .githooks"; fi
}

link_all
build_settings
enable_hooks
if [ "$WITH_TOOLS" = 1 ]; then install_tool_deps; fi
if [ "$WITH_PLUGINS" = 1 ]; then install_plugins; fi
[ "$DRY_RUN" = 1 ] && echo "(dry-run: nothing changed)"
summary
