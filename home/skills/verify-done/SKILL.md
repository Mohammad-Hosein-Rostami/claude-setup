---
name: verify-done
description: Use before claiming a task is done, fixed, passing or ready for review, and when the owner says done, ship or merge.
---

Iron law: no claim of done without fresh evidence from this turn (C12, C29).

1. `git status --short` and `git diff --stat`. Revert or justify any file the task did not need (C18). `node ~/.claude/tools/git-tidy/git-tidy.mjs check` when the task touched branches or is about to land (C37).
2. Run the checks the owner asked for (typecheck, lint, tests, build), narrowest first. Quote command and exit code, and the count of tests that ran. Checks not asked for go on the `not run` line. A `runner` result from this turn that started after the last edit counts as fresh evidence: quote it. Re-run only when files changed after it or it was not run.
3. Re-run the original repro or acceptance check; show it now passes. In a git repo every check that counts is a proof record: `node ~/.claude/tools/test-pass/test-pass.mjs record --role <repro|acceptance|keep-green|suite|target> -- <cmd>` on the committed tree (a bug's repro also recorded red before the fix; mutants through `test-pass.mjs mutants`). Then write the hand-over to a file and run `node ~/.claude/tools/test-pass/test-pass.mjs proof <sha> --handover <file>` (add `--real-target` when the flow needs two clients, a device or a deployed URL): exit 1 refuses the hand-over (a record of another sha, 0 tests selected, a repro not red before, a skip written as a pass, an "all pass" over a failure, a typed count or `mutants:` the records do not hold, no run on the real target). Copy its `verdict:` line and every count from the record; never type one.
4. Grep the diff for `ts-ignore`, `eslint-disable`, `.skip`, `.only`, `console.log`, debug code (C13). Remove or justify.
5. New logic has a test that fails without it (C11).
5a. UI files changed (`node ~/.claude/tools/ui-proof/ui-proof.mjs changed --from <base> --to HEAD` exits 1): `node ~/.claude/tools/ui-proof/ui-proof.mjs check --tip HEAD --against <base>` must exit 0, a visual-qa PASS on this tree with no state worse; quote it on a `ui-proof:` line. A ui-implementer's own PASS is not the final gate.
6. Human-first (C31-C36): `node ~/.claude/tools/readable/readable.mjs check . --changed`: fix what your change added; list anything pre-existing as seen, not fixed. Answer the no-AI test in `standards/readability.md` for what you touched.

Report (max 8 lines; list every `UNCONFIRMED` line of STATUS.md, found with `grep UNCONFIRMED STATUS.md`): `checks: <cmd> -> <exit>` per check; `repro: pass|fail`; `not run: <check> because <reason>`; `not verified: <x>`.

Reject: "should work", "tests passed earlier", "trivial change", "CI will catch it". For a second opinion from a fresh context, use the `reviewer` agent.

Done-gate: every check has an exit code from this turn or a `not run` line. No fabricated passes.
