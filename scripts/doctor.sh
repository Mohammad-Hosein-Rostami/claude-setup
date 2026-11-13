#!/usr/bin/env bash
# Purpose: read-only report on links, settings drift, plugins and tools for this Claude Code setup.
# Usage: scripts/doctor.sh   (exit 1 if any problem found)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
BAD=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; BAD=1; }
warn() { echo "WARN  $1"; }

is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

# On Git Bash install.sh may have copied instead of linking (no symlink permission): a present copy is a warning, not a FAIL.
check_links() {
  local name target
  for name in CLAUDE.md rules skills agents standards hooks tools project-notes modes statusline.mjs; do
    target="$CLAUDE_DIR/$name"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$REPO/home/$name" ]; then ok "link $name"
    elif is_windows && [ -e "$target" ] && [ ! -L "$target" ]; then ok "copy $name (not live-linked; re-run install.sh after repo changes)"
    else bad "link $name (re-run scripts/install.sh)"; fi
  done
  target="$HOME/.local/bin/ccm"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$REPO/home/bin/ccm" ]; then ok "link ccm"
  elif is_windows && [ -f "$target" ] && cmp -s "$REPO/home/bin/ccm" "$target"; then ok "copy ccm"
  else bad "link ccm (re-run scripts/install.sh)"; fi
  if command -v ccm >/dev/null; then ok "ccm on PATH"; else bad "ccm not on PATH (add ~/.local/bin to PATH)"; fi
}

# Drift: rebuild the expected settings.json in memory and compare with the live one.
check_settings() {
  local os files=("$REPO/settings/base.json") expected home_path="$CLAUDE_DIR"
  case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) os=windows ;; esac
  [ -f "$REPO/settings/$os.json" ] && files+=("$REPO/settings/$os.json")
  [ -f "$REPO/settings/local.json" ] && files+=("$REPO/settings/local.json")
  case "$os" in windows) home_path="$(cygpath -m "$CLAUDE_DIR" 2>/dev/null || echo "${CLAUDE_DIR//\\//}")" ;; esac
  expected="$(jq -S -s -f "$REPO/scripts/merge-settings.jq" "${files[@]}" | sed "s|{{CLAUDE_HOME}}|$home_path|g")"
  local live
  if ! live="$(jq -S . "$CLAUDE_DIR/settings.json" 2>/dev/null)"; then bad "settings.json missing or invalid JSON"; return
  elif [ "$expected" = "$live" ]; then ok "settings.json matches repo"
  else bad "settings.json differs from repo (live edits? move them into settings/*.json)"; fi
  check_deny_rules
}

# Safety floor: every deny rule in base.json must be present in the live settings.json; hooks must not be disabled.
check_deny_rules() {
  local live="$CLAUDE_DIR/settings.json" missing
  missing="$(jq -rn --slurpfile b "$REPO/settings/base.json" --slurpfile l "$live" \
    '($l[0].permissions.deny // []) as $d | ($b[0].permissions.deny // [])[] | select(. as $r | $d | index($r) | not)' 2>/dev/null)"
  if [ -n "$missing" ]; then bad "base deny rules missing from settings.json: $(tr '\n' ' ' <<<"$missing")"
  else ok "base deny rules present in settings.json"; fi
  if [ "$(jq -r '.disableAllHooks // false' "$live" 2>/dev/null)" = "true" ]; then warn "disableAllHooks is true: no hooks run"; fi
}

check_plugins() {
  command -v claude >/dev/null || { bad "claude CLI not found"; return; }
  local installed id
  installed="$(claude plugin list --json 2>/dev/null | jq -r '.[].id // empty' 2>/dev/null)"
  while read -r id; do
    case "$id" in *@gitkraken) continue ;; esac
    if grep -qx "$id" <<<"$installed"; then ok "plugin $id"; else bad "plugin $id not installed"; fi
  done < <(jq -r '.enabled[]' "$REPO/plugins/plugins.json")
}

