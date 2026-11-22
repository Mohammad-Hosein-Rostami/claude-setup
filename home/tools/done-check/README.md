# done-check

The always-on code check: the project's own typecheck, lint of the changed lines and the tests related to the changed files, plus a scan
for weakened tests. Every failure is compared with the base commit, so only failures the change caused block. It costs no model tokens
when green. Design: road `newchk`, `design.md` sections 3 and 6.

## Command line

```text
node done-check.mjs run --worktree <abs> [--base <40-hex>] [--where land|manual] [--json]
node done-check.mjs last [--worktree <abs>] [--json]
node done-check.mjs stats [--days <n>] [--json] [--doctor]
node done-check.mjs label <run-id> --as false-alarm|real|missed --check <kind> [--note <up to 200 chars>]
```

| Command | What it does | Exit |
|---|---|---|
| `run` | checks every code file changed between `--base` (default: the worktree's HEAD, so uncommitted work) and the worktree; prints the `checks:` line, then the reason when it blocks (`--json`: the Verdict) | 0 ok, reused or nothing to check; 1 new failures or weakened tests; 2 usage; 3 internal error |
| `last` | prints the line of the newest recorded run of the repository of `--worktree` (any repository without it) | 0 |
| `stats` | per check kind: runs, blocks, acted on, ignored, false-alarm rate, median and p90 time, why it did not run; then `by model and effort:` one line per model and effort of the agent that stopped (runs, blocks, left open, median run time; `--json`: `byModel`); `--doctor` adds one `WARN` line per kind over 10% false alarms after 10 blocks, and one when the ledger is full | 0 |
| `label` | records the owner's verdict on one check of one run; a `real` label takes an ignored block out of the false-alarm rate | 0, 2 for an unknown run id or a bad flag |

Usage errors (an unknown flag, a relative `--worktree`, a `--base` that is not 40 hex, a folder that is not a git worktree) exit 2 before
anything runs. `DONE_CHECK_SKIP=all` skips every check (one ledger row); a comma list of `types`, `lint`, `tests` skips those kinds.

## The line

`checks: types ok · lint ok · tests ok, 1 old fail · 12.3 s · review: needed (security)`

- `old fail`: the base has the same failure; listed, never blocking. `FAIL n new`: blocks.
- `n flaky`: a new test failure that passed when its test file ran once more at head (that file only, inside the base-side time budget). Listed, never blocking. A rerun that fails again, or cannot finish, leaves the failure new.
- `not run (why)`: the check could not run (`time`, `error`, `no-command`, ...). It never blocks and is never shown as ok. When a kind
  has several packages the line also names each one that did not run.
- `tests none related (n files)`: no test relates to the change. `base: none`: no git base, so failures block once, worded "may be older".
- `review: needed (classes)`: the change is in a risky class (`risk-rules.json`); the lead runs the reviewer. A file whose changed lines are only comments or blank lines is left out; any doubt (no base, a deleted file, a Vue file) keeps the class.
- `reused (same change) ok`: the same change key was already checked green; no command ran.

## What counts as a change

Code files (`ts tsx js jsx mjs cjs mts cts vue`) and the scripts in a `.githooks/` folder, plus the wide files (`package.json`, lockfiles, tsconfig, test and lint config). A changed text file (markdown, json, ...) counts too when a test file names it (the file name appears in a test-looking file's text): the related-test search then picks the tests that write its path, and no typecheck or lint runs for it. A text file no test names stays `checks: no code change`. In a `node --test` script part only the e2e or live globs are dropped (and named `e2e-or-live`); the other globs still pick related tests. `tests-weakened` also fails when always-true matchers (`toBeDefined`, `toBeTruthy`, `toBeFalsy`) are added while value-checking matchers go down.

## Files

| File | Job |
|---|---|
| `done-check.mjs` | the command line (importing it runs nothing) |
| `lib/check-change.mjs` | orchestration: plan, reuse, run, verdict, ledger row; the hook imports this only |
| `lib/base-compare.mjs` | reruns failed typechecks and failing test files at the base (caches the answers); reruns new test failures once at head (flaky) |
| `lib/verdict-text.mjs` | the line and the block reason |
| `lib/code-lines.mjs` | which lines of a JS or TS text hold code (risk classes skip comment-only edits) |
| `lib/*.mjs` (others), `risk-rules.json` | scope, detect, run, parse, base tree, ledger, weakened-test scan, risk classes |

The ledger is `~/.claude/state/done-check/ledger.jsonl` (counts only, no file names). Tests: `node --test tests/done-check-*.test.mjs`.

## Model and effort on a row

A stop row records the `model` and `effort` of the agent that stopped, so a model or effort choice can be judged by its numbers
(`stats`, trial T7). Both come from Claude Code's own records, never from the agent's report:

- `effort`: the hook input's `effort.level` (Claude Code 2.1.329 sends it on Stop and SubagentStop for a model that supports effort);
  when the input has none, the `effort` Claude Code wrote on the agent's newest reply in its transcript.
- `model`: the hook input has no model field, so it is the `message.model` of the agent's newest reply in its transcript
  (`agent_transcript_path` for a subagent, `transcript_path` for the lead; only the last 512 KB are read).

Each is one short token (`MODEL_PATTERN`, `EFFORT_PATTERN` in `lib/contract.mjs`) or `null`. Land and manual runs store `null` (no agent
stopped). Rows written before the fields existed have neither; `stats` shows both kinds as `unknown`.
