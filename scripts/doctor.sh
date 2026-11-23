#!/usr/bin/env bash
# Purpose: read-only report on links, settings drift, plugins and tools for this Claude Code setup.
# Usage: scripts/doctor.sh [--all] [--live]   (exit 1 if any problem found; --live then runs scripts/doctor-live.sh on the
#   real tool: a permission dialog and a guard case; it never runs the repo's tests; an old --quick or --full is ignored)
# Output: a summary line first (`doctor (MacBook, Claude Code 2.1.328): 1 FAIL, 1 WARN, 38 ok`), then only the lines that are not
# ok, each with its fix; `--all` (or DOCTOR_ALL=1) prints every line as before. DOCTOR_ONLY runs keep every line (tests read them).
# The checks are functions: the ones about the setup's own files are in scripts/doctor/checks-setup.sh, the ones about this machine in
# scripts/doctor/checks-machine.sh (sourced below); the helpers, the links, the Claude Code floor, the re-read version (VERIFIED_ON_CLI)
# and the run order stay here.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
BAD=0
# The install record (scripts/install/record.mjs) names the checkout the links point at (a tag worktree after
# `install --update --to <tag>`) and the machine's own settings kept as the first layer; without a record: this repo, no layer.
INSTALL_RECORD="$CLAUDE_DIR/.claude-setup-install.json"
LINK_ROOT="$(jq -r '.root // empty' "$INSTALL_RECORD" 2>/dev/null || true)"
LINK_ROOT="${LINK_ROOT:-$REPO}"
# The clone that holds personal/ (never a tag worktree): the record's repo, else this one.
INSTALL_REPO="$(jq -r '.repo // empty' "$INSTALL_RECORD" 2>/dev/null || true)"
INSTALL_REPO="${INSTALL_REPO:-$REPO}"
FIRST_LAYER="$(jq -r '.firstLayer // empty' "$INSTALL_RECORD" 2>/dev/null || true)"
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; BAD=1; }
warn() { echo "WARN  $1"; }

# The accepted list (owner, FR8 2026-11-22): machine facts the owner has seen and accepted, one id per line, `#` starts a comment.
# It is read from CLAUDE_DOCTOR_ACCEPTED_FILE, else ~/.claude/private/doctor-accepted, the way the prod-hosts list is; doctor never
# writes it (settings/doctor-accepted.example). An accepted fact prints as INFO, which the summary does not count. Only the ids in
# ACCEPTED_IDS can be accepted: the production host list WARN never can (owner, FR8). A list that is a link or not a plain file
# accepts nothing; check_doctor_accepted reports it, and an unknown id, as one WARN.
ACCEPTED_IDS="ollama-off apple-terminal-notes"
accepted_file() { echo "${CLAUDE_DOCTOR_ACCEPTED_FILE:-$CLAUDE_DIR/private/doctor-accepted}"; }
# The ids listed in the accepted file, one per line (Windows line ends dropped); nothing when it is missing, a link or not plain.
accepted_ids() {
  local file
  file="$(accepted_file)"
  if [ -L "$file" ] || [ ! -f "$file" ]; then return 0; fi
  sed 's/#.*//' "$file" 2>/dev/null | tr -s ' \t\r' '\n\n\n' | sed '/^$/d'
}
# True when id $1 is one doctor can accept and the accepted file lists it.
is_accepted() {
  case " $ACCEPTED_IDS " in *" $1 "*) ;; *) return 1 ;; esac
  accepted_ids | grep -qxF -- "$1"
}
# A WARN, or an INFO naming the id and the file when the owner accepted it.
warn_unless_accepted() {
  if is_accepted "$1"; then echo "INFO  $2 (accepted: $1 in $(accepted_file))"; else warn "$2"; fi
}

is_windows() { case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }

# The check groups sit beside this script (scripts/doctor/) and are found from this script's folder, never the working folder. They only
# define functions; run_checks calls them. A missing file is reported by the full run, so DOCTOR_ONLY runs of the checks kept in this
# file still work without them.
MISSING_GROUPS=""
for group in setup machine; do
  if [ -f "$REPO/scripts/doctor/checks-$group.sh" ]; then source "$REPO/scripts/doctor/checks-$group.sh"; else MISSING_GROUPS="$MISSING_GROUPS checks-$group.sh"; fi
done

# A path as an @ import line in ~/.claude/CLAUDE.md writes it: forward slashes, and on Git Bash the drive letter (C:/...).
import_path() {
  if is_windows && command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1" | tr '\\' '/'; fi
}

# ~/.claude/CLAUDE.md as the installer writes it (scripts/install/personal.mjs claudeMdText): the marker line, the core import,
# and the personal import while <repo>/personal/CLAUDE.md exists.
expected_claude_md() {
  local core own
  core="$(import_path "$LINK_ROOT")/home/CLAUDE.md"
  own="$(import_path "$INSTALL_REPO")/personal/CLAUDE.md"
  printf '%s\n' "<!-- claude-setup: written by scripts/install.sh; edit $core (shared) or $own (yours) -->" "@$core"
  if [ -f "$INSTALL_REPO/personal/CLAUDE.md" ]; then printf '%s\n' "@$own"; fi
}

check_claude_md() {
  local file="$CLAUDE_DIR/CLAUDE.md"
  if [ -L "$file" ] || [ ! -f "$file" ]; then bad "CLAUDE.md is not the installer's file (re-run scripts/install.sh)"
  elif [ "$(cat "$file")" = "$(expected_claude_md)" ]; then ok "CLAUDE.md imports home/CLAUDE.md$([ -f "$INSTALL_REPO/personal/CLAUDE.md" ] && echo ' and personal/CLAUDE.md')"
  else bad "CLAUDE.md differs from what the install writes, or misses the personal/CLAUDE.md import (re-run scripts/install.sh)"; fi
}

