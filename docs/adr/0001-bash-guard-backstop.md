# 0001: Bash guard backstop (string guard now, sandbox and env scrub only after a probe)

- Status: accepted for option A; options B (sandbox) and the env scrub are **not adopted** until their probes below have run and
  passed. Date: 2026-11-24.

## Context

`home/hooks/pre-bash-guard.mjs` reads each Bash command as text and asks the owner before risky ones (push, publish, deletes
outside the project). A probe on 2026-11-24 (temp HOME, no GUI) found commands it let through:

| command | decision |
|---|---|
| `git$IFS'push' origin main`, `git${IFS}push origin main` | allow (the command word was read as `git$IFS`) |
| `node -e "require('child_process').execSync('g'+'it push')"` | allow (interpreter code was judged only for deletes) |
| `python3 -c "import os; os.system('gi'+'t push')"` | allow |
| `echo Z2l0IHB1c2g= \| base64 -d \| python3` | allow (only `\| sh`-style stdin was a hazard) |
| `glab mr merge 1` | allow (only `gh` was known as a forge CLI) |

A text guard can close each concrete shape, but not every way a program can build a command at run time (split strings in
`node -e`). Claude Code has two built-in features that work below the text: its sandbox for Bash (`sandbox.enabled`,
`sandbox.filesystem`, `sandbox.network.allowedDomains`, `sandbox.failIfUnavailable`) and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`,
which strips credentials from the environment of Bash, hooks and stdio MCP servers. Each is documented in one source only, and
either may break the tools this setup runs from an agent's Bash (`npm ci`, `node --test`, `git commit` in a worktree, `gh`, and
`long-run`, which must still find the account).

## Options

| | A. extend the string guard | B. CLI sandbox as a backstop | C. both |
|---|---|---|---|
| closes `$IFS`, stdin interpreters, `glab` | yes | partly (by network rules) | yes |
| closes split strings in `node -e` | no (endless shapes) | yes (no network or writes outside what is allowed) | yes |
| cost and breakage | small, inside our own tests | unknown until probed: may break tools that write outside the project | medium |

## Decision

A now (lane L2 bash-guard): ask when a command word holds `$` (`$IFS`, `${...}`); treat `python`, `python3`, `node`, `perl`,
`ruby`, `deno` and `bun` fed from stdin like `| sh`; ask when inline interpreter code (`-e`, `-c`, `-p`) names `child_process`,
`exec`, `spawn`, `os.system` or `subprocess`; know `glab` like `gh`.

B and the env scrub are adopted only when their probe passes on one machine, each in a throwaway session (never the owner's own
settings), and this record is then updated with the results, the allowed domains and paths, and the new status (C).

### I3 probe: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`

In a throwaway session started with the variable set:

1. In Bash: `env | grep -c CLAUDE_CODE_OAUTH` (expected `0`: the token is gone from Bash).
2. From an agent's Bash: `node ~/.claude/tools/long-run/long-run.mjs check <job.json>` on a one-step Sonnet job (it spends
   nothing; expected: the account still resolves, because long-run reads the token from the account store, not from the
   environment).
3. `scripts/doctor.sh` (expected: exit 0).

Adopt (add the variable to `settings/base.json` `env`) only if all three pass. Result: **not run yet** (owner rule, 2026-11-24:
tests and probe runs are tess's job; asked for).

### I4 probe: the CLI sandbox

In a throwaway session with `sandbox.enabled: true` and a lane worktree:

1. `npm ci` in `home/tools/long-run`.
2. `node --test` of three test files, for example `tests/merge-settings.test.mjs tests/agent-budget.test.mjs tests/land.test.mjs`.
3. `git commit` of a scratch file in the worktree (the pre-commit hook runs gitleaks and share-check).
4. A `gh` read call, for example `gh api rate_limit`.

Adopt (with the domains and paths those steps needed) only if all four pass; otherwise record "not adopted" with the step that
failed. Result: **not run yet** (same reason as above).

## Consequences

- The known bypasses close with A alone; split-string interpreter code stays a known gap until B is probed.
- Nothing in the owner's settings changes on a guess: a failing probe leaves B and the scrub out, with the reason written here.
- When a probe has run, its commands' output decides; this record is the one place that says what was adopted and why.

## Sources

- Bypass probe and options: the setup audit of 2026-11-24, items H1, I3 and I4.
- Claude Code settings reference (sandbox keys) and environment variables page (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`),
  code.claude.com/docs/en/settings and code.claude.com/docs/en/env-vars, read 2026-11-24; one source each, so not yet relied on.
