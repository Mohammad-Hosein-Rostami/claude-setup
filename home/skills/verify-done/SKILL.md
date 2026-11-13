---
name: verify-done
description: Use before claiming a task is done, fixed, passing or ready for review, and when the owner says done, ship or merge.
---

Iron law: no claim of done without fresh evidence from this turn (C12, C29).

1. `git status --short` and `git diff --stat`. Revert or justify any file the task did not need (C18).
2. Run the checks the owner asked for (typecheck, lint, tests, build), narrowest first. Quote command and exit code, and the count of tests that ran. Checks not asked for go on the `not run` line. A `runner` result from this turn that started after the last edit counts as fresh evidence: quote it. Re-run only when files changed after it or it was not run.
3. Re-run the original repro or acceptance check; show it now passes.
4. Grep the diff for `ts-ignore`, `eslint-disable`, `.skip`, `.only`, `console.log`, debug code (C13). Remove or justify.
5. New logic has a test that fails without it (C11).

Report (max 8 lines): `checks: <cmd> -> <exit>` per check; `repro: pass|fail`; `not run: <check> because <reason>`; `not verified: <x>`.

Reject: "should work", "tests passed earlier", "trivial change", "CI will catch it". For a second opinion from a fresh context, use the `reviewer` agent.

Done-gate: every check has an exit code from this turn or a `not run` line. No fabricated passes.
