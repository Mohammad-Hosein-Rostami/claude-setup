#!/usr/bin/env bash
# The setup's own checks: its settings, plugins, hooks, token budget, accounts, caps and notes (sourced by scripts/doctor.sh, which
# holds the helpers ok, bad, warn and warn_unless_accepted, the variables REPO, CLAUDE_DIR, LINK_ROOT and BAD, and the run order in run_checks).
# Defines functions only; nothing runs when this file is sourced, so no output comes from it. Exports: check_settings, check_deny_rules, check_plugins, check_plugin_parity, check_effort_env, check_projects, check_env_names, check_session_notes_hook, check_token_budget, check_plugin_session_start, check_workflows_gone, check_project_agents, check_accounts, check_stop_cap, check_agent_cap, check_notify, check_done_check.
# Invariants: read-only, as doctor.sh is; every line is `ok`, `WARN`, `FAIL` or `INFO` text on stdout; a check that fails calls bad (BAD=1).

# Drift: rebuild the expected settings.json in memory and compare with the live one.
check_settings() {
  local os files=() expected home_path="$CLAUDE_DIR"
  if [ -n "$FIRST_LAYER" ]; then
    if [ -f "$FIRST_LAYER" ]; then files+=("$FIRST_LAYER"); else bad "first settings layer $FIRST_LAYER is gone (named in $INSTALL_RECORD)"; fi
  fi
  files+=("$LINK_ROOT/settings/base.json")
  case "$(uname -s)" in Darwin) os=macos ;; Linux) os=linux ;; *) os=windows ;; esac
  [ -f "$LINK_ROOT/settings/$os.json" ] && files+=("$LINK_ROOT/settings/$os.json")
  [ -f "$REPO/settings/local.json" ] && files+=("$REPO/settings/local.json")
  case "$os" in windows) home_path="$(cygpath -m "$CLAUDE_DIR" 2>/dev/null || echo "${CLAUDE_DIR//\\//}")" ;; esac
  expected="$(jq -S -s -f "$LINK_ROOT/scripts/merge-settings.jq" "${files[@]}" | sed "s|{{CLAUDE_HOME}}|$home_path|g")"
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

# These variables override the model and effort every agent file and workflow script names (sub-agents.md:384, model-config.md:655-746;
# probe W-model: both model routes override a script's `model: 'sonnet'`), so the model floor would be flattened and no agent runs at
# the effort its file names. Set in the shell or in the live settings env: FAIL. One check for all three variables.
EFFORT_OVERRIDES="CLAUDE_CODE_SUBAGENT_MODEL_FORCE CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL CLAUDE_CODE_EFFORT_LEVEL"
check_effort_env() {
  local live="$CLAUDE_DIR/settings.json" name found=""
  for name in $EFFORT_OVERRIDES; do
    if [ -n "${!name:-}" ]; then found="$found $name (shell)"; fi
    if [ -n "$(jq -r --arg n "$name" '.env[$n] // ""' "$live" 2>/dev/null)" ]; then found="$found $name (settings.json env)"; fi
  done
  if [ -n "$found" ]; then bad "set:$found: it overrides the model or effort every agent and workflow picks (the model floor); unset it"
  else ok "no model or effort override variable set ($EFFORT_OVERRIDES)"; fi
}

# Projects (scripts/doctor-projects.mjs): a plugin the setup turns off that a project's settings.local.json turns on (WARN; the
# committed settings.json is listed and kept), and a project skill with a personal skill's name (WARN: the personal one wins, the
# project copy never loads). The projects are the folders Claude Code's global config lists, plus this one. Also per project:
# settings that switch off or weaken our checks, guards and hooks (WARN), and INFO rows (a team switch ignored, a CLAUDE.local.md
# note import that is automatic now, a note no known project's key matches, listed folders that are gone).
check_projects() {
  local out line rc=0
  out="$(node "$REPO/scripts/doctor-projects.mjs" "$HOME/.claude.json" "$CLAUDE_DIR" "$REPO" "${DOCTOR_PROJECT:-$PWD}" 2>/dev/null)" || rc=$?
  while IFS= read -r line; do
    case "$line" in
      "WARN  "*) warn "${line#WARN  }" ;;
      "INFO  "*) echo "$line" ;;
      "ok    "*) ok "${line#ok    }" ;;
    esac
  done <<<"$out"
  [ "$rc" = 0 ] || bad "project checks could not run (scripts/doctor-projects.mjs exit $rc)"
}

