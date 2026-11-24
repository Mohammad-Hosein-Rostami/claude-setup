---
name: root-cause-debug
description: Use for a bug, failing or flaky test, red CI or unexpected behaviour, before proposing any fix.
---

Iron law: no fix before a confirmed root cause (C22).

1. Reproduce with the smallest command. Record the exact error and command. No repro: add logging, do not guess.
2. Read the full failing path, not just the top frame. Check `git log -p` on touched files for recent changes.
3. Write 1-3 ranked hypotheses. Test each with one cheap observation (log, assertion, bisect). Discard on evidence.
4. Trace backwards from the symptom to the first wrong value; fix at that origin.
5. Fix the cause at every site of its class (search the repo and name the count); one branch for all attempts, reverting a wrong earlier fix. Apply the smallest fix per site. Re-run the repro command after the fix.
6. After two failed fixes, change approach instead of retrying: write findings (repro, hypotheses tried, evidence) to a file, hand them to the `dev-debug` agent, then apply its fix and continue until the repro passes.

Ladder: a failed fix goes once to `xhigh`, then once to `max`, then back to `lex` for a re-plan; a UI repro uses the owner's conditions.

Second report of the same defect (the owner says it is still broken): reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data) and hand it to `dev-debug` before any fix; never answer "no defect" to a second report. The condition joins the UI matrix for good.

Flaky tests (pass and fail with no code change): reproduce by running the test 20-50 times alone, then with the suite, then in parallel, and record the failure rate. Classify the cause: shared state or order, clock or timers, randomness, un-awaited async, network, a race in product code, ports/files, colliding test data. Fix that cause (isolate state, fake the clock, seed randomness, await the event, fake the network, unique ids); a retry or longer timeout is not a fix, and a race in the product is fixed in the product. Rerun the same count to prove it.

Never: silence the check (C13), catch-and-ignore (C9), retry until green.

Done-gate: root cause in one sentence with evidence; the repro command re-run after the fix and its result quoted.
