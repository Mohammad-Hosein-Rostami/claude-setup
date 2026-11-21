#!/usr/bin/env bash
# Purpose: read-only report on links, settings drift, plugins and tools for this Claude Code setup.
# Usage: scripts/doctor.sh [--all] [--live [--waived-lane]]   (exit 1 if any problem found; --live then runs scripts/doctor-live.sh on the
#   real tool: a permission dialog, a guard case, a workflow from a non-git folder, with --waived-lane one waived lane end to end)
# Output: a summary line first (`doctor (MacBook, Claude Code 2.1.328): 1 FAIL, 1 WARN, 38 ok`), then only the lines that are not
# ok, each with its fix; `--all` (or DOCTOR_ALL=1) prints every line as before. DOCTOR_ONLY runs keep every line (tests read them).
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
  for name in CLAUDE.md rules skills agents standards hooks tools project-notes modes workflows statusline.mjs; do
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

# True when version $1 (X.Y.Z) is $2 or later. The parts are compared as numbers: 2.1.99 is older than 2.1.295.
version_at_least() {
  local IFS=. i
  local -a have=($1) want=($2)
  for i in 0 1 2; do
    if [ "${have[$i]:-0}" -gt "${want[$i]:-0}" ]; then return 0; fi
    if [ "${have[$i]:-0}" -lt "${want[$i]:-0}" ]; then return 1; fi
  done
  return 0
}

# Node 22.15 or later: the guard's Windows path tests need module.registerHooks (added in 22.15) and are skipped without it.
check_node() {
  local version
  version="$(node -p 'process.versions.node' 2>/dev/null | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
  if version_at_least "${version:-0.0.0}" 22.15.0; then ok "node $version"
  else bad "node >= 22.15 required (found ${version:-none}): the guard's Windows path tests need module.registerHooks and are skipped without it"; fi
}

# Claude Code 2.1.326 or later (CLAUDE_FLOOR): the floor every phase pins (spec-p0-close.md 0.7). It covers the Bash guard's
# `onFailure: "block"` (2.1.295: an older CLI ignores it, so a guard that dies or times out lets the command run) and the
# PC's 2.1.323 and Windows' 2.1.316. The line also names the update channel and whether DISABLE_UPDATES pins the version.
CLAUDE_FLOOR=2.1.326
check_claude_version() {
  local version live="$CLAUDE_DIR/settings.json" channel pinned
  version="$(claude --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  channel="$(jq -r '.autoUpdatesChannel // "latest (default)"' "$live" 2>/dev/null || echo "unknown")"
  pinned="$(jq -r '.env.DISABLE_UPDATES // ""' "$live" 2>/dev/null || true)"
  pinned="${DISABLE_UPDATES:-$pinned}"
  pinned="update channel ${channel:-unknown}, DISABLE_UPDATES ${pinned:-not set}"
  if [ -z "$version" ]; then warn "claude --version gave no version: cannot check the floor $CLAUDE_FLOOR ($pinned)"
  elif version_at_least "$version" "$CLAUDE_FLOOR"; then ok "claude $version (floor $CLAUDE_FLOOR; $pinned)"
  else bad "claude >= $CLAUDE_FLOOR required (found $version; $pinned): below it the Bash guard's onFailure: block may be ignored and the phase pin does not hold; run claude update"; fi
}

# These variables override the model and effort every agent file and workflow script names (sub-agents.md:384, model-config.md:655-746;
# probe W-model: both model routes override a script's `model: 'sonnet'`), so the review floor would be flattened and no agent runs at
# the effort its file names. Set in the shell or in the live settings env: FAIL. One check for all three variables.
EFFORT_OVERRIDES="CLAUDE_CODE_SUBAGENT_MODEL_FORCE CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL"
check_effort_env() {
  local live="$CLAUDE_DIR/settings.json" name found=""
  for name in $EFFORT_OVERRIDES; do
    if [ -n "${!name:-}" ]; then found="$found $name (shell)"; fi
    if [ -n "$(jq -r --arg n "$name" '.env[$n] // ""' "$live" 2>/dev/null)" ]; then found="$found $name (settings.json env)"; fi
  done
  if [ -n "$found" ]; then bad "set:$found: it overrides the model or effort every agent and workflow picks (the review floor); unset it"
  else ok "no model or effort override variable set ($EFFORT_OVERRIDES)"; fi
}

