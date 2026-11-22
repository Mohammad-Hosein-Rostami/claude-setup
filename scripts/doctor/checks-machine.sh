#!/usr/bin/env bash
# This machine's checks: Node, the shell on Windows, tools on PATH, the production-host list, ui-check dependencies, the LSP server, recall,
# free disk, disk-clean and Claude Code's own sweep (sourced by scripts/doctor.sh, which holds the helpers ok, bad and warn, the
# variables REPO and CLAUDE_DIR, and the run order in run_checks). Defines functions only; nothing runs when this file is sourced.
# Exports: check_node, check_windows_shell, check_tools, check_prod_hosts, check_ui_check, check_lsp, check_recall, check_disk_free, check_disk_clean, check_native_cleanup.
# Invariants: read-only, as doctor.sh is; every line is `ok`, `WARN`, `FAIL` or `INFO` text on stdout; a check that fails calls bad (BAD=1).

# Node 22.15 or later: the guard's Windows path tests need module.registerHooks (added in 22.15) and are skipped without it.
check_node() {
  local version
  version="$(node -p 'process.versions.node' 2>/dev/null | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
  if version_at_least "${version:-0.0.0}" 22.15.0; then ok "node $version"
  else bad "node >= 22.15 required (found ${version:-none}): the guard's Windows path tests need module.registerHooks and are skipped without it"; fi
}

# Windows (spec-p7 r9-windows; tools-reference): with Git Bash present any Bash deny rule turns the PowerShell tool off unless
# CLAUDE_CODE_USE_POWERSHELL_TOOL=1, and without Git Bash PowerShell is the only shell. settings/windows.json sets it to 0, and
# every Bash hook matcher also names PowerShell, so a PowerShell command is either off or guarded. doctor itself runs in Git Bash.
check_windows_shell() {
  local live="$CLAUDE_DIR/settings.json" tool unguarded
  ok "Git Bash ${BASH_VERSION:-?} (${CLAUDE_CODE_GIT_BASH_PATH:-found on PATH})"
  tool="$(jq -r '.env.CLAUDE_CODE_USE_POWERSHELL_TOOL // ""' "$live" 2>/dev/null)"
  if [ "$tool" = 0 ]; then ok "PowerShell tool off (CLAUDE_CODE_USE_POWERSHELL_TOOL=0)"
  elif [ -n "$tool" ]; then warn "PowerShell tool on (CLAUDE_CODE_USE_POWERSHELL_TOOL=$tool): only the Bash|PowerShell hook matchers guard it"
  else bad "settings.json env lacks CLAUDE_CODE_USE_POWERSHELL_TOOL=0 (settings/windows.json; re-run scripts/install.ps1)"; fi
  unguarded="$(jq -r '[.hooks[]?[]? | .matcher? // empty | select(test("(^|[|])Bash($|[|])") and (test("PowerShell") | not))] | length' "$live" 2>/dev/null)"
  if [ "${unguarded:-1}" = 0 ]; then ok "every Bash hook matcher also matches PowerShell"
  else bad "$unguarded hook matcher(s) name Bash without PowerShell (settings/base.json: use Bash|PowerShell)"; fi
}

