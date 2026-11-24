---
name: test-writing
description: Use when writing or changing tests - new behaviour, a bug repro, a regression guard or a gap tess found: the project's runner and conventions, the right level, a failing test first for a bug, no weakened tests.
---

1. Find the runner and conventions: test script, config, two neighbouring test files (naming, folders, helpers, fixtures). Add no
   runner or dependency (C14). A project with no runner: report it, do not add one unless the brief says so.
2. Level: the lowest level that proves it. Unit for pure logic; integration across a boundary the project owns (db, fs, http
   handler); end-to-end only for a user flow no lower test can show; contract tests only where the project has them;
   property-based only when the library is already a dependency; a snapshot never as the only assertion.
3. Bug: write the repro first, run it, see it fail for the claimed reason before any fix, and quote the failing line. Then (dev)
   fix, or (tess-write) stop. The expected-failure form is allowed only in tess-write's commit-hook case.
4. New behaviour: one test per acceptance line or behaviour, named for the behaviour; arrange, act, assert; assert what a caller
   can see (return value, output, stored state, a call at a real boundary), never private internals.
5. Doubles: fake only real boundaries (network, clock, randomness, slow or external services); never mock the unit under test. A
   fake is as strict as the real thing (errors, limits, ordering), never kinder.
6. Prove it can fail: run the new test against the old code (base sources, or flip the changed condition). It must fail. A test
   that passes on both is a regression guard of unchanged behaviour (say so) or vacuous (rewrite it).
7. Vacuous patterns to avoid: both sides from the same function, `a || b` assertions, `toBeTruthy` for a specific value, order-only
   `indexOf` checks, negative text asserts that a copy change passes, an env knob set in every case, a precondition never reached.
8. Determinism: no sleeps (await the event, fake the clock), seeded randomness, unique temp folders, no network, no order
   dependence. Run each new test 3 times and once with its whole file.
9. Cross-platform: `path.join`, `os.tmpdir()`, no shell-only syntax inside tests, line endings not assumed. Tests must pass on
   macOS, Linux and Windows.
10. Never (C13): skip, `.only`, `todo`, deleted or loosened assertions, `-u` snapshot updates to go green, raised timeouts, a
    catch-all `try` in a test, hard-coded values that only make the test pass.

Done-gate: every new test listed with what it proves, its command, PASS on the tip (or the expected FAIL for a repro), FAIL on
the old code (or "regression guard"), and 3 stable runs.