# Projects (scripts/doctor-projects.mjs): a plugin the setup turns off that a project's settings.local.json turns on (WARN; the
# committed settings.json is listed and kept), and a project skill with a personal skill's name (WARN: the personal one wins, the
# project copy never loads). The projects are the folders Claude Code's global config lists, plus this one.
check_projects() {
  local out line rc=0
  out="$(node "$REPO/scripts/doctor-projects.mjs" "$HOME/.claude.json" "$CLAUDE_DIR" "$REPO" "${DOCTOR_PROJECT:-$PWD}" 2>/dev/null)" || rc=$?
  while IFS= read -r line; do
    case "$line" in
      "WARN  "*) warn "${line#WARN  }" ;;
      "ok    "*) ok "${line#ok    }" ;;
    esac
  done <<<"$out"
  [ "$rc" = 0 ] || bad "project checks could not run (scripts/doctor-projects.mjs exit $rc)"
}

check_hook_files() {
  local file missing=0
  while read -r file; do
    [ -f "$REPO/home/hooks/$file" ] || { bad "hook file missing: home/hooks/$file"; missing=1; }
  done < <(jq -r '[.. | .command? // empty] | .[] | scan("hooks/[A-Za-z0-9._-]+\\.mjs") | sub("hooks/";"")' "$REPO/settings/base.json" | sort -u)
  [ "$missing" = 0 ] && ok "hook files referenced by base.json exist"
  check_agent_hook_files
  return 0
}

# Hook files named in the frontmatter of home/agents/*.md (agent-memory-only, test-files-only) must exist too.
check_agent_hook_files() {
  local file missing=0
  while read -r file; do
    [ -f "$REPO/home/hooks/$file" ] || { bad "agent frontmatter hook file missing: home/hooks/$file"; missing=1; }
  done < <(grep -h 'command:.*hooks/[A-Za-z0-9._-]*\.mjs' "$REPO"/home/agents/*.md 2>/dev/null | grep -o 'hooks/[A-Za-z0-9._-]*\.mjs' | sed 's#hooks/##' | sort -u)
  [ "$missing" = 0 ] && ok "hook files referenced by agent frontmatter exist"
  return 0
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

# The suite output goes to a log file so a failure can be named. DOCTOR_TEST_COMMAND replaces the real suite (used by tests);
# DOCTOR_LOG_DIR moves the log. On failure: each failing test with its first error line (TAP "not ok" / "error:" lines), else the last log lines.
check_repo_tests() {
  local suite="${DOCTOR_TEST_COMMAND:-node --test --test-reporter=tap tests/*.test.mjs}"
  local log_dir="${DOCTOR_LOG_DIR:-$CLAUDE_DIR/logs}" log failing
  # Fallback when the log folder cannot be made: a fresh mktemp file, never a fixed name in a shared /tmp that another user could plant.
  if mkdir -p "$log_dir" 2>/dev/null; then log="$log_dir/doctor-repo-tests.log"; else log="$(mktemp "${TMPDIR:-/tmp}/doctor-repo-tests.XXXXXX")"; fi
  # A full-suite PASS that test-pass recorded for HEAD's tree (a landing or the last review round) is not worth a second run.
  # It counts only for a clean working tree (an edit since then is not covered by it), and test-pass is started by its real path
  # (a symlinked path makes older test-pass versions exit 0 without checking anything).
  local real_repo
  real_repo="$(cd "$REPO" && pwd -P)"
  if [ -z "$(git -C "$real_repo" status --porcelain 2>/dev/null)" ] \
    && node "$real_repo/home/tools/test-pass/test-pass.mjs" check HEAD --repo "$real_repo" --suite >/dev/null 2>&1; then ok "suite PASS recorded at HEAD"; return; fi
  # The suite runs in its own TMPDIR that is removed afterwards, so a doctor run leaves no temp folders.
  if (cd "$REPO" && node "$REPO/home/tools/disk-free/with-run-tmp.mjs" -- bash -c "$suite" >"$log" 2>&1); then ok "repo tests pass"; return; fi
  bad "repo tests fail (node --test tests/*.test.mjs); full output: $log"
  failing="$(awk '
    /^ *not ok [0-9]+ - /  { sub(/^ */, ""); print "      " $0; waiting = 1; next }
    waiting && /^ *error: / { sub(/^ *error: */, ""); if ($0 == "|-" || $0 == "|") { getline; sub(/^ */, "") } print "        " $0; waiting = 0 }
  ' "$log" | head -40)"
  if [ -n "$failing" ]; then echo "$failing"; else tail -n 15 "$log" | sed 's/^/      /'; fi
}

