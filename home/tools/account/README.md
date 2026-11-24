# account: one Claude login token per account, set for one terminal only

You have several Claude accounts and use different ones in different terminals. This tool keeps one long-lived token
per account (from `claude setup-token`) in the system's secure store, and the shell function `claude-as` sets one of
them for the terminal you are in. Other terminals are not touched, closing the terminal drops it, and nothing is
written to a shell start-up file.

## Use

Source `home/shell/claude-as.sh` from your shell start-up file (zsh or bash; `claude-as.ps1` for PowerShell). Then:

| command | what it does |
|---|---|
| `claude-as work` | this terminal now uses the account `work` |
| `claude-as work` (a new name) | asks "Paste the token for work" with hidden input, checks it, stores it, uses it. The whole `export CLAUDE_CODE_OAUTH_TOKEN="..."` line is accepted too |
| `claude-as` | a numbered list to pick from (Enter alone picks nothing) |
| `claude-as --once` | uses a pasted token here without storing it |
| `claude-as --off` | this terminal has no account |
| `claude-account list` | per account: used in this terminal or not, date added, days left of its one year, valid / revoked (last check), plan, usage credits |
| `claude-account check [name]` | one tiny Haiku call per account; says `valid`, `revoked` or `check failed: <class>` |
| `claude-account remove <name>` | removes the token and the account's fields |
| `claude-account default [<name>\|none]` | the account a new terminal starts with (none by default; owner, 2026-11-19: no default); with no name it prints the default. `none` is reserved, never an account name |
| `claude-account plan <name> pro\|max\|ultra`, `claude-account credits-off <name>` | record your own answers; no token field names the plan (probe ACC-3) |

Run `claude-as` yourself in a normal terminal, not through Claude (not with `!`, not in chat): a paste typed there would
enter a transcript. The function refuses to prompt without a terminal, and the tool refuses to print a token inside a
Claude session. Two commands print a token, both only to a pipe and never inside a Claude session: `token <name>` and
`once` (which hands an unsaved paste back to `claude-as --once`).

Adding a name that is stored already says `replaced` (the plan and credits-off answers stay; the added date stays when
the same token is pasted again). A check that fails for another reason than revoked (a limit, a timeout, no network)
still stores the token and says `added account <name>, NOT verified (<class>); run claude-account check <name> later`. Ctrl-C at
the hidden prompt or during the check ends `claude-as` with echo on and nothing stored. Every change of accounts.json
holds the lock file `accounts.json.lock` in its folder, so two terminals that add at once keep both accounts.

A new terminal has no account unless you set a default; it prints one line, `pick an account: claude-as <name>`.

## Threat model

In scope:

1. **Another process of the same user.** It can read the store: a Keychain item made by `/usr/bin/security` is readable
   by any same-user `security` call with no prompt, and the Linux file is 0600 to the same user. The store is therefore
   no stronger than Claude Code's own login store.
2. **A child process of a `claude-as` terminal.** Every program started there (npm scripts and `postinstall`, dev
   servers, MCP servers) inherits the exported token. This is the same exposure as the `export` line used before, accepted
   until a descriptor path exists (below).
3. **`ps eww`.** A same-user process sees the token in the environment of the terminal's processes and of the
   `claude -p` child while it runs. Accepted.
4. **Shell history, transcripts and logs.** The token must never reach them. This is what the code defends, and each
   line has a test: a token is never a command argument (the Keychain command goes to `security -i` on stdin; the shell
   uses builtins only), never in a message, a log or a `usage.jsonl` row; `set -x` is switched off inside `claude-as`;
   an argument shaped like a token is refused; no temp file ever holds it.
5. **A hostile project folder.** After you trust it, its `.claude/settings.json` `env` can set `CLAUDE_ACCOUNT` (a hook
   job then spends another stored account) or `PATH` (`claude-call.mjs` starts `claude` by name). A trusted project can
   already run its own hooks as you, so nothing new is defended. The account a hook job used is in
   `usage.jsonl`, so a surprise shows there.

Out of scope: root, malware already running as you, a stolen unlocked Mac.

Reading a stored token is allowed for an agent that needs one (owner, 2026-11-19). Printing it into a reply, a report
or a command line, or committing it, is not.

## How it works

