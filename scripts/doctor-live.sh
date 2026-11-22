#!/usr/bin/env bash
# Purpose: `doctor.sh --live`: check the setup on the real Claude Code, not on fixtures: one real permission dialog that the
#   PermissionRequest hook sees and one guard case.
# Usage: scripts/doctor-live.sh   (doctor.sh --live runs it after the plain checks)
#   Needs a headless login (the setup-token exported, `claude-as <name>`). Setup and hook lanes run it before landing counts as done.
# Exit codes: 0 every step passed, 1 a step failed (its FAIL line says which), 2 not runnable here (no claude, no login).
# Invariants: everything runs in a fresh scratch folder (mktemp -d) under a scratch CLAUDE_CONFIG_DIR that holds a copy of the
#   live settings plus the probe hooks; no real project and no other session are ever touched; every `claude -p` names a non-Fable --model (usage credits are not
#   confirmed off) and has its own timeout. The scratch folder is kept on a failure and its path printed.
# Unconfirmed: probe P4-1 (can a scripted -p run raise a real dialog the hook sees?) has not run. This script is the scripted form;
#   if P4-1 says no, step 1 must drive an interactive session through a terminal driver instead, and its FAIL here says so.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${DOCTOR_LIVE_MODEL:-sonnet}"         # never a Fable model while usage credits are not confirmed off
STEP_TIMEOUT_S="${DOCTOR_LIVE_TIMEOUT_S:-300}" # one scripted run
BAD=0
ok() { echo "ok    live: $1"; }
bad() { echo "FAIL  live: $1"; BAD=1; }

command -v claude >/dev/null || { echo "FAIL  live: claude is not on PATH"; exit 2; }
command -v jq >/dev/null || { echo "FAIL  live: jq is not on PATH"; exit 2; }
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/doctor-live.XXXXXX")" || exit 2
CONFIG="$SCRATCH/config"
mkdir -p "$CONFIG" "$SCRATCH/work" "$SCRATCH/logs"
cp "$HOME/.claude/settings.json" "$CONFIG/settings.json" 2>/dev/null || echo '{}' > "$CONFIG/settings.json"

# One scripted run in the scratch folder; stdout to <name>.out. The timeout is `perl -e alarm` (macOS has no `timeout`).
scripted() {
  local name="$1" folder="$2" prompt="$3"
  (cd "$folder" && CLAUDE_CONFIG_DIR="$CONFIG" perl -e 'alarm shift; exec @ARGV' "$STEP_TIMEOUT_S" \
    claude -p --model "$MODEL" --output-format json "$prompt") > "$SCRATCH/logs/$name.out" 2> "$SCRATCH/logs/$name.err"
}

# The probe hook: logs every PermissionRequest input to a file, decides nothing (the dialog stays the CLI's own).
add_probe_hook() {
  local hook="$SCRATCH/permission-log.sh" settings="$CONFIG/settings.json"
  printf '#!/usr/bin/env bash\ncat >> %q\necho >> %q\n' "$SCRATCH/logs/permission-requests.jsonl" "$SCRATCH/logs/permission-requests.jsonl" > "$hook"
  chmod +x "$hook"
  jq --arg cmd "$hook" '.hooks.PermissionRequest = ((.hooks.PermissionRequest // []) + [{matcher: "Bash", hooks: [{type: "command", command: $cmd}]}])
    | .permissions.ask = ((.permissions.ask // []) + ["Bash(touch doctor-live-dialog)"])' "$settings" > "$settings.new" && mv "$settings.new" "$settings"
}

step_login() {
  scripted login "$SCRATCH/work" "Reply with the single word ok." && jq -e '.is_error == false' "$SCRATCH/logs/login.out" >/dev/null \
    && { ok "headless login works ($MODEL)"; return 0; }
  echo "FAIL  live: no headless login (export the setup-token, claude-as <name>); see $SCRATCH/logs/login.err"; exit 2
}

# Step 1 (P4-1): an ask rule on one harmless command must raise a dialog the PermissionRequest hook sees.
step_dialog() {
  add_probe_hook
  scripted dialog "$SCRATCH/work" "Run exactly this Bash command once: touch doctor-live-dialog"
  if grep -q '"PermissionRequest"' "$SCRATCH/logs/permission-requests.jsonl" 2>/dev/null; then ok "a scripted run raised a permission dialog the PermissionRequest hook saw"
  else bad "no PermissionRequest reached the hook in a scripted run (P4-1 no: drive an interactive session through a terminal driver); logs in $SCRATCH/logs"; fi
}

# Step 2: the guard bounces a `$VAR` command word once with its fix (home/CLAUDE.md, C30). The two measures ride along: does the
# model resend the same command after the bounce, and does a guarded call still ask in bypass mode (recorded, not gates).
step_guard() {
  scripted guard "$SCRATCH/work" 'Run exactly this Bash command once and report what the tool answered: CMD=echo; $CMD doctor-live-guard'
  if jq -r '.result // ""' "$SCRATCH/logs/guard.out" 2>/dev/null | grep -qiE 'command word|\$VAR|rewrite|bounce|denied|blocked'; then ok "the guard answered the \$VAR command word"
  else bad "the guard case got no guard answer; see $SCRATCH/logs/guard.out"; fi
  echo "info  live: measures (not gates): resend after a deny and bypass-mode ask are read from $SCRATCH/logs/guard.out by hand and go into results.md"
}

step_login
step_dialog
step_guard
if [ "$BAD" = 0 ]; then rm -rf -- "$SCRATCH"; else echo "info  live: scratch kept at $SCRATCH"; fi
exit "$BAD"
