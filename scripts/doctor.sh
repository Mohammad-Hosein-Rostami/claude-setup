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
  if [ -f "$file" ]; then
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
  if node "$REPO/home/tools/test-pass/test-pass.mjs" check HEAD --repo "$REPO" --suite >/dev/null 2>&1; then ok "suite PASS recorded at HEAD"; return; fi
  if (cd "$REPO" && bash -c "$suite" >"$log" 2>&1); then ok "repo tests pass"; return; fi
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

# recall's final stack: embedding models in Ollama, the two reranker GGUFs, the checkpoint/digest hooks, and the last
# checkpoint error (a broken `claude` would otherwise silently stop live notes). Missing models/files are warnings
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
}

# The wf-* skills call workflow scripts through ~/.claude/workflows (the link to home/workflows); settings must let Workflow read that link path.
check_workflows() {
  local skill name script live="$CLAUDE_DIR/settings.json" link_path="$CLAUDE_DIR/workflows" missing=0
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) link_path="$(cygpath -m "$CLAUDE_DIR" 2>/dev/null || echo "${CLAUDE_DIR//\\//}")/workflows" ;; esac
  for skill in "$REPO"/home/skills/wf-*/SKILL.md; do
    [ -f "$skill" ] || continue
    name="$(basename "$(dirname "$skill")")"
    script="$(grep -o 'workflows/[A-Za-z0-9._-]*\.js' "$skill" | head -1)"
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
  local project="${DOCTOR_PROJECT:-$PWD}" note
  note="$(node "$REPO/home/hooks/lib/project-agents.mjs" "$project" "$CLAUDE_DIR/agents" 2>/dev/null)"
  if [ -n "$note" ]; then warn "$note"; else ok "project agents in $project: no maxTurns, no shadowed personal agent"; fi
}

# DOCTOR_ONLY="check_a check_b" runs just those checks (used by tests; the full run executes the repo tests).
run_checks() {
  local check
  if [ -n "${DOCTOR_ONLY:-}" ]; then for check in $DOCTOR_ONLY; do "$check"; done; return; fi
  check_links; check_settings; check_plugins; check_plugin_parity; check_node; check_hook_files; check_prod_hosts; check_mode_hook; check_plugin_session_start; check_recall; check_tools; check_lsp; check_ui_check; check_project_agents; check_workflows; check_env_names; check_repo_tests
}
run_checks
exit "$BAD"