# settings/base.json enabledPlugins must agree with plugins/plugins.json (enabled -> true, disabled -> false).
check_plugin_parity() {
  local diff
  diff="$(jq -rn --slurpfile b "$REPO/settings/base.json" --slurpfile p "$REPO/plugins/plugins.json" '
    ($b[0].enabledPlugins // {}) as $e
    | [ $p[0].enabled[] | select($e[.] != true) | "enabled in plugins.json but not true in base.json: " + . ],
      [ $p[0].disabled[] | select($e[.] != false) | "disabled in plugins.json but not false in base.json: " + . ],
      [ $e | keys[] as $k | select(($p[0].enabled + $p[0].disabled) | index($k) | not) | "in base.json only: " + $k ]
    | .[]' 2>&1)"
  if [ -z "$diff" ]; then ok "plugins.json matches base.json enabledPlugins"; else bad "plugin parity: $diff"; fi
}

check_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 22 ]; then ok "node $major"; else bad "node >= 22 required (found ${major})"; fi
}

check_hook_files() {
  local file missing=0
  while read -r file; do
    [ -f "$REPO/home/hooks/$file" ] || { bad "hook file missing: home/hooks/$file"; missing=1; }
  done < <(jq -r '[.. | .command? // empty] | .[] | scan("hooks/[A-Za-z0-9._-]+\\.mjs") | sub("hooks/";"")' "$REPO/settings/base.json" | sort -u)
  [ "$missing" = 0 ] && ok "hook files referenced by base.json exist"
  return 0
}

# Private list of production hosts for pre-bash-guard (ssh/scp/rsync/psql/mysql writes ask). Missing file: only names containing "prod" ask.
check_prod_hosts() {
  local file="${CLAUDE_PROD_HOSTS_FILE:-$CLAUDE_DIR/private/prod-hosts}" count
  if [ -f "$file" ]; then
    count="$(sed 's/#.*//' "$file" | grep -c '[^[:space:]]' || true)"
    ok "prod-hosts list: $count entries ($file)"
  else
    warn "no prod-hosts list: ssh/scp/psql writes ask only for hosts named *prod* (copy settings/prod-hosts.example to $file)"
  fi
}

check_repo_tests() {
  if (cd "$REPO" && node --test tests/*.test.mjs >/dev/null 2>&1); then ok "repo tests pass"; else bad "repo tests fail (node --test tests/*.test.mjs)"; fi
}

check_tools() {
  local t
  for t in jq rg gitleaks gh node claude; do
    if command -v "$t" >/dev/null; then ok "tool $t"; else bad "tool $t missing"; fi
  done
}

# ui-check: its dependencies resolve, and Playwright + Chromium are found from PROJECT (default: cwd).
check_ui_check() {
  local tool="$REPO/home/tools/ui-check" project="${DOCTOR_PROJECT:-$PWD}" dep
  for dep in odiff-bin pngjs; do
    if [ -d "$tool/node_modules/$dep" ]; then ok "ui-check dep $dep"; else bad "ui-check dep $dep (run scripts/install.sh)"; fi
  done
  # Exit 2 = the project has no Playwright (ui-check uses the project's own, so there is nothing to check here).
  local rc=0
  (cd "$project" && node --input-type=module -e "
    import { loadChromium } from '$tool/lib/browser.mjs';
    import fs from 'node:fs';
    let chromium;
    try { chromium = loadChromium('.'); } catch (error) { if (error.name === 'UsageError') process.exit(2); throw error; }
    const path = chromium.executablePath();
    if (!fs.existsSync(path)) { console.error('Chromium missing: ' + path); process.exit(1); }
  " 2>/dev/null) || rc=$?
  case "$rc" in
    0) ok "playwright + chromium from $project" ;;
    2) ok "playwright: none in $project (ui-check uses each project's own; set DOCTOR_PROJECT to check one)" ;;
    *) bad "chromium missing for the Playwright in $project (run there: npx playwright install chromium)" ;;
  esac
}

# The typescript-lsp plugin needs typescript-language-server on PATH, else its LSP tool does nothing.
check_lsp() {
  local live="$CLAUDE_DIR/settings.json"
  [ "$(jq -r '.enabledPlugins["typescript-lsp@claude-plugins-official"] // false' "$live" 2>/dev/null)" = "true" ] || return 0
  if command -v typescript-language-server >/dev/null; then ok "tool typescript-language-server"
  else warn "LSP tool inactive: brew install typescript-language-server (Windows: npm i -g typescript-language-server typescript)"; fi
}

check_links; check_settings; check_plugins; check_plugin_parity; check_node; check_hook_files; check_prod_hosts; check_tools; check_lsp; check_ui_check; check_repo_tests
exit "$BAD"
