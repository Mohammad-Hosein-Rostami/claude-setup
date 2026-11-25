# End-to-end runs against real Claude Code

These scenarios start real `claude -p` sessions with this setup's agents, hooks and tools, and check what they did from their
transcripts, the guard log and the git state of throwaway repos. They cost subscription usage and take long (40 minutes per
scenario, 120 for E1), so they never run by themselves: `tests/e2e/**` is outside the `tests/*.test.mjs` glob, and a live run
needs `CS_E2E_LIVE=1`.

The normal suite tests the runner itself without a real `claude`: `tests/e2e-checks.test.mjs`, `tests/e2e-reads.test.mjs` and
`tests/e2e-traps.test.mjs` (the checkers, on fixture transcripts and failed git reads), `tests/e2e-jobs.test.mjs` (when a job is
done), `tests/e2e-safety.test.mjs` (model, redaction, env, HOME and cleanup rules) and `tests/e2e-runner.test.mjs` (the command
line, against a fake `claude`), `tests/e2e-login.test.mjs` and `tests/e2e-login-run.test.mjs` (where the login comes from,
with a made-up token in a file account store).

## Before a run

- Install the tool packages in the checkout under test: `npm ci --prefix home/tools/long-run` (also `env-names` and
  `ui-check`), as `scripts/install.sh` does.
- `~/.claude/settings.json` and `~/.claude/CLAUDE.md` must exist; the runner copies them and stops with a clear message if
  either is missing.
- The sessions need a subscription login, and a Claude Code session cannot hand its own login on. The runner takes it once,
  before it makes anything, in this order:
  1. `CLAUDE_CODE_OAUTH_TOKEN` of the terminal it runs in (a terminal opened with `claude-as <account>`).
  2. Otherwise, the account saved with the `claude-account` tool: the one `CLAUDE_ACCOUNT` names, else your default. These are
     the same rules hook jobs use.

  The token goes only into the sessions' environment, never on a command line or into a file. The runner prints only the
  source and the account name (`login: stored account <name>`). Printed lines, `results.json` and the kept logs mask the
  token's exact value as well as anything token-shaped. When there is no saved account, or the store cannot be read (a locked
  Keychain), the runner prints `no saved account: the owner runs E0 from a claude-as terminal` with the reason and exits 2.
  `--no-stored-login` skips the store; then the login check below decides. The dry run reads no login.
- Before any scenario, the runner runs `claude auth status --json` with the sessions' environment and the temp HOME. When that
  says you are not logged in, it prints one line and exits 2. A session that is refused its login stops the whole run the
  same way (exit 2), and nothing is retried. E0(e) also checks that every nested session ran logged in; when it fails, no
  later scenario runs.

## Commands

Run them in the repo root.

```sh
node tests/e2e/run.mjs --list                    # the scenarios
node tests/e2e/run.mjs --dry-run --all           # every setup step and command line; starts nothing
CS_E2E_LIVE=1 node tests/e2e/run.mjs --only E0 --out ~/e2e-results/E0
CS_E2E_LIVE=1 node tests/e2e/run.mjs --all --out ~/e2e-results/all
```

Start with E0 alone. It probes what the other scenarios rely on: whether a background agent's answer arrives in the same run,
the guard log line, the scripted dialog, the 12-minute wait ceiling and the login.

E0(a) sets the answer mode for the rest of the run, and the runner prints it (`e2e: E0 answer mode ...`):

- `direct`: the answer came in one run, so each job of E2, E3, E5 and E6 runs once.
- `resume`: E0 needed `--resume` rounds, or did not finish, or did not run. Each job then gets `--resume <id> "continue"`
  rounds (at most 20) until it has a good result and a completed notice for every agent its boss started in the background.

A job that is still not done fails its own line, `each claude job ended`, which names the mode.

Options:

- `--only E0,E7` or `--all`: which scenarios, in run order.
- `--out <dir>`: where `results.json` and the redacted logs and transcripts go (default: a new folder in the temp folder).
- `--setup-from <checkout>`: the checkout under test (default: the one the runner is in).
- `--no-stored-login`: without `CLAUDE_CODE_OAUTH_TOKEN`, do not read the saved account.
- `--real-home`: E9 uses your real HOME, because long-run reads its token from the account store, which refuses a temp
  HOME. Every other scenario keeps the temp HOME, and the dry run prints each scenario's HOME. Without this option, E9 is
  reported NOT RUN. With it, E11's check of the real guard log is NOT RUN, because E9 writes to that log, so the run exits 1.

Exit codes: 0 every check passed; 1 a check failed or did not run; 2 a usage error, no `CS_E2E_LIVE=1`, no login, or not
logged in; 3 stopped at a usage limit (the reset time is printed, and nothing is retried).

Each check prints one line: `<scenario> <check> | <expected> | <observed> | PASS`, `FAIL` or `NOT RUN`.

## What a run touches

- Everything goes in a new folder `$TMPDIR/cs-test-e2e-<run>/`: the throwaway repos, their only remote (a local bare `origin`),
  and a temp HOME. That HOME links `agents`, `hooks`, `rules`, `skills`, `standards`, `tools` and `statusline.mjs` from the
  checkout under test, holds copies of your `settings.json` and `CLAUDE.md`, and has empty `logs/`, `state/` and `projects/`.
  The settings copy points its hooks at the temp HOME, drops `CLAUDE_GUARD_ASK` and turns auto-continue at a usage limit off.
- Every `claude -p` names `--model opus` or `--model sonnet` (or a full Opus or Sonnet id). The one place that builds its
  arguments, `lib/models.mjs`, refuses any other model, and the dry run fails if a command line lacks one.
- The sessions get a clean environment: API keys, auth tokens, base URLs and model remaps are removed. E4 sets one model remap
  on purpose, to check that it is denied.
- Printed lines, `results.json` and the kept logs pass through a redactor that masks keys, tokens and Bearer values.
- The dialog tool (`osascript` on macOS, `zenity` on Linux), `afplay`, `notify-send` and `powershell` are replaced by stand-ins
  that log their arguments, so no dialog, sound or notification reaches you; each dialog gets the answer a scenario scripts.
- At the end, or on Ctrl-C, every process the run started is ended and the run folder is removed; the runner removes only a
  folder it made itself. A second Ctrl-C kills everything at once.
- E11 checks that the real checkout's `git status`, the long-run listing and the real guard log are unchanged.

## Differences from the plan

- The dry run prints the steps and commands without running the checks.
- The no-model-name rule allows the word only in E4's lines: its title and its deny cases name the model on purpose.
- A check that did not run counts as a failure (exit 1).
- On Windows, the scenarios that need the stand-ins are reported NOT RUN.
- `--real-home` applies to E9 only, not to the whole run, and E11's real guard log check is NOT RUN under it.
- E0's answer mode also applies to E2, E3, E5 and E6, not only to E1. A job left not done fails its own line.
- The login check runs once before any scenario, and a refused login stops the run with exit 2.
- Without a token in the terminal, the runner reads the saved account itself and never prints it. `--no-stored-login` turns
  that off.