# env-names reads YAML deploy files with the `yaml` package; without it those files are skipped (the report says so).
check_env_names() {
  if [ -d "$REPO/home/tools/env-names/node_modules/yaml" ]; then ok "env-names dep yaml"; else bad "env-names dep yaml (run scripts/install.sh)"; fi
}

# The session-notes hook feeds lead-rules.md to the lead; if it is not registered live, sessions silently run without those rules.
check_session_notes_hook() {
  local live="$CLAUDE_DIR/settings.json" event missing=""
  for event in SessionStart UserPromptSubmit; do
    jq -e --arg e "$event" '[.hooks[$e][]?.hooks[]?.command // empty | select(test("hooks/session-notes\\.mjs"))] | length > 0' "$live" >/dev/null 2>&1 || missing="$missing $event"
  done
  if [ -n "$missing" ]; then bad "session-notes hook not registered in settings.json for:$missing (SessionStart context will not reach sessions)"
  elif [ ! -f "$CLAUDE_DIR/hooks/session-notes.mjs" ]; then bad "session-notes hook file missing: $CLAUDE_DIR/hooks/session-notes.mjs"
  elif [ ! -s "$CLAUDE_DIR/lead-rules.md" ]; then bad "lead-rules.md missing or empty (lead rules are not injected)"
  else ok "session-notes hook registered for SessionStart, UserPromptSubmit"; fi
}

# Token budget (spec-p6 r9-token-view): the lead text's SessionStart string against its 10,000-char cap (over it Claude gets a
# file path instead of the text) and the always-loaded size; hooks/token-audit.mjs --budget prints `<ok|warn|fail><TAB><message>`.
check_token_budget() {
  local audit="$CLAUDE_DIR/hooks/token-audit.mjs" level message
  [ -f "$audit" ] || { warn "token budget not checked: $audit missing"; return; }
  while IFS=$'\t' read -r level message; do
    case "$level" in ok) ok "token budget: $message" ;; warn) warn "token budget: $message" ;; *) bad "token budget: $message" ;; esac
  done < <(node "$audit" --budget 2>/dev/null || printf 'fail\ttoken-audit.mjs --budget did not run\n')
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

