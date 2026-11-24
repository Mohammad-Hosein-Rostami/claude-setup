#!/usr/bin/env bash
# The setup's own checks: its settings, plugins, hooks, git hook path, accounts, caps and desktop notes (sourced by scripts/doctor.sh, which
# holds the helpers ok, bad, warn and warn_unless_accepted, the variables REPO, CLAUDE_DIR, LINK_ROOT and BAD, and the run order in run_checks).
# Defines functions only; nothing runs when this file is sourced, so no output comes from it. Exports: check_settings, check_deny_rules, check_plugins, check_plugin_parity, check_effort_env, check_projects, check_env_names, check_plugin_session_start, check_workflows_gone, check_project_agents, check_accounts, check_agent_cap, check_notify, check_share_deny, check_git_hooks_path.
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

# Agent cap: the hooks cap the main agents of a session; the live settings must also switch workflows off (setting, env and deny
# rule). CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is Claude Code's own cap of every running subagent, helpers included (default 20, it
# cannot be switched off; docs env-vars and the 2.1.330 binary): it must stay at the high value settings/base.json sets, so helpers
# are never capped.
check_agent_cap() {
  local live="$CLAUDE_DIR/settings.json" cap expected problems=0
  if ! jq -e . "$live" >/dev/null 2>&1; then bad "settings.json missing or invalid JSON (agent cap not checked)"; return; fi
  expected="$(jq -r '.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS // ""' "$REPO/settings/base.json" 2>/dev/null)"
  if [ "$(jq -r '.disableWorkflows // false' "$live")" != true ]; then bad "settings.json: disableWorkflows is not true (settings/base.json, then scripts/install.sh)"; problems=1; fi
  if ! jq -e '(.permissions.deny // []) | index("Workflow") != null' "$live" >/dev/null; then bad "settings.json: permissions.deny lacks Workflow"; problems=1; fi
  if [ "$(jq -r '.env.CLAUDE_CODE_DISABLE_WORKFLOWS // ""' "$live")" != 1 ]; then bad "settings.json: env CLAUDE_CODE_DISABLE_WORKFLOWS is not 1"; problems=1; fi
  # The hook that counts agent launches: a PreToolUse command of agent-model-guard.mjs, and the SubagentStart marker of agent-budget.mjs.
  if ! jq -e '[.hooks.PreToolUse[]?.hooks[]?.command] | any(. != null and contains("hooks/agent-model-guard.mjs"))' "$live" >/dev/null 2>&1; then bad "settings.json: the agent cap hook (hooks/agent-model-guard.mjs) is not under hooks.PreToolUse (re-run scripts/install.sh)"; problems=1; fi
  if ! jq -e '[.hooks.SubagentStart[]?.hooks[]?.command] | any(. != null and contains("hooks/agent-budget.mjs"))' "$live" >/dev/null 2>&1; then bad "settings.json: the agent launch counter (hooks/agent-budget.mjs) is not under hooks.SubagentStart (re-run scripts/install.sh)"; problems=1; fi
  cap="$(jq -r '.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS // ""' "$live")"
  if [ -z "$cap" ]; then bad "settings.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset: Claude Code's default of 20 then caps helpers too (settings/base.json sets ${expected:-?}; re-run scripts/install.sh)"; problems=1
  elif [ "$cap" != "$expected" ]; then bad "settings.json: env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is $cap, settings/base.json sets ${expected:-?} (Claude Code's cap of all subagents: keep it high so helpers are not capped)"; problems=1; fi
  [ "$problems" = 0 ] && ok "agent cap: workflows off, deny Workflow, cap hook wired, CLI subagent cap $cap (helpers not capped)"
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

# share-check (scripts/share-check.mjs) refuses only the words of the person's own personal/share-deny.txt: a missing list or one
# with comments only protects nothing, so it is one WARN. A missing list beside an existing personal/ (a folder or any link, as
# share-check tells it) is a FAIL with the fix, because the commit hooks refuse every commit then. The list is read as share-check
# reads it (readPlainFile, at most DENY_MAX_BYTES, no link followed), so a link, a dangling link or an oversized list is the same
# FAIL as an unreadable one; the words are counted with share-check's own parser (parseDenyList).
check_share_deny() {
  local list="$INSTALL_REPO/personal/share-deny.txt" count
  count="$(node --input-type=module -e '
    import { lstatSync } from "node:fs";
    import { dirname } from "node:path";
    import { pathToFileURL } from "node:url";
    const { DENY_MAX_BYTES, parseDenyList } = await import(pathToFileURL(process.argv[1]).href);
    const { readPlainFile } = await import(pathToFileURL(process.argv[3]).href);
    const list = process.argv[2];
    let text = "";
    try { text = readPlainFile(list, DENY_MAX_BYTES); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const missingBesidePersonal = text === "" && lstatSync(list, { throwIfNoEntry: false }) === undefined
      && lstatSync(dirname(list), { throwIfNoEntry: false }) !== undefined;
    console.log(missingBesidePersonal ? "missing" : parseDenyList(text).length);' \
    "$REPO/scripts/share-check/match.mjs" "$list" "$REPO/home/hooks/lib/plain-file.mjs" 2>/dev/null)" \
    || { bad "share-check deny list $list is not readable"; return; }
  if [ "$count" = missing ]; then bad "share-check deny list $list is missing beside $INSTALL_REPO/personal, so every commit there fails; run: cp '$INSTALL_REPO/personal.example/share-deny.txt' '$list'"
  elif [ "$count" -gt 0 ]; then ok "share-check deny list: $count words"
  else warn "add your private names to personal/share-deny.txt so share-check can protect them"; fi
}

# The setup repo's commit hook (.githooks/pre-commit: the gitleaks secret scan and the hook syntax check) runs only while git's
# core.hooksPath is .githooks. Only scripts/install.sh sets it, so a fresh clone commits unscanned until the first install (audit H7).
# The value git uses is read, so a global hooksPath that hides .githooks fails too.
GIT_HOOKS_PATH=.githooks
check_git_hooks_path() {
  local value
  value="$(git -C "$REPO" config --get core.hooksPath 2>/dev/null || true)"
  if [ "$value" = "$GIT_HOOKS_PATH" ]; then ok "git hooksPath = $GIT_HOOKS_PATH in $REPO (commits run the secret scan)"
  else bad "git hooksPath is ${value:-not set} in $REPO: commits there run no secret scan; run in $REPO: git config core.hooksPath $GIT_HOOKS_PATH (or re-run scripts/install.sh)"; fi
}
