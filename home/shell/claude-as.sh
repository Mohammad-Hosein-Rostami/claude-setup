# Purpose: `claude-as <name>` makes this terminal, and only this one, use the Claude account stored under that name.
# Source this file from a shell start-up file (zsh, or bash 3.2 and newer); nothing else is written there.
#   claude-as <name>   use that account here; for a name not stored yet: ask for its token (hidden), check, store, use
#   claude-as          pick from a numbered list
#   claude-as --once   use a pasted token here without storing it (CLAUDE_ACCOUNT is then "-")
#   claude-as --off    this terminal has no account
#   claude-account ... list | remove <name> | check [name] | default [<name>|none] | plan <name> <plan> | credits-off <name>
# Defines: claude-as, claude-account, and helpers named _claude_as_*.
# How: only the shell can change its own environment, so this is a function. It exports CLAUDE_CODE_OAUTH_TOKEN and the
# non-secret name CLAUDE_ACCOUNT in this shell; closing the terminal drops both. The token comes from the account tool
# (../tools/account/account.mjs, found from this file's own path) on a pipe.
# Invariants (tests/account-shell.test.mjs): the token is handled with shell builtins only, so it is never an argument of
# a program; `set -x` of the caller is switched off inside claude-as and back on after it, so no trace line holds the
# token; the paste is read from the terminal with echo off, and never without a terminal on stdin (the Bash tool of
# Claude, `!`, a pipe: the paste would enter a transcript); an argument shaped like a token is refused; Ctrl-C at the
# prompt or during the check ends the call with echo on, nothing stored and no variable holding the paste
# (tests/account-shell-interrupt.test.mjs).

if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_claude_as_file=${(%):-%x}' # zsh: the file being sourced (eval: bash must not parse this form)
else
  _claude_as_file=${BASH_SOURCE[0]}
