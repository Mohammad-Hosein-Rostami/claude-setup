# 0006: Switch a long run to another account with `resume --account`

- Status: accepted. Date: 2026-11-25.
- Superseded in part by 0008: the guard's deny list of Claude starts is gone; "never start `claude` or a long run" is an
  instruction now.

## Context

A long run records one Claude account when it starts and spends that account on every start of every step. When the account
reaches its usage limit, the run waits for the reset, which can take hours, even when another stored account has room. The
owner wants to move a run to another account by hand, in the middle of the run, without losing the work of its bosses.

Drivers: (D1) safety: the new account passes the same check as a start (stored, usage credits recorded off, a token in the
store), and no token is printed or put on a command line; (D2) each step keeps its own conversation and its agents' state;
(D3) a small change; (D4) the guard needs no change (its deny list of Claude starts already holds `long-run resume`,
`home/hooks/lib/claude-starts.mjs`).

Fact checked before the choice (2026-11-25, two sources): `claude --resume <id>` works under another account. A local probe
started a session on one subscription and resumed it with `-p --resume` on a second subscription with a different plan; the
answer came from the history, with the same session id. The platform docs say a move to another account works by sending the
full history, and that thinking blocks of Sonnet 5.5 and Haiku 5.5 work only in the account that made them: in another account
the API drops them, with no error. Opus 5.5 thinking blocks are not bound to an account.

## Options

| Option | D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| A. A flag on resume: `long-run resume <run> --account <name>` on a run that is not running | good | good | good: one flag | good |
| B. A new `account <run> <name>` command that pauses, waits, switches and resumes | good | good | ok: a wait loop and a new command | bad: the guard's deny list must learn the new command |
| C. Fresh sessions on the new account, with a handoff summary per step | good | bad: the bosses lose their history | bad: a new prompt path | good |

## Decision

A. The owner runs `long-run pause <run>`, then `long-run resume <run> --account <name>` (the `long-run` skill does both). A run
whose driver lives, a limit wait included, is refused with exit 4 and the pause command. The new name is checked against the
account name pattern before any store call (exit 2). The new account passes the start check, and its token is read from the
store only to prove it is there. `run.json` then names the new account and keeps a `switches` list (`from`, `to`, `at`); an
`account-switched` event goes to the run's events and the global event log; `summary.md` shows
`Account: <new> (was <old> until <time>)`. Each step that is not done reads `run.json` when it starts again, takes the new
account, keeps its session id and drops a limit wait recorded under the old account. Done steps keep the old name in their
journal, so usage history stays true. One account per run: no per-step accounts.

B loses on size and on the guard change; C throws away the bosses' history, which the probe shows is not needed.

## Consequences and reversal signals

- Good: the same session continues on the new account; the change is one flag and about 40 lines of code.
- Bad: two commands instead of one. The first start of each unfinished step after a switch writes its whole history into the
  new account's prompt cache once (the cache is per organization). Runs on Sonnet 5.5 or Haiku 5.5 lose their earlier thinking
  after a switch (dropped by the API, with no error); the visible conversation stays.
- Cross-account resume was tried on two personal subscriptions on Opus 5.5 only, not on a Team or Enterprise organization.
- Reverse to B's automatic pause when owners often forget to pause first. Move to C for the first start after a switch when a
  resume on a new account starts to fail (a step ends with a crash verdict right after a switch).
- Later option, not built: switch to a fallback account automatically when a limit is reached.

## Sources

- Preserved thinking across accounts: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking (read 2026-11-25)
- Sessions are local transcripts, and resume sends the whole conversation: https://code.claude.com/docs/en/sessions and
  https://code.claude.com/docs/en/agent-sdk/sessions (read 2026-11-25)
- Prompt cache per organization: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (read 2026-11-25)
- `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over the `/login` credentials: https://code.claude.com/docs/en/authentication
- Local probe on this setup's account store, 2026-11-25: a session started on one subscription, resumed with `-p --resume` on a
  second one (and the other way round, with the full default tool set); same session id, answer from the history, exit 0.