check_tools() {
  local t
  for t in jq rg gitleaks gh node claude; do
    if command -v "$t" >/dev/null; then ok "tool $t"; else bad "tool $t missing"; fi
  done
}

# env-names reads YAML deploy files with the `yaml` package; without it those files are skipped (the report says so).
check_env_names() {
  if [ -d "$REPO/home/tools/env-names/node_modules/yaml" ]; then ok "env-names dep yaml"; else bad "env-names dep yaml (run scripts/install.sh)"; fi
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

# The mode hook feeds _lead.md and the playbook to the lead; if it is not registered live, sessions silently run without rules.
check_mode_hook() {
  local live="$CLAUDE_DIR/settings.json" event missing=""
  for event in SessionStart UserPromptSubmit UserPromptExpansion; do
    jq -e --arg e "$event" '[.hooks[$e][]?.hooks[]?.command // empty | select(test("hooks/mode\\.mjs"))] | length > 0' "$live" >/dev/null 2>&1 || missing="$missing $event"
  done
  if [ -n "$missing" ]; then bad "mode hook not registered in settings.json for:$missing (SessionStart context will not reach sessions)"
  elif [ ! -f "$CLAUDE_DIR/hooks/mode.mjs" ]; then bad "mode hook file missing: $CLAUDE_DIR/hooks/mode.mjs"
  elif [ ! -s "$CLAUDE_DIR/modes/_lead.md" ]; then bad "modes/_lead.md missing or empty (lead rules are not injected)"
  else ok "mode hook registered for SessionStart, UserPromptSubmit, UserPromptExpansion"; fi
}

# A third-party plugin whose SessionStart hook injects EXTREMELY_IMPORTANT text can cost tens of thousands of tokens per session.
check_plugin_session_start() {
  local live="$CLAUDE_DIR/settings.json" installed="$CLAUDE_DIR/plugins/installed_plugins.json" id path flagged=0
  [ -f "$installed" ] || { warn "no installed_plugins.json: SessionStart injections of plugins not checked"; return; }
  while read -r id; do
    path="$(jq -r --arg id "$id" '.plugins[$id][0].installPath // empty' "$installed" 2>/dev/null)"
    [ -n "$path" ] && [ -f "$path/hooks/hooks.json" ] || continue
    jq -e '.hooks.SessionStart | length > 0' "$path/hooks/hooks.json" >/dev/null 2>&1 || continue
    if grep -rqs "EXTREMELY_IMPORTANT" "$path/hooks"; then warn "plugin $id injects EXTREMELY_IMPORTANT at SessionStart (large context cost; disable it if not wanted)"; flagged=1
    else ok "plugin $id has a SessionStart hook without EXTREMELY_IMPORTANT"; fi
  done < <(jq -r '.enabledPlugins // {} | to_entries[] | select(.value == true) | .key' "$live" 2>/dev/null)
  [ "$flagged" = 0 ] && ok "no enabled plugin injects EXTREMELY_IMPORTANT at SessionStart"
  return 0
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

# The wf-* skills call workflow scripts through ~/.claude/workflows (the link to home/workflows); settings must let Workflow read that link path.
check_workflows() {
  local skill name script live="$CLAUDE_DIR/settings.json" link_path="$CLAUDE_DIR/workflows" missing=0 RESUME_TOOL="tools/wf-resume/wf-resume.mjs"
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) link_path="$(cygpath -m "$CLAUDE_DIR" 2>/dev/null || echo "${CLAUDE_DIR//\\//}")/workflows" ;; esac
  for skill in "$REPO"/home/skills/wf-*/SKILL.md; do
    [ -f "$skill" ] || continue
    name="$(basename "$(dirname "$skill")")"
    script="$(grep -o 'workflows/[A-Za-z0-9._-]*\.js' "$skill" | head -1)"
    # wf-resume relaunches each run's stored script through its tool, so it names the tool instead of one script.
    [ -z "$script" ] && grep -q "$RESUME_TOOL" "$skill" && script="$RESUME_TOOL"
    if [ -z "$script" ]; then bad "$name names no workflow script"; missing=1
    elif [ ! -f "$CLAUDE_DIR/$script" ]; then bad "$name: $script missing under $CLAUDE_DIR (re-run scripts/install.sh)"; missing=1; fi
  done
  [ "$missing" = 0 ] && ok "every wf-* skill's workflow script exists under $CLAUDE_DIR/workflows"
  if jq -e --arg d "$link_path" '(.permissions.additionalDirectories // []) | index($d) != null' "$live" >/dev/null 2>&1; then ok "settings.json lets Workflow read $link_path"
  else bad "settings.json lacks permissions.additionalDirectories $link_path (re-run scripts/install.sh)"; fi
  return 0
}

# A project's own .claude/agents files that set maxTurns or shadow a personal agent stop agents mid-task (the owner's rule is no maxTurns).
check_project_agents() {
  local project note shown_project
  # The physical folder, as Claude Code hands it to a hook: through a link spelling the note would list files a session never sees.
  project="$(cd "${DOCTOR_PROJECT:-$PWD}" 2>/dev/null && pwd -P)" || project="${DOCTOR_PROJECT:-$PWD}"
  # The folder name comes from a repository or an archive: it is shown escaped down to printable ASCII by the same code as the note's
  # file names, so no control character (ESC, BEL: window title, colours) reaches the terminal, whatever the locale.
  shown_project="$(node "$REPO/home/hooks/lib/shown-name.mjs" "$project" 2>/dev/null)"
  [ -n "$shown_project" ] || shown_project="(this project: its path could not be shown)"
  note="$(node "$REPO/home/hooks/lib/project-agents.mjs" "$project" "$CLAUDE_DIR/agents" 2>/dev/null)"
  # The note names files relative to the project, so the line names the project itself.
  if [ -n "$note" ]; then warn "$shown_project: $note"; else ok "project agents in $shown_project: nothing to report (no maxTurns, no shadowed agent, nothing left unchecked)"; fi
}

# Accounts (spec-accounts.md Safety): a literal token in start-up files or settings env blocks, a pasted token in shell history,
# the claude-as start-up line, fastMode and a forced Fable model, per account revoked / year end / plan / usage credits, and one
# tiny login call on the account a hook job would spend. scripts/doctor-accounts.mjs prints the lines and never a token; its
# stderr is dropped (an error text could name more than a check needs), so a crash shows as its exit code only.
check_accounts() {
  local out line rc=0
  out="$(node "$REPO/scripts/doctor-accounts.mjs" "$CLAUDE_DIR" "$REPO" "${DOCTOR_PROJECT:-$PWD}" 2>/dev/null)" || rc=$?
  while IFS= read -r line; do
    case "$line" in
      "FAIL  "*) bad "${line#FAIL  }" ;;
      "WARN  "*) warn "${line#WARN  }" ;;
      "ok    "*) ok "${line#ok    }" ;;
    esac
  done <<<"$out"
  [ "$rc" = 0 ] || bad "account checks could not run (scripts/doctor-accounts.mjs exit $rc)"
}

