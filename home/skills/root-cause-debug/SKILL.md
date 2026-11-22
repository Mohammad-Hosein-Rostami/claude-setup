---
name: root-cause-debug
description: Use for a bug, failing or flaky test, red CI or unexpected behaviour, before proposing any fix.
---

Finding the cause (reading, reproducing with a command) always runs; writing a failing repro test and test runs need `test` on with `/check`; off, say `not checked: test`.

Iron law: no fix before a confirmed root cause (C22).

1. Reproduce with the smallest command. Record the exact error and command. No repro: add logging, do not guess.
2. Read the full failing path, not just the top frame. Check `git log -p` on touched files for recent changes.
3. Write 1-3 ranked hypotheses. Test each with one cheap observation (log, assertion, bisect). Discard on evidence.
4. Trace backwards from the symptom to the first wrong value; fix at that origin.
5. Write a regression test that fails before the fix and passes after (C11, T2).
6. Fix the cause at every site of its class (search the repo and name the count); one branch for all attempts, reverting a wrong earlier fix. Apply the smallest fix per site. Re-run the repro and the nearest suite.
7. After two failed fixes, change approach instead of retrying: write findings (repro, hypotheses tried, evidence) to a file, hand them to the `deep-debugger` agent, then apply its fix and continue until the test passes.

Ladder: a failed verify goes once to `xhigh`, then once to `max`, then back to the architect for a re-plan; a UI repro uses the owner's conditions.

Second report of the same defect (the owner says it is still broken): mark the row with `node ~/.claude/tools/status/status.mjs defect <id> "<the owner's conditions>"`. The second mark adds a `rootcause:<id>` row: reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data) and hand it to `deep-debugger` before any fix; never answer "no defect" to a second report. The condition joins the UI matrix for good, and every owner-reported defect becomes a regression test.

Flaky tests (pass and fail with no code change):
- Reproduce: run it 20-50 times alone, then with the suite, then in parallel. Record the failure rate.
- Classify: shared state or order, clock or timers, randomness, un-awaited async, network, a race in product code, ports/files, colliding test data.
- Fix the cause: isolate state, fake the clock, seed randomness, await the event, fake the network, unique ids (T4). A retry or longer timeout is not a fix. If the product has a race, fix the product.
- If the fix must wait, quarantine with an owner and a tracking note.
- Prove it: rerun the same count, all green.

Never: silence the check (C13), catch-and-ignore (C9), retry until green.

Done-gate: root cause in one sentence with evidence; regression test red then green; then `verify-done`.
