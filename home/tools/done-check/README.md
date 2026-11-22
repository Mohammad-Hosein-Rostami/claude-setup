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
| `stats` | per check kind: runs, blocks, acted on, ignored, false-alarm rate, median and p90 time, why it did not run; `--doctor` adds one `WARN` line per kind over 10% false alarms after 10 blocks, and one when the ledger is full | 0 |
| `label` | records the owner's verdict on one check of one run; a `real` label takes an ignored block out of the false-alarm rate | 0, 2 for an unknown run id or a bad flag |

Usage errors (an unknown flag, a relative `--worktree`, a `--base` that is not 40 hex, a folder that is not a git worktree) exit 2 before
anything runs. `DONE_CHECK_SKIP=all` skips every check (one ledger row); a comma list of `types`, `lint`, `tests` skips those kinds.

## The line

`checks: types ok · lint ok · tests ok, 1 old fail · 12.3 s · review: needed (security)`

- `old fail`: the base has the same failure; listed, never blocking. `FAIL n new`: blocks.
- `not run (why)`: the check could not run (`time`, `error`, `no-command`, ...). It never blocks and is never shown as ok. When a kind
  has several packages the line also names each one that did not run.
- `tests none related (n files)`: no test relates to the change. `base: none`: no git base, so failures block once, worded "may be older".
- `review: needed (classes)`: the change is in a risky class (`risk-rules.json`); the lead runs the reviewer.
- `reused (same change) ok`: the same change key was already checked green; no command ran.

## Files

| File | Job |
|---|---|
| `done-check.mjs` | the command line (importing it runs nothing) |
| `lib/check-change.mjs` | orchestration: plan, reuse, run, verdict, ledger row; the hook imports this only |
| `lib/base-compare.mjs` | reruns failed typechecks and failing test files at the base; caches the answers |
| `lib/verdict-text.mjs` | the line and the block reason |
| `lib/*.mjs` (others), `risk-rules.json` | scope, detect, run, parse, base tree, ledger, weakened-test scan, risk classes |

The ledger is `~/.claude/state/done-check/ledger.jsonl` (counts only, no file names). Tests: `node --test tests/done-check-*.test.mjs`.