# Stop-hook block cap (hooks/lib/stop-block-count.mjs): Claude Code overrides the next Stop block after CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
# blocks in a row. The live settings must set it to the counter's STOP_BLOCK_CAP (unset or 0 is a FAIL: the counter would count against
# a number Claude Code does not use), and every `gate overridden` / `gate crashed or timed out` record of the last 7 days is listed.
check_stop_cap() {
  local live="$CLAUDE_DIR/settings.json" lib="$REPO/home/hooks/lib/stop-block-count.mjs" cap expected records
  cap="$(jq -r '.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP // ""' "$live" 2>/dev/null)"
  expected="$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then((m) => console.log(m.STOP_BLOCK_CAP))' "$lib" 2>/dev/null)"
  if [ -z "$cap" ] || [ "$cap" = "0" ]; then bad "settings.json env CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is ${cap:-unset}: set it to ${expected:-8} in settings/base.json and re-run scripts/install.sh"
  elif [ "$cap" != "$expected" ]; then bad "settings.json env CLAUDE_CODE_STOP_HOOK_BLOCK_CAP is $cap, the stop-block counter counts to ${expected:-?} (home/hooks/lib/stop-block-count.mjs STOP_BLOCK_CAP)"
  else ok "stop-hook block cap $cap matches the counter"; fi
  records="$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then((m) => { for (const r of m.readRecords(process.env, { sinceMs: Date.now() - 7 * 864e5, max: 20 })) console.log(`${new Date(r.at).toISOString()} ${r.agent}: ${r.text}`); })' "$lib" 2>/dev/null)"
  if [ -z "$records" ]; then ok "no stop gate overridden, crashed or timed out in the last 7 days"; return 0; fi
  while IFS= read -r line; do warn "stop gate record: $line"; done <<<"$records"
  return 0
}

