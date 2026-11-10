#!/usr/bin/env bash
# Purpose: read-only report on links, settings drift, plugins and tools for this Claude Code setup.
# Usage: scripts/doctor.sh   (exit 1 if any problem found)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
BAD=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; BAD=1; }

check_links() {
  local name
  for name in CLAUDE.md rules skills agents standards hooks tools statusline.mjs; do
    if [ -L "$CLAUDE_DIR/$name" ] && [ "$(readlink "$CLAUDE_DIR/$name")" = "$REPO/home/$name" ]; then ok "link $name"
    else bad "link $name (re-run scripts/install.sh)"; fi
  done
}

# Drift: rebuild the expected settings.json in memory and compare with the live one.
check_settings() {
  local os files=("$REPO/settings/base.json") expected
  case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) os=windows ;; esac
  [ -f "$REPO/settings/$os.json" ] && files+=("$REPO/settings/$os.json")
  [ -f "$REPO/settings/local.json" ] && files+=("$REPO/settings/local.json")
  expected="$(jq -S -s 'reduce .[] as $f ({}; . * $f)' "${files[@]}" | sed "s|{{CLAUDE_HOME}}|$CLAUDE_DIR|g")"
  if [ "$expected" = "$(jq -S . "$CLAUDE_DIR/settings.json" 2>/dev/null)" ]; then ok "settings.json matches repo"
  else bad "settings.json differs from repo (live edits? move them into settings/*.json)"; fi
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
  if (cd "$project" && node --input-type=module -e "
    import { loadChromium } from '$tool/lib/browser.mjs';
    import fs from 'node:fs';
    const path = loadChromium('.').executablePath();
    if (!fs.existsSync(path)) { console.error('Chromium missing: ' + path); process.exit(1); }
  " 2>/dev/null); then ok "playwright + chromium from $project"
  else bad "playwright/chromium not found from $project (set DOCTOR_PROJECT; npx playwright install chromium)"; fi
}

check_links; check_settings; check_plugins; check_tools; check_ui_check
exit "$BAD"
