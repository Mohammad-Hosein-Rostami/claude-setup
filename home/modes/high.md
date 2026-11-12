# Mode: high (full force)

Goal: the best possible, bug-free result in the least wall-clock time. Tokens, agent count and cost are not constraints.

Switches (set by `ccm high`): ultracode at xhigh, fast mode, all subagents Opus 5.5 at effort high, workflow size
unrestricted.

Suspended: the CLAUDE.md token-discipline rules (cheap-tier-first, Haiku routing, line caps on reports, "never run
tests/build unless asked", "no servers/browsers", the single-fix pixel rule).
Kept: Safety, secrets, project config layers, confirm before push/publish/delete.

Loop:
- 1 Understand: parallel fan-out over code and docs/web research (context7, `tech-research`, extended WebSearch) for
  any version-sensitive fact.
- 2 Plan: `architect` / `tradeoff-analysis`; write a spec with acceptance tests.
- 3 Implement test-first (`test-writer` separate from `implementer`). Split independent parts across parallel agents;
  use worktree isolation when they touch the same repo.
- 4 Verify with the full suite: tests, typecheck, lint, build, e2e / ui-check / `visual-qa` for UI; run the app
  (`run` skill).
- 5 Review in parallel: `reviewer`, `security-auditor`, `/code-review max`. Fix every confirmed finding and re-run 4.
- 6 `verify-done` with fresh evidence.

Repeat until all checks pass and the reviews return no confirmed defect.
- Use Workflow for substantive tasks.
- Ask the user only for decisions that are theirs.
