# 0021: lex checks each plan against the code before handoff

- Status: accepted. Date: 2026-11-27. Builds on 0002 (team split), 0010 (round loop).
- Update 2026-11-27 (the owner's decision: no tests to catch bugs): D3 and its consequences are replaced (no tess-write run,
  no test list per plan). A plan adds no tests, no test-first piece and no `test/<topic>` branch unless the owner asks; a
  piece lists the existing tests that pin an old rule (Stale pins), and dev updates them by reading. Acceptance lines are read
  or near-free commands, never a test run; `pieces.json` has no `test` field.

## Context

In one week, 16 of 115 dev builds met a gap in lex's plan: tests or texts still pinning the old behaviour, a new rule an
existing test case breaks, an acceptance line that cannot fail, callers and error paths left out, and plans that asked dev to
test. lex's one re-read of its own plan did not find them; reading the tests and running the searches did.

## Options and decision

- D1 where the plan rules live: all in `lex.md` (about 175 lines, over its size) / `lex.md` plus a preloaded `plan-writing`
  skill (chosen) / `plan-writing` loaded on demand (loses on the very step this adds: a skipped load skips the check).
- D2 how a plan is checked: the self-attack only (today; it missed the gaps above) / a contact check and a pre-mortem by lex,
  against files and commands (chosen) / a dev spike per piece (one dev run per piece; kept as `needs: dev to probe` when a
  rule cannot be judged by reading).
- D3 who writes a planned piece's tests: plans take the writer from the agents' files of the day, test-first through
  tess-write where dev edits no test (chosen: right under every answer the owner gives) / plans fix one answer now (wrong under
  the others) / no Tests field (keeps the stale tests).

## Consequences

- Good: fewer dev stops and stale tests; tests stay with whoever the agents' files name; each plan names its test files.
- Bad: about 1.7k tokens more at each lex start (an estimate); 10-20 more commands per plan; one tess-write run before a
  test-changing piece where dev edits no test.

## Confirmation

Over the next 30 dev builds on lex plans, at most 1 in 10 reports a `contract-dispute`, an unlisted file or a stale test (this
week: about 1 in 7); else revisit the contact check. If lex's `analysis:` runs outnumber its plan runs two to one, move
`plan-writing` to on-demand loading.

## Sources

- Anthropic effort and prompting pages: platform.claude.com/docs/en/build-with-claude/effort,
  platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.
- Self-correction without external feedback is weak: Huang et al., ICLR 2024 (arxiv.org/abs/2310.01798).
- A changed signature adds obligations for every caller: CodePlan (arxiv.org/html/2309.12499v1).
- Pre-mortem: Klein, HBR 2007 (hbr.org/2007/09/performing-a-project-premortem).
- ADR format with Confirmation: MADR 4.0.0 (adr.github.io/madr/).