# Workflows are gone (2026-11-22): the installer removes the old ~/.claude/workflows link, so a path still there is leftover.
# Whether Workflow is switched off and the agent cap is set is check_agent_cap's job.
check_workflows_gone() {
  local link="$CLAUDE_DIR/workflows"
  if [ -e "$link" ] || [ -L "$link" ]; then warn "$link still exists: workflows are gone; re-run scripts/install.sh (it removes its own link; a real folder there is yours to delete)"
  else ok "no $link: the retired workflows link is gone"; fi
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

# Agent cap (hooks/lib/agent-launches.mjs MAX_RUNNING_AGENTS): the hook caps the agents of a session; the live settings must also switch
# workflows off (setting, env and deny rule) and set the CLI's own cap, the backstop, to the same number.
check_agent_cap() {
  local live="$CLAUDE_DIR/settings.json" lib="$REPO/home/hooks/lib/agent-launches.mjs" cap expected problems=0
  if ! jq -e . "$live" >/dev/null 2>&1; then bad "settings.json missing or invalid JSON (agent cap not checked)"; return; fi
  expected="$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then((m) => console.log(m.MAX_RUNNING_AGENTS))' "$lib" 2>/dev/null)"
  if [ "$(jq -r '.disableWorkflows // false' "$live")" != true ]; then bad "settings.json: disableWorkflows is not true (settings/base.json, then scripts/install.sh)"; problems=1; fi
  if ! jq -e '(.permissions.deny // []) | index("Workflow") != null' "$live" >/dev/null; then bad "settings.json: permissions.deny lacks Workflow"; problems=1; fi
  if [ "$(jq -r '.env.CLAUDE_CODE_DISABLE_WORKFLOWS // ""' "$live")" != 1 ]; then bad "settings.json: env CLAUDE_CODE_DISABLE_WORKFLOWS is not 1"; problems=1; fi
  # The hook that counts agent launches: a PreToolUse command of agent-model-guard.mjs, and the SubagentStart marker of agent-budget.mjs.
  if ! jq -e '[.hooks.PreToolUse[]?.hooks[]?.command] | any(. != null and contains("hooks/agent-model-guard.mjs"))' "$live" >/dev/null 2>&1; then bad "settings.json: the agent cap hook (hooks/agent-model-guard.mjs) is not under hooks.PreToolUse (re-run scripts/install.sh)"; problems=1; fi
  if ! jq -e '[.hooks.SubagentStart[]?.hooks[]?.command] | any(. != null and contains("hooks/agent-budget.mjs"))' "$live" >/dev/null 2>&1; then bad "settings.json: the agent launch counter (hooks/agent-budget.mjs) is not under hooks.SubagentStart (re-run scripts/install.sh)"; problems=1; fi
  cap="$(jq -r '.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS // ""' "$live")"
  if [ -z "$cap" ]; then bad "settings.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: set it to ${expected:-5} in settings/base.json"; problems=1
  elif [ "$cap" != "$expected" ]; then bad "settings.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is $cap, the hook caps at ${expected:-?} (MAX_RUNNING_AGENTS in home/hooks/lib/agent-launches.mjs)"; problems=1; fi
  [ "$problems" = 0 ] && ok "agent cap: workflows off, deny Workflow, cap hook wired, env cap $cap = MAX_RUNNING_AGENTS"
  return 0
}

# Desktop notes (hooks/notify.mjs): the terminal and the channel a note goes out on. Desktop notes show only in Ghostty, Kitty and
# iTerm2 (and OSC 9 terminals such as WezTerm and Windows Terminal); Apple Terminal shows none, and tmux passes a note on only with
# allow-passthrough on. Apple Terminal is INFO when the owner accepted it (`apple-terminal-notes` in the doctor accepted list).
check_notify() {
  local line terminal channel passthrough
  line="$(node "$REPO/home/hooks/notify.mjs" --channel 2>/dev/null)" || { bad "notify: hooks/notify.mjs --channel failed"; return; }
  terminal="${line% *}"; channel="${line##* }"
  if [ "$channel" = notifications_disabled ]; then ok "notify: notes off (preferredNotifChannel notifications_disabled) in $terminal"
  elif [ "$terminal" = Apple_Terminal ]; then warn_unless_accepted apple-terminal-notes "notify: Apple Terminal shows no desktop note (at most a bell): use Ghostty, Kitty or iTerm2 for the needs-you notes"
  else ok "notify: $terminal, channel $channel"; fi
  if [ -n "${TMUX:-}" ]; then
    passthrough="$(tmux show -gv allow-passthrough 2>/dev/null || true)"
    [ "$passthrough" = on ] || warn "notify: tmux without allow-passthrough drops the desktop notes (tmux set -g allow-passthrough on)"
  fi
}

# done-check: its ledger says whether a check raises too many false alarms (tools/done-check, `stats --doctor` prints one `WARN done-check:` line per
# noisy kind and one when the ledger is full). An empty ledger or a quiet one is an ok line; a machine without the tool yet (not synced) is INFO.
check_done_check() {
  local tool="$REPO/home/tools/done-check/done-check.mjs" out line warned=0
  if [ ! -f "$tool" ]; then echo "INFO  done-check: tool not installed here (sync this machine)"; return; fi
  if ! out="$(node "$tool" stats --doctor 2>&1)"; then warn "done-check: stats could not run: $(tr -d '\000-\037\177' <<<"$out" | head -c 200)"; return; fi
  while IFS= read -r line; do
    case "$line" in "WARN done-check:"*) warn "${line#WARN }"; warned=1 ;; esac
  done < <(tr -d '\000-\010\013-\037\177' <<<"$out")
  [ "$warned" = 1 ] || ok "done-check: no check over its false-alarm limit"
}
