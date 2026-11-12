# Mode: high (full speed; tokens mostly ignored, never wasted)

Same models per task, same lead effort, same quality gates as every mode (see the lead rules and CLAUDE.md). This mode only sets parallelism, workflows and report brevity.

- Wide fan-out, in parallel in one message:
  - research: several sources at once;
  - debugging: one `deep-debugger` per hypothesis;
  - build: `test-writer` and `implementer` together; split independent parts across agents (worktree
    isolation when they touch the same repo);
  - review: `reviewer` and `security-auditor` together.
- Workflows (a script that runs many agents in phases): Claude starts one itself for substantive multi-part tasks,
  no size limit. Choosing `ccm high` or `/mode high` is the user's standing request for this.
- Reports: same short final answer as every mode (what changed, what was not run); agents return ≤ 300 words with
  file:line evidence; detail goes to files and the report gives the path.
- Merge duplicate findings, then verify only high/medium or disputed ones in batches: group by file or lens, ≤ 5 per
  verifier; each verifier re-reads the cited lines and judges each finding separately; security findings get their own
  verifier.
- Not wasteful: no duplicate agents on the same question; keep Haiku for mechanical work; keep each agent's pinned
  model unless an escalation rule in the lead rules applies.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete.
- Subscription usage only: speed comes from parallel agents and workflows, never from usage-credit features.

Applies to this session only.
