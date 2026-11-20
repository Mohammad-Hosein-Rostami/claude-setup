# home/tools/account/lib

The parts of the account tool. `../README.md` explains what it is for, the threat model and what is not verified.
The command is `../account.mjs`; the shell functions are in `home/shell/`. No npm dependencies.

## Files by job

- Rules for input: `names.mjs` (the account-name and token patterns, the pasted line, `AccountError`).
- The list of accounts: `registry.mjs` (`accounts.json`: date added, plan, credits-off, last check, the default; never a
  token), `private-file.mjs` (reads a file only when it is a regular 0600 file in a 0700 folder).
- Where tokens live: `store.mjs` (picks by system), `keychain-store.mjs` (macOS, `/usr/bin/security -i` on stdin),
  `file-store.mjs` (Linux, 0600 files), `dpapi-store.mjs` (Windows, not verified).
- What callers use: `accounts.mjs` (add, remove, list, the owner's answers, and `accountForCall`: which account a hook
  job may spend), `check.mjs` (valid / revoked: one Haiku call through recall's `claude-call.mjs`).

## Who imports it

`home/tools/recall/lib/claude-call.mjs` imports `accounts.mjs` and `names.mjs` in process (the login of a hook job).
`check.mjs` imports `claude-call.mjs` back, so nothing in `accounts.mjs` or below may import `check.mjs`.

## Watch out for

- A token is never a command argument, never part of an error message and never written outside the store. A new
  code path that handles one needs a test with the leak scan (`assertNoLeak` in `tests/account-helpers.mjs`).
- A name or token reaches the `security` command text unquoted. That is safe only because both patterns allow no
  space, quote or newline: keep the `assertName` / `assertToken` calls in front of every store method.
- `registry.mjs` writes `accounts.json` with two-space indentation; `home/shell/claude-as.sh` finds the default by
  that exact line at shell start.
- `security` given a keychain file that does not exist writes to the login keychain instead. `keychain-store.mjs` refuses
  such a path, and `tests/account-keychain.test.mjs` uses account names of its own per run, checks the login keychain
  for them afterwards and removes one it finds. Keep both when you change the store or try a mutant on it.
- `accountForCall` never falls back from a named account to the default. The setup never switches accounts by itself.
