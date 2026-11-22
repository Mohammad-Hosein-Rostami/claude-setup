#!/usr/bin/env bash
# Purpose: read-only report on links, settings drift, plugins and tools for this Claude Code setup.
# Usage: scripts/doctor.sh [--all] [--live]   (exit 1 if any problem found; --live then runs scripts/doctor-live.sh on the
#   real tool: a permission dialog and a guard case; it never runs the repo's tests; an old --quick or --full is ignored)
# Output: a summary line first (`doctor (MacBook, Claude Code 2.1.328): 1 FAIL, 1 WARN, 38 ok`), then only the lines that are not
# ok, each with its fix; `--all` (or DOCTOR_ALL=1) prints every line as before. DOCTOR_ONLY runs keep every line (tests read them).
# The checks are functions: the ones about the setup's own files are in scripts/doctor/checks-setup.sh, the ones about this machine in
# scripts/doctor/checks-machine.sh (sourced below); the helpers, the links, the Claude Code floor and the run order stay here.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
BAD=0
# The install record (scripts/install/record.mjs) names the checkout the links point at (a tag worktree after
# `install --update --to <tag>`) and the machine's own settings kept as the first layer; without a record: this repo, no layer.
INSTALL_RECORD="$CLAUDE_DIR/.claude-setup-install.json"
LINK_ROOT="$(jq -r '.root // empty' "$INSTALL_RECORD" 2>/dev/null || true)"
LINK_ROOT="${LINK_ROOT:-$REPO}"
FIRST_LAYER="$(jq -r '.firstLayer // empty' "$INSTALL_RECORD" 2>/dev/null || true)"
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; BAD=1; }
warn() { echo "WARN  $1"; }

is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

# The check groups sit beside this script (scripts/doctor/) and are found from this script's folder, never the working folder. They only
# define functions; run_checks calls them. A missing file is reported by the full run, so DOCTOR_ONLY runs of the checks kept in this
# file still work without them.
MISSING_GROUPS=""
for group in setup machine; do
  if [ -f "$REPO/scripts/doctor/checks-$group.sh" ]; then source "$REPO/scripts/doctor/checks-$group.sh"; else MISSING_GROUPS="$MISSING_GROUPS checks-$group.sh"; fi
done

# On Git Bash install.sh may have copied instead of linking (no symlink permission): a present copy is a warning, not a FAIL.
check_links() {
  local name target
  for name in CLAUDE.md lead.md rules skills agents standards hooks tools project-notes lead-rules.md statusline.mjs; do
    target="$CLAUDE_DIR/$name"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$LINK_ROOT/home/$name" ]; then ok "link $name"
    elif is_windows && [ -e "$target" ] && [ ! -L "$target" ]; then ok "copy $name (not live-linked; re-run install.sh after repo changes)"
    else bad "link $name (re-run scripts/install.sh)"; fi
  done
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
  if is_windows; then check_windows_shell; fi
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

# Hook files named in the frontmatter of home/agents/*.md must exist too.
check_agent_hook_files() {
  local file missing=0
  while read -r file; do
    [ -f "$REPO/home/hooks/$file" ] || { bad "agent frontmatter hook file missing: home/hooks/$file"; missing=1; }
  done < <(grep -h 'command:.*hooks/[A-Za-z0-9._-]*\.mjs' "$REPO"/home/agents/*.md 2>/dev/null | grep -o 'hooks/[A-Za-z0-9._-]*\.mjs' | sed 's#hooks/##' | sort -u)
  [ "$missing" = 0 ] && ok "hook files referenced by agent frontmatter exist"
  return 0
}

# DOCTOR_ONLY="check_a check_b" runs just those checks (used by tests).
run_checks() {
  local check
  if [ -n "${DOCTOR_ONLY:-}" ]; then for check in $DOCTOR_ONLY; do "$check"; done; return; fi
  if [ -n "$MISSING_GROUPS" ]; then bad "check files missing from scripts/doctor/:$MISSING_GROUPS (restore them: git checkout -- scripts/doctor)"; return; fi
  check_links; check_settings; check_plugins; check_plugin_parity; check_node; check_claude_version; check_effort_env; check_hook_files; check_prod_hosts; check_session_notes_hook; check_token_budget; check_plugin_session_start; check_recall; check_stop_cap; check_agent_cap; check_disk_free; check_disk_clean; check_native_cleanup; check_tools; check_accounts; check_notify; check_done_check; check_lsp; check_ui_check; check_project_agents; check_projects; check_workflows_gone; check_env_names
}
# The machine's name in the summary: the owner's two machines by OS, else the host name; DOCTOR_MACHINE overrides it.
machine_name() {
  if [ -n "${DOCTOR_MACHINE:-}" ]; then echo "$DOCTOR_MACHINE"; return; fi
  case "$(uname -s)" in Darwin) echo MacBook ;; MINGW*|MSYS*|CYGWIN*) echo PC ;; *) uname -n ;; esac
}

# The full run: every check's lines go to a file (in this shell, so BAD still counts), then the summary and the lines not ok.
# The counts are of the ok / WARN / FAIL lines; INFO and detail lines (detail lines of a check) are shown, never counted.
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

want_all=0; want_live=0
for arg in "$@"; do
  case "$arg" in --all) want_all=1 ;; --live) want_live=1 ;; esac
done
if [ -n "${DOCTOR_ONLY:-}" ] || [ "${DOCTOR_ALL:-}" = 1 ] || [ "$want_all" = 1 ]; then run_checks; else print_summary; fi
if [ "$want_live" = 1 ]; then
  "$REPO/scripts/doctor-live.sh" || BAD=1
fi
exit "$BAD"
