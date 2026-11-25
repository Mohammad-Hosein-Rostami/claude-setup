# End-to-end runs against real Claude Code

These scenarios start real `claude -p` sessions with this setup's agents, hooks and tools, and check what they did from their
transcripts, the guard log and the git state of throwaway repos. They cost subscription usage and take long (40 minutes per
scenario, 120 for E1), so they never run by themselves: `tests/e2e/**` is outside the `tests/*.test.mjs` glob, and a live run
needs `CS_E2E_LIVE=1`.

The normal suite tests the runner itself without a real `claude`: `tests/e2e-checks.test.mjs` (the checkers, on fixture
transcripts), `tests/e2e-safety.test.mjs` (model, redaction, env and cleanup rules) and `tests/e2e-runner.test.mjs` (the command
line, against a fake `claude`).

## Before a run

- Install the tool packages in the checkout under test: `npm ci --prefix home/tools/long-run` (also `env-names` and
  `ui-check`), as `scripts/install.sh` does.
- `~/.claude/settings.json` and `~/.claude/CLAUDE.md` must exist; the runner copies them and stops with a clear message if
  either is missing.
- Be logged in to Claude Code on the subscription. E0(e) checks that the nested sessions are; when it fails, no later scenario
  runs.

## Commands

Run them in the repo root.

```sh
node tests/e2e/run.mjs --list                    # the scenarios
node tests/e2e/run.mjs --dry-run --all           # every setup step and command line; starts nothing
CS_E2E_LIVE=1 node tests/e2e/run.mjs --only E0 --out ~/e2e-results/E0
CS_E2E_LIVE=1 node tests/e2e/run.mjs --all --out ~/e2e-results/all
```

Start with E0 alone. It probes what the other scenarios rely on: whether a background agent's answer arrives in the same run
(else later scenarios use `--resume` rounds), the guard log line, the scripted dialog, the 12-minute wait ceiling and the login.

Options:

- `--only E0,E7` or `--all`: which scenarios, in run order.
- `--out <dir>`: where `results.json` and the redacted logs and transcripts go (default: a new folder in the temp folder).
- `--setup-from <checkout>`: the checkout under test (default: the one the runner is in).
- `--real-home`: the sessions use your real HOME. Only E9 needs it, because long-run reads its token from the account store,
  which refuses a temp HOME. Without it, E9 is reported NOT RUN.

Exit codes: 0 every check passed; 1 a check failed or did not run; 2 a usage error or no `CS_E2E_LIVE=1`; 3 stopped at a
usage limit (the reset time is printed, and nothing is retried).

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