- **Store** (`lib/store.mjs`). macOS: the login Keychain, service `claude-setup-account`, account attribute = the
  account name, through `/usr/bin/security -i` reading its command from stdin. Linux: files
  `~/.config/claude-setup/accounts/<name>.token`, folder 0700 and files 0600 from the moment they are made; a link or
  a looser mode is refused. Windows: `<name>.dpapi` files protected with DPAPI for the current user.
  `CLAUDE_ACCOUNT_STORE=file` forces the file store (the tests use it). Never in the repo, never in `~/.claude`, never
  synced: each machine gets its accounts from you.
- **Fields that are not secret** (`lib/registry.mjs`): `~/.config/claude-setup/accounts/accounts.json` (0600) on every
  system: date added, plan, credits-off, last check, the default. `CLAUDE_ACCOUNT_DIR` moves the folder (tests). The
  shell's start-up reads the default through `claude-account default`, so the tool's file checks apply there too.
- **Names and tokens** (`lib/names.mjs`). A name matches `^[a-z0-9][a-z0-9_-]{0,31}$`; a token is one line
  `sk-ant-...` with no space, quote or newline. Both are checked before anything reaches the store, a path or the
  `security` command text.
- **Valid or revoked** (`lib/check.mjs`). One call through `callHaiku` of `lib/claude-call.mjs`
  (`--model haiku`, never `--bare`, hooks off, no session kept) on that token. "Revoked" is a reply holding "revoked" or
  "401". Anything else is `check failed: <class>`: the token is stored anyway and the line says so. `claude auth status`
  is never the proof: it says "logged in" for any token without asking the server (probe ACC-3).
- **Hook jobs** (`claude-call.mjs`). Claude Code removes `CLAUDE_CODE_OAUTH_TOKEN` from the environment of its hooks
  (probe ACC-9a, CLI 2.1.329; issue #101890), which is why a hook job (the removed recall checkpoint was one) had no login. A `claude -p` child that
  is given the variable does use it (probe (a2)). So a hook job reads the token from the store: the account named by
  `CLAUDE_ACCOUNT` (hooks do see that variable), else the default account, else none. With none it starts no `claude`
  at all, because a token-less child would spend whatever login is stored in the Keychain, and it writes one `auth` row. A
  `claude-as --once` terminal sets `CLAUDE_ACCOUNT=-`: its hook jobs spend no stored account. After an auth or
  usage-limit error no other account is tried; the setup never switches accounts by itself.

## Limits per account

Limits are per account. After a usage limit: switch with `claude-as <name>` and continue the session with
`claude --resume` (pick it from the list; not `--continue`, which may pick another terminal's session). Accounts share
one history, so resume and memory keep working. One condition (`research3/ALIGN-2.md` A060):

- A login change ends Claude Code's own wait for the limit reset, and the wait does not restart on resume
  (interactive-mode docs; `research3/changes.md` L1).

## Not verified

- **Windows**: `lib/dpapi-store.mjs` and `home/shell/claude-as.ps1` were written without a Windows machine or
  PowerShell. Probe ACC-5 is not run. Only the fake-runner test covers the store (the token goes to PowerShell on
  stdin, never in its arguments).
- **Linux, real run**: the file store is tested on macOS; no Linux machine ran it.
- **A locked Keychain** (an ssh session; probe ACC-6): the store then reports "the Keychain is locked" (exit 36, from
  the docs). Not run; the PC is reached at the end of the build.
- **macOS 15**: `security -i` was probed on macOS 26.6.2 only (ACC-4).
- **A token on a file descriptor** (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, probe ACC-7): `claude` does read a
  token from a descriptor, and hooks do not get it. This tool still exports the variable; moving `claude-as` to a
  `claude` wrapper that passes the token on a descriptor (so children of the terminal no longer inherit it) is a
  follow-up, not built here.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`**: with it on, hooks lose `CLAUDE_CONFIG_DIR` as well (probe ACC-8 part 1, also on
  macOS). A hook job's login through the store with the scrub on is not run yet (part 2).

## Test

    node --test tests/account-*.test.mjs tests/claude-call.test.mjs

Every test uses made-up tokens, a temp HOME and TMPDIR and the file store, or a fake `security` runner. After each
test a scan of the sandbox finds the token only in the store. `tests/account-keychain.test.mjs` runs the real
`/usr/bin/security` against a scratch keychain file (macOS only) and checks that the search list and the login
keychain are untouched; its other tests run a fake `security` program (found on a PATH of its own temp folder). One
trap worth knowing: `security` given a keychain file that does not exist writes to the login keychain instead, so the
store refuses such a path before running anything. After each call the file is checked again: a read must find the same
file, and after a write (which replaces the file) the path must still be a regular file with no link.
