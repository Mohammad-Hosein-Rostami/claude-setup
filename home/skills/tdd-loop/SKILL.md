---
name: tdd-loop
description: Use when implementing a feature or bug fix with testable behaviour, including any new logic or branch.
---

Runs only when the owner turned `test` on with `/check`. Off: write the spec's acceptance lines before the code, build carefully, write and run no tests, and say `not checked: test`.

Iron law: no production code without a failing test first (C11, T2).

1. Pick the next smallest behaviour from the acceptance criteria. One test per cycle.
2. Red: write the test through the public interface (T3), Arrange-Act-Assert (T5). Run it. It must fail for the stated reason, not a typo or import error.
3. Green: the least code that passes (C1). Run it.
4. Refactor with tests green: remove duplication (C2), rename (C5). Run the related tests.
5. Commit the cycle (C16), then repeat.
6. Cover empty, null, boundary and unauthorised paths (T7). Mock only at system boundaries (T6); never mock the unit under test.
7. Mutants before review: run `test-pass mutants` on the changed lines: write each break of them as a patch file, run `node ~/.claude/tools/test-pass/test-pass.mjs mutants --patch <file>... -- <keep-green cmd>`, and copy its `mutants: <killed>/<n>` from the record; never type the count. A surviving mutant needs a test (or a reason in the report). Write one failing-first test per class of defect found.

Order and records: acceptance tests from the spec come before the code, and the implementer treats them as read-only. A bug starts with a failing repro, committed and recorded red before the fix (`test-pass.mjs record --role repro -- <cmd>`); after the fix the same command is recorded green. At every checkpoint run the keep-green set (the affected tests of the lane's files) with the repro and acceptance tests (`--role keep-green`); the inner loop may run only that set.

Expected values come from the spec, never from the implementation's current output. Do not edit a test to make it pass without saying why in the commit body. Never add `.skip` or `.only` (C13). Test-after is allowed only for pure glue with no branches; say so.

Reject: "too simple to test", "I'll add tests after".

Done-gate: each new behaviour has a test seen failing then passing; related tests of the whole change green, exit code quoted; the full suite runs once at landing.