# personal/ must be its own git repo, so `git clean -fdx` in the clone skips it.
check_personal() {
  local dir="$INSTALL_REPO/personal"
  if [ ! -d "$dir" ]; then bad "personal/ is missing at $dir (re-run scripts/install.sh)"
  elif [ -e "$dir/.git" ]; then ok "personal/ is its own git repo"
  else warn "personal/ is not a git repo: git clean -fdx in the clone would delete it (re-run scripts/install.sh)"; fi
}

# On Git Bash install.sh may have copied instead of linking (no symlink permission): a present copy is a warning, not a FAIL.
# CLAUDE.md is a written file, not a link; project-notes links to personal/project-notes (scripts/install/personal.mjs).
check_links() {
  local name target want
  for name in CLAUDE.md lead.md rules skills agents standards hooks tools project-notes lead-rules.md statusline.mjs; do
    target="$CLAUDE_DIR/$name"
    case "$name" in
      CLAUDE.md) check_claude_md; continue ;;
      project-notes) want="$INSTALL_REPO/personal/project-notes" ;;
      *) want="$LINK_ROOT/home/$name" ;;
    esac
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$want" ]; then ok "link $name"
    elif is_windows && [ -e "$target" ] && [ ! -L "$target" ]; then ok "copy $name (not live-linked; re-run install.sh after repo changes)"
    else bad "link $name (re-run scripts/install.sh)"; fi
  done
  check_personal
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
# `onFailure: "block"` (2.1.295: an older CLI ignores it, so a guard that dies or times out lets the command run) and replaces the
# PC's 2.1.323 and Windows' 2.1.316, which are below it and fail here. npm's stable channel gives 2.1.323, below the floor, so the
# FAIL text says not to use it. The line also names the update channel and whether DISABLE_UPDATES pins the version.
CLAUDE_FLOOR=2.1.326
CLAUDE_STABLE_CHANNEL_VERSION=2.1.323 # what `stable` gives (npm dist-tag, 2026-11-22); named in the FAIL text only
check_claude_version() {
  local version live="$CLAUDE_DIR/settings.json" channel pinned
  version="$(claude --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  channel="$(jq -r '.autoUpdatesChannel // "latest (default)"' "$live" 2>/dev/null || echo "unknown")"
  pinned="$(jq -r '.env.DISABLE_UPDATES // ""' "$live" 2>/dev/null || true)"
  pinned="${DISABLE_UPDATES:-$pinned}"
  pinned="update channel ${channel:-unknown}, DISABLE_UPDATES ${pinned:-not set}"
  if [ -z "$version" ]; then warn "claude --version gave no version: cannot check the floor $CLAUDE_FLOOR or the re-read version $VERIFIED_ON_CLI ($pinned)"
  elif version_at_least "$version" "$CLAUDE_FLOOR"; then ok "claude $version (floor $CLAUDE_FLOOR; $pinned)"
  else bad "claude >= $CLAUDE_FLOOR required (found $version; $pinned): below it the Bash guard's onFailure: block may be ignored and the phase pin does not hold; run claude update, and do not use the stable channel ($CLAUDE_STABLE_CHANNEL_VERSION)"; fi
  if [ -n "$version" ]; then check_cli_verified "$version"; fi
  if is_windows; then check_windows_shell; fi
}

# VERIFIED_ON_CLI: the Claude Code version that the files copying its behaviour were last read again against, in its bundle.
# These files repeat what the CLI does (which agent file it loads, its frontmatter parser, transcript fields, hook output); a
# new CLI can change that quietly, so on any other version this check names them: read each again against the bundle of the
# version in use, fix what changed, then set VERIFIED_ON_CLI to that version. The list is the same search the re-read uses
# (CLI_COPY_PATTERN over home/hooks and home/tools), so the two never disagree. A WARN, never a FAIL: a version not read again is
# work to do, and a rollback to the version before must keep doctor at 0 FAIL. Read again on 2.1.330: 27 files, 2 changed.
VERIFIED_ON_CLI=2.1.330
CLI_COPY_PATTERN='bundle|minified|binary|CLI.s own|undocumented'
check_cli_verified() {
  local version="$1" files count=0 file
  if [ "$version" = "$VERIFIED_ON_CLI" ]; then
    ok "claude $version is the version the files that copy Claude Code behaviour were read again on (VERIFIED_ON_CLI)"; return
  fi
  files="$(cd "$REPO" && grep -rilE --exclude-dir=node_modules "$CLI_COPY_PATTERN" home/hooks home/tools 2>/dev/null | sort)"
  while IFS= read -r file; do [ -n "$file" ] && count=$((count + 1)); done <<<"$files"
  warn "claude $version is not $VERIFIED_ON_CLI, the version these $count files that copy Claude Code behaviour were read again on: read each against the $version bundle, fix what changed, then set VERIFIED_ON_CLI=$version in scripts/doctor.sh"
  while IFS= read -r file; do [ -n "$file" ] && echo "      $file"; done <<<"$files"
  return 0
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
  check_links; check_settings; check_plugins; check_plugin_parity; check_node; check_claude_version; check_effort_env; check_hook_files; check_prod_hosts; check_doctor_accepted; check_session_notes_hook; check_token_budget; check_plugin_session_start; check_recall; check_stop_cap; check_agent_cap; check_disk_free; check_disk_clean; check_native_cleanup; check_tools; check_accounts; check_notify; check_done_check; check_lsp; check_ui_check; check_project_agents; check_projects; check_workflows_gone; check_env_names
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