# Private list of production hosts for pre-bash-guard (ssh/scp/rsync/psql/mysql writes ask). Missing file: only names containing "prod" ask.
check_prod_hosts() {
  local file="${CLAUDE_PROD_HOSTS_FILE:-$CLAUDE_DIR/private/prod-hosts}" count
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
    bad "prod-hosts is a link or not a plain file ($file): the guard then asks for every ssh/scp/rsync/psql/mysql write; put a plain file there"
  elif [ -f "$file" ]; then
    count="$(sed 's/#.*//' "$file" | grep -c '[^[:space:]]' || true)"
    ok "prod-hosts list: $count entries ($file)"
  else
    warn "no prod-hosts list: ssh/scp/psql writes ask only for hosts named *prod* (copy settings/prod-hosts.example to $file)"
  fi
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

# recall's final stack: embedding models in Ollama, the two reranker GGUFs, the checkpoint/digest hooks, the last
# checkpoint error (a broken `claude` would otherwise silently stop live notes), the index age and the last 10 checkpoint
# calls. Missing models/files are warnings
# (search falls back), a missing hook registration is a FAIL (long sessions would lose their notes at compaction).
check_recall() {
  local live="$CLAUDE_DIR/settings.json" url="${RECALL_OLLAMA_URL:-http://127.0.0.1:11434}" models="${RECALL_RERANK_MODEL_DIR:-$HOME/.cache/recall-models}"
  local state="${RECALL_STATE_DIR:-$(dirname "${RECALL_DB:-$HOME/.claude/recall/index.db}")}" tags name file missing="" f errors
  tags="$(curl -s --max-time 2 "$url/api/tags" 2>/dev/null)"
  if [ -z "$tags" ]; then warn "recall: Ollama not reachable at $url (search is lexical only; start it with: ollama serve)"
  else
    for name in bge-m3 hf.co/Qwen/Qwen3-Embedding-4B-GGUF; do printf '%s' "$tags" | grep -qF "\"$name" || missing="$missing $name"; done
    if [ -n "$missing" ]; then warn "recall: Ollama models not pulled:$missing"; else ok "recall: Ollama has bge-m3 and qwen3-embedding-4b"; fi
  fi
  missing=""
  for file in qwen3-reranker-0.6b-q8_0.gguf qwen3-reranker-4b-q8_0.gguf; do [ -s "$models/$file" ] || missing="$missing $file"; done
  if [ -n "$missing" ]; then warn "recall: reranker files missing in $models:$missing (search keeps the fused order)"; else ok "recall: reranker files present"; fi
  command -v llama-server >/dev/null || warn "recall: llama-server not on PATH (brew install llama.cpp); reranking is skipped"
  missing=""
  for event in PostToolUse PreCompact; do
    jq -e --arg e "$event" '[.hooks[$e][]?.hooks[]?.command // empty | select(test("hooks/checkpoint\\.mjs"))] | length > 0' "$live" >/dev/null 2>&1 || missing="$missing $event"
  done
  jq -e '[.hooks.SessionStart[]?.hooks[]?.command // empty | select(test("hooks/recall-digest\\.mjs"))] | length > 0' "$live" >/dev/null 2>&1 || missing="$missing SessionStart(recall-digest)"
  if [ -n "$missing" ]; then bad "recall: checkpoint hooks not registered in settings.json for:$missing"; else ok "recall: checkpoint hook registered for PostToolUse and PreCompact, digest for SessionStart"; fi
  errors=""
  for f in "$state"/checkpoints/*.json; do
    [ -f "$f" ] || continue
    errors="$errors$(jq -r 'select(.error) | "\(.session[0:8]): \(.error.message) (\(.error.ts))"' "$f" 2>/dev/null | tr -d '\000-\037\177')"$'\n'
  done
  errors="$(printf '%s' "$errors" | sed '/^$/d' | tail -1)"
  if [ -n "$errors" ]; then warn "recall: last checkpoint error: $errors"; else ok "recall: no checkpoint errors"; fi
  # Index freshness and the last 10 checkpoint calls (tools/recall/health.mjs prints ok|WARN lines in this format).
  node "$REPO/home/tools/recall/health.mjs" 2>&1 | tr -d '\000-\010\013-\037\177' || warn "recall: health check could not run"
}

# Free disk (tools/disk-free): FAIL below 5 GB, WARN below 15 GB (DISK_FAIL_FREE_GB / DISK_WARN_FREE_GB move them). The tool prints one line,
# `ok|WARN|FAIL  <message>`, and the message names the biggest rebuildable caches; a full disk makes every agent fail with ENOSPC.
check_disk_free() {
  local out level message
  if ! out="$(node "$REPO/home/tools/disk-free/disk-free.mjs" check 2>&1)" && [ "${out%% *}" != "FAIL" ]; then
    bad "disk free check could not run: $out"; return
  fi
  level="${out%% *}"; message="$(sed 's/^[A-Za-z]*  *//' <<<"$out")"
  case "$level" in
    ok) ok "$message" ;;
    WARN) warn "$message" ;;
    *) bad "$message" ;;
  esac
}

# What disk-clean (dry run) could remove: an INFO line with the total, a WARN above 2 GB. DOCTOR_DISK_CLEAN_ARGS adds flags (tests point the
# roots at fake folders; the dry run stops looking after 30 s, so doctor stays fast and the total is then a lower bound).
check_disk_clean() {
  local json summary level message errors warn_bytes="${DOCTOR_DISK_CLEAN_WARN_BYTES:-2147483648}" # 2 GB; the variable is a test hook
  errors="$(mktemp)"
  if ! json="$(node "$REPO/home/tools/disk-free/disk-clean.mjs" --json ${DOCTOR_DISK_CLEAN_ARGS:-} 2>"$errors")"; then
    echo "INFO  disk-clean dry run could not run: $json $(cat "$errors")"; rm -f "$errors"; return
  fi
  rm -f "$errors" # stderr stays out of the JSON
  summary="$(node -e 'const r = JSON.parse(process.argv[1]); console.log(`${r.bytes > Number(process.argv[2]) ? "WARN" : "INFO"} ${r.items} items, ${(r.bytes / 1024 ** 3).toFixed(2)} GB${r.partial ? " or more" : ""}`)' "$json" "$warn_bytes")"
  level="${summary%% *}"
  message="disk-clean could remove ${summary#* }: run node ~/.claude/tools/disk-free/disk-clean.mjs --apply"
  if [ "$level" = "WARN" ]; then warn "$message"; else echo "INFO  $message"; fi
}

# What Claude Code sweeps itself (disk-clean adds no rule there): cleanupPeriodDays in effect (default 30 days; recall loses what is
# swept) and what `claude purge --all --dry-run` lists, summed with du (purge prints no size). INFO lines; nothing is purged.
check_native_cleanup() {
  local days out items kb
  days="$(jq -r '.cleanupPeriodDays // empty' "$CLAUDE_DIR/settings.json" 2>/dev/null | tr -cd '0-9')"
  if [ -n "$days" ]; then echo "INFO  cleanupPeriodDays: $days (Claude Code deletes older transcripts; recall loses them)"
  else echo "INFO  cleanupPeriodDays: 30 (default, not set; Claude Code deletes older transcripts; recall loses them)"; fi
  command -v claude >/dev/null || { echo "INFO  claude purge size: claude not on PATH"; return 0; }
  if ! out="$(claude purge --all --dry-run 2>/dev/null)"; then echo "INFO  claude purge size: the dry run could not run"; return 0; fi
  items="$(sed -nE 's/^Dry run: ([0-9]+) item.*/\1/p' <<<"$out")"
  kb="$(sed -nE 's/^  (dir|file): +//p' <<<"$out" | while IFS= read -r path; do [ -e "$path" ] && du -sk "$path" 2>/dev/null | cut -f1; done | awk '{ s += $1 } END { print s + 0 }')"
  echo "INFO  claude purge --all would delete ${items:-?} items, $(awk -v k="$kb" 'BEGIN { printf "%.2f", k / 1048576 }') GB (dry run; nothing purged)"
}