# Desktop notes (hooks/notify.mjs): the terminal and the channel a note goes out on. Desktop notes show only in Ghostty, Kitty and
# iTerm2 (and OSC 9 terminals such as WezTerm and Windows Terminal); Apple Terminal shows none, and tmux passes a note on only with
# allow-passthrough on.
check_notify() {
  local line terminal channel passthrough
  line="$(node "$REPO/home/hooks/notify.mjs" --channel 2>/dev/null)" || { bad "notify: hooks/notify.mjs --channel failed"; return; }
  terminal="${line% *}"; channel="${line##* }"
  if [ "$channel" = notifications_disabled ]; then ok "notify: notes off (preferredNotifChannel notifications_disabled) in $terminal"
  elif [ "$terminal" = Apple_Terminal ]; then warn "notify: Apple Terminal shows no desktop note (at most a bell): use Ghostty, Kitty or iTerm2 for the needs-you notes"
  else ok "notify: $terminal, channel $channel"; fi
  if [ -n "${TMUX:-}" ]; then
    passthrough="$(tmux show -gv allow-passthrough 2>/dev/null || true)"
    [ "$passthrough" = on ] || warn "notify: tmux without allow-passthrough drops the desktop notes (tmux set -g allow-passthrough on)"
  fi
}

# DOCTOR_ONLY="check_a check_b" runs just those checks (used by tests; the full run executes the repo tests).
run_checks() {
  local check
  if [ -n "${DOCTOR_ONLY:-}" ]; then for check in $DOCTOR_ONLY; do "$check"; done; return; fi
  check_links; check_settings; check_plugins; check_plugin_parity; check_node; check_claude_version; check_effort_env; check_hook_files; check_prod_hosts; check_mode_hook; check_plugin_session_start; check_recall; check_stop_cap; check_disk_free; check_disk_clean; check_native_cleanup; check_tools; check_accounts; check_notify; check_lsp; check_ui_check; check_project_agents; check_projects; check_workflows; check_env_names; check_repo_tests
}
# The machine's name in the summary: the owner's two machines by OS, else the host name; DOCTOR_MACHINE overrides it.
machine_name() {
  if [ -n "${DOCTOR_MACHINE:-}" ]; then echo "$DOCTOR_MACHINE"; return; fi
  case "$(uname -s)" in Darwin) echo MacBook ;; MINGW*|MSYS*|CYGWIN*) echo PC ;; *) uname -n ;; esac
}

# The full run: every check's lines go to a file (in this shell, so BAD still counts), then the summary and the lines not ok.
# The counts are of the ok / WARN / FAIL lines; INFO and detail lines (a failing test's output) are shown, never counted.
print_summary() {
  local out version fails warns oks
  out="$(mktemp "${TMPDIR:-/tmp}/doctor.XXXXXX")" || { run_checks; return; }
  run_checks >"$out"
  version="$(claude --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  fails="$(grep -c '^FAIL  ' "$out")"; warns="$(grep -c '^WARN  ' "$out")"; oks="$(grep -c '^ok    ' "$out")"
  echo "doctor ($(machine_name), Claude Code ${version:-unknown}): $fails FAIL, $warns WARN, $oks ok"
  grep -v '^ok    ' "$out"
  rm -f "$out"
}

want_all=0; want_live=0; waived_lane=""
for arg in "$@"; do
  case "$arg" in --all) want_all=1 ;; --live) want_live=1 ;; --waived-lane) waived_lane="--waived-lane" ;; esac
done
if [ -n "${DOCTOR_ONLY:-}" ] || [ "${DOCTOR_ALL:-}" = 1 ] || [ "$want_all" = 1 ]; then run_checks; else print_summary; fi
if [ "$want_live" = 1 ]; then
  "$REPO/scripts/doctor-live.sh" $waived_lane || BAD=1
fi
exit "$BAD"