fi
case $_claude_as_file in
  */*) _claude_as_dir=${_claude_as_file%/*} ;;
  *) _claude_as_dir=. ;;
esac
_CLAUDE_AS_TOOLS=$(CDPATH='' cd "$_claude_as_dir/../tools" 2>/dev/null && pwd)
unset _claude_as_file _claude_as_dir

claude-account() {
  node "$_CLAUDE_AS_TOOLS/account/account.mjs" "$@"
}

# True when an argument holds something shaped like a token (sk-ant- and 10 more characters of its alphabet).
_claude_as_has_token_shape() {
  local arg
  for arg in "$@"; do
    case $arg in
      *sk-ant-[A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-][A-Za-z0-9_-]*) return 0 ;;
    esac
  done
  return 1
}

_claude_as_needs_terminal() {
  [ -t 0 ] && return 0
  builtin printf '%s\n' "claude-as: no terminal on stdin. Run it yourself in a normal terminal (not through Claude, not with !, not in a pipe)." >&2
  return 1
}

# Reads one line from the terminal into _claude_as_paste, a local of the caller (so no Ctrl-C can leave it set in the
# shell). `read -s` of bash and zsh hides the input and puts the terminal back itself, also on Ctrl-C, which ends the
# read and the call (a trap with stty did not: the read went on, with echo on, review 1 R1). The prompt is printed by
# `read` itself, after it has switched echo off, so a paste that comes the moment the prompt shows is not echoed.
_claude_as_read_hidden() {
  _claude_as_paste=
  _claude_as_needs_terminal || return 1
  local rc
  if [ -n "${ZSH_VERSION:-}" ]; then
    IFS= read -r -s "_claude_as_paste?$1" < /dev/tty 2> /dev/tty
  else
    IFS= read -r -s -p "$1" _claude_as_paste < /dev/tty 2> /dev/tty
  fi
  rc=$?
  builtin printf '\n' > /dev/tty
  return "$rc"
}

# Uses the stored account $1 in this shell; a name that is not stored yet is asked for, checked and stored first.
_claude_as_use() {
  local _claude_as_token _claude_as_paste rc
  _claude_as_token=$(claude-account token "$1")
  rc=$?
  if [ "$rc" -eq 3 ]; then
    _claude_as_read_hidden "Paste the token for $1 (input is hidden): " || return 1
    builtin printf '%s\n' "$_claude_as_paste" | claude-account add "$1"
    rc=$?
    _claude_as_paste=
    [ "$rc" -eq 0 ] || return 1
    _claude_as_token=$(claude-account token "$1") || return 1
  elif [ "$rc" -ne 0 ]; then
    return 1
  fi
  export CLAUDE_CODE_OAUTH_TOKEN="$_claude_as_token" CLAUDE_ACCOUNT="$1"
  builtin printf '%s\n' "this terminal now uses account $1"
}

# Uses a pasted token in this shell without storing it. CLAUDE_ACCOUNT=- tells hook jobs to spend no stored account.
_claude_as_once() {
  local _claude_as_token _claude_as_paste rc
  _claude_as_read_hidden "Paste the token for this terminal only (input is hidden, nothing is stored): " || return 1
  _claude_as_token=$(builtin printf '%s\n' "$_claude_as_paste" | claude-account once)
  rc=$?
  _claude_as_paste=
  if [ -n "$_claude_as_token" ] && [ "$rc" -eq 0 ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$_claude_as_token" CLAUDE_ACCOUNT=-
    builtin printf '%s\n' "this terminal now uses a token that is not stored"
    return 0
  fi
  return 1
}

# Shows the stored names as a numbered list and puts the picked one into _claude_as_choice. Enter alone picks nothing.
_claude_as_pick() {
  _claude_as_choice=
  local names line answer count=0
  names=$(claude-account names) || return 1
  if [ -z "$names" ]; then
    builtin printf '%s\n' "no accounts stored. Add one: claude-as <name>" >&2
    return 1
  fi
  _claude_as_needs_terminal || return 1
  while IFS= read -r line; do
    count=$((count + 1))
    builtin printf '%s\n' "$count) $line"
  done <<EOF
$names
EOF
  builtin printf '%s' "Number: "
  IFS= read -r answer
  count=0
  while IFS= read -r line; do
    count=$((count + 1))
    if [ "$answer" = "$count" ]; then _claude_as_choice=$line; fi
  done <<EOF
$names
EOF
  [ -n "$_claude_as_choice" ] && return 0
  builtin printf '%s\n' "claude-as: no account picked" >&2
  return 1
}

_claude_as_main() {
  local usage="usage: claude-as <name> | --once | --off   (no name: pick from a list; accounts: claude-account list)"
  if _claude_as_has_token_shape "$@"; then
    builtin printf '%s\n' "claude-as: an argument looks like a token; nothing was set. That line is now in this shell's history: remove it (bash: history -d <number>, then history -w; zsh: fc -W, delete the line from \$HISTFILE, then fc -R) and treat that token as shown. Then run claude-as <name> and paste at the hidden prompt." >&2
    return 1
  fi
  if [ -z "${_CLAUDE_AS_TOOLS:-}" ]; then
    builtin printf '%s\n' "claude-as: the tools folder was not found beside this snippet (expected ../tools)" >&2
    return 1
  fi
  if [ "$#" -gt 1 ]; then
    builtin printf '%s\n' "$usage" >&2
    return 1
  fi
  case ${1:-} in
    --off)
      unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_ACCOUNT
      builtin printf '%s\n' "this terminal has no account"
      ;;
    --once) _claude_as_once ;;
    '') _claude_as_pick && _claude_as_use "$_claude_as_choice" ;;
    -*)
      builtin printf '%s\n' "$usage" >&2
      return 1
      ;;
    *) _claude_as_use "$1" ;;
  esac
}

claude-as() {
  local _claude_as_trace=0 _claude_as_rc
  # A trace of the lines below would print the token: switch the caller's set -x off for the call, then back on.
  case $- in
    *x*) _claude_as_trace=1; set +x ;;
  esac
  _claude_as_main "$@"
  _claude_as_rc=$?
  unset _claude_as_paste _claude_as_choice
  if [ "$_claude_as_trace" = 1 ]; then set -x; fi
  return "$_claude_as_rc"
}

# At the start of an interactive shell that has no token yet: use the default account when the owner set one
# (claude-account default <name>), else say how to pick. Only when accounts.json is there is it read, and then by the
# tool (`claude-account default`), with the tool's own file checks: no link, FIFO, looser mode, huge file or a default
# that is not a name is followed or waited on (security review 1, S5). With no file, a new terminal starts no node.
_claude_as_startup() {
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${CLAUDECODE:-}" ]; then return 0; fi
  local name=''
  local file="${CLAUDE_ACCOUNT_DIR:-$HOME/.config/claude-setup/accounts}/accounts.json"
  if [ -e "$file" ] || [ -L "$file" ]; then
    name=$(claude-account default) || name=''
  fi
  if [ -n "$name" ]; then
    claude-as "$name"
  else
    builtin printf '%s\n' "pick an account: claude-as <name>"
  fi
}

case $- in
  *i*) _claude_as_startup ;;
esac
