---
name: review-checklist
description: Use when reviewing a diff, or before returning a risky lane - checks it against its spec, acceptance lines and threat model by risk class; skips style and taste. Which checks to run is qa-plan.
---

1. Read: the spec, acceptance and `THREAT:` line first. Then the diff once, each changed file in full, and the callers and callees
   of every changed function.
2. Conformance: each acceptance line -> where the diff meets it (file:line), or a finding. A part of the diff with no acceptance
   line: does it still do what the spec says?
3. Class questions (the brief's, else these), plus `standards/security.md` S1-S11 for the security class:
   - security: can input from outside the trust boundary reach a command, path, query, permission or secret unchecked, and does every
     other route, tool, CLI or hook that does the same action check it too (the second door)?
   - data: can a write be lost, doubled, half-done or unrecoverable (migration, rollback, old and new code together, a cursor on a
     non-unique key, numbers past 2^53 through JSON)?
   - money: can an amount be wrong, repeated, rounded away or paid to the wrong party?
   - concurrency: can two runs collide on a lock, file, key or temp name, or a crash leave state that blocks the next run? Judge a
     lock by many parallel waiters with kills.
   - gate: can a check pass when it should block, block forever, be switched off by what it checks, or read an error as a pass?
   - large: which part has no acceptance line, and does it still do what the spec says? A removal: does a shared callee lose its
     only test, does a deleted file live on under a new path, does every consumer of a changed shape still get its fields?
4. Tests: do they fail when the code is broken (Google: "false positives")? Test edits in the diff (qa-plan step 8). Test-writing's
   vacuous patterns.
5. Classes that recurred before:
   - Kinder fakes: a test double that forgives what the real dependency does not; probe through the real service.
   - Vacuous tests: both sides from one function, always-true disjuncts, preconditions never reached, `includes(a) || includes(b)`,
     order-only `indexOf` checks, negative text asserts after a copy change, an env knob set in every case.
   - Errors read as absence: a failed read, list or git call taken as empty or "nothing open"; a wrapper whose failed exec exits 0.
   - Sibling sites: a fix on one branch, handler or call site leaves the others of its class open.
   - Shell: an `EXIT` trap set before the values it removes; secrets in a child's argv.
   - Node: object-literal lookups on untrusted keys read the prototype; a promise with no catch ends the process; `fetch` keeps
     custom auth headers on a cross-origin redirect.
6. Design and simplicity (Google headings, only where a rule breaks, never taste): design, functionality, complexity, tests,
   naming, comments, consistency, documentation; needless complexity is a rule break (C1, C33): an abstraction with one caller,
   a wrapper, an option nobody sets, a file, flag or dependency the spec does not need, defensive code for impossible states,
   code a reader cannot follow without its author. Name the simpler form; follow-up unless it breaks an acceptance line.
7. Each finding: file:line, a one-sentence claim, the invariant, other sites of the class (with the search used), a repro command
   or `follow-up`. A guess you could not check is not reported.

Done-gate: every changed file read; every acceptance line mapped; every finding has a repro or is marked follow-up.
