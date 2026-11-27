# 0022: dev builds it right without tests

- Status: accepted. Date: 2026-11-27 (owner). Builds on 0002 (team split); keeps the 2026-11-24 owner rule "dev and its
  helpers run no tests".

## Context

tess now gives a quick look by default, so dev's own work carries the quality. tess found 17 must-fixes after a dev "done":
acceptance not met or partial (5), stale tests or text (4), an input state not handled (4), a platform fact not checked (3),
a missed sibling site (1). dev's reports also broke its own rules: some ran tests while quoting "run no tests", 70 of 73 had
no verdict line, and partial work was hidden in the body. dev's agent text gave it no way of working that would prevent
these: acceptance lines were commands it could not run, and `safe-refactor` and the refactor standard told it to run tests.

The owner's answer (2026-11-27): no tests in dev's loop. dev must get it right by how it builds (implementation, focus),
not by testing; tests take too much time. In the owner's words: "no test ... the power of implementation and concentration
and focus should be well enough to not have these kind of bugs ... we must not try to test to catch bugs, tests take too
much time".

## Options

- A. dev runs a short check (syntax, lint, the tests that touch its files, the acceptance commands, probes). Catches the most
  before the land; costs seconds to minutes per piece; reverses the owner's rule.
- B. The same without tests. Fewer catches, still a run loop in dev.
- C. No tests; a set way of working by reading: the acceptance list first, every user and pin of what changes, each input's
  states decided before writing, small diffs, one review of the diff against each acceptance line, a parse-only check, an
  honest verdict. Chosen.
- D. C plus a fresh reviewer agent per risky piece. Declined: no study shows it beats self-review (SWR-Bench); tess's quick
  look already is a second reader.

## Decision

C. dev.md gets "Read the brief, then the code", "Review your diff" and "Done", and a nine-line reply that opens with
`verdict: done | partial (safe to land: yes|no) | blocked`. A test that pins old behaviour dev updates itself, by reading: it
changes only the expectation to the new behaviour, keeps what the test checks, never runs it, and lists it in its report as
`stale pin: <file:line> <old> -> <new>`; it is not sent to tess. dev-part and dev-docs name such a test for dev to update.
The parse check (`node --check`, `bash -n`, a JSON parse of the changed files) stays: it runs none of the code, takes about
0.02 s a file, and a syntax error in `home/` breaks every session the moment it lands. dev stays on Opus 5.5 at `high`.

## Consequences

- Good: no test time in dev's loop; one way of working in dev, dev-part, dev-docs and `safe-refactor`; a reply the boss reads
  in one look; partial work is named, with whether it is safe to land.
- Bad: dev has no outside signal before the land. Self-review without one can make answers worse (Huang et al.), so the
  review changes code only for a defect it can name. A miss is found only by tess after the land: its quick look still runs
  on each risky land at once, and on other code in the next tess round.

## Confirmation

Over the next 10 checked lands, count tess's must-fixes per class. Reopen this choice (option A, for the owner) if 2 or more
are of a kind an existing test or a one-line check would have caught, or a must-fix traces to a user, pin or input state the
detail file did not list.

## Sources

- Anthropic, prompting Claude Opus 5 and Opus 5.5 (platform.claude.com, read 2026-11-27): no "double-check" or "verify with a
  subagent" text; keep the task's parts in a checklist; reserve xhigh and max for a measured gain.
- Anthropic, Claude Code best practices (code.claude.com/docs/en/best-practices): ask for evidence; a fresh reviewer helps.
- Huang et al. 2023, arXiv 2310.01798: self-correction without an outside signal does not help and can hurt.
- SWE-agent, arXiv 2405.15793; Agentless, arXiv 2407.01489: checks that run gain fixes (the case for option A).
- SWR-Bench, arXiv 2509.01494: multi-agent review below a simple baseline.
- `node --help` (Node 26.5): `--check` "syntax check script without executing"; local probe: 0.02 s a file, exit 1 on a
  syntax error, a missing import not resolved.
