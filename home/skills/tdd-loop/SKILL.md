---
name: tdd-loop
description: Use when implementing a feature or bug fix with testable behaviour, including any new logic or branch.
---

Iron law: no production code without a failing test first (C11, T2).

1. Pick the next smallest behaviour from the acceptance criteria. One test per cycle.
2. Red: write the test through the public interface (T3), Arrange-Act-Assert (T5). Run it. It must fail for the stated reason, not a typo or import error.
3. Green: the least code that passes (C1). Run it.
4. Refactor with tests green: remove duplication (C2), rename (C5). Run the related tests.
5. Commit the cycle (C16), then repeat.
6. Cover empty, null, boundary and unauthorised paths (T7). Mock only at system boundaries (T6); never mock the unit under test.
7. Mutation sanity once per new behaviour: break the new code on purpose, confirm a test fails, restore it.

Expected values come from the spec, never from the implementation's current output. Do not edit a test to make it pass without saying why in the commit body. Never add `.skip` or `.only` (C13). Test-after is allowed only for pure glue with no branches; say so.

Reject: "too simple to test", "I'll add tests after".

Done-gate: each new behaviour has a test seen failing then passing; related tests of the whole change green, exit code quoted; the full suite runs once at landing.
