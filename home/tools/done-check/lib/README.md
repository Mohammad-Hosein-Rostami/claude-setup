# home/tools/done-check/lib

The parts of the `done-check` tool, which checks one change when an agent or the lead stops and gives one verdict.
`../done-check.mjs` is the command and `../README.md` has the options. Checks run as fixed argv commands, never through a shell.

One run (`check-change.mjs`): scope, plan, reuse of an earlier green run, run at head, compare failures with the base, verdict,
ledger row, one status line.

- `check-change.mjs`: the orchestration; one change in, one verdict out.
- `contract.mjs`: the shared vocabulary (check kinds, results, caps, JSDoc types); data only, imports nothing.
- `scope.mjs`: which code files a change touched, the base to compare with, and a key that is the same before and after the commit.
- `detect.mjs`: decides the typecheck, lint and related-test commands per package; runs nothing. Go's files go to `go-plan.mjs`.
- `go-plan.mjs`: the Go commands per module of a change (go vet, gofmt -d, go test -json of the changed package folders); runs nothing.
- `go-parse.mjs`: readers for go vet, gofmt -d (drift hunks) and go test -json output, with the same contract as `parse.mjs`.
- `script-words.mjs`: reads a package.json script as plain words and matches it to tsc, vitest, jest or `node --test`.
- `related.mjs`: picks the `node:test` files a change can break (changed, importing a changed file, or naming its path).
- `run-checks.mjs`: runs the planned commands in a small pool under one deadline and turns each output into a result.
- `parse.mjs`: readers for tsc, eslint json, vitest and jest json, and node:test TAP output.
- `base-run.mjs`: the base commit's files in a temp folder, and the cache of failures that already exist there.
- `base-compare.mjs`: tells which failures of the change the base has too (old) and which are new.
- `test-diff.mjs`: the weakened-test scan (deleted, skipped, `.only` or loosened tests; a test deleted with every module it imports, none renamed, is removed with its code, not weakened).
- `code-lines.mjs`: tells which lines of a JS or TS text hold code, so a comment-only change is not treated as a code change.
- `risk.mjs`: which risk classes a change falls in, from `../risk-rules.json`; a risky change gets one review before it lands.
- `ledger.mjs`: the append-only record of every run (with the model and effort of the agent that stopped) and the owner's labels on it.
- `false-alarms.mjs`: makes an owner's `false-alarm` label stick: the hashed ids of a run's new failures, and which of them a label lets through on a later run of the same repo and lane (branch).
- `verdict-text.mjs`: the status line the owner sees and the reason text an agent gets when its stop is blocked.
