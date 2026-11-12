# Mode: high (full speed; tokens mostly ignored, never wasted)

Same models per task, same lead effort, same quality gates as every mode (see CLAUDE.md). This mode only sets speed and tokens.

- Fast mode: on (applied automatically by the mode hook; bills usage credits).
- Wide fan-out, in parallel in one message:
  - research: several sources at once;
  - debugging: one `deep-debugger` per hypothesis;
  - build: `test-writer` and `implementer` together; split independent parts across agents (worktree
    isolation when they touch the same repo);
  - review: `reviewer` and `security-auditor` together.
- Workflow is authorized (`/mode high` or `ccm high` is the user's opt-in). Use it for substantive multi-part
  tasks; size unrestricted.
- Not wasteful: no duplicate agents on the same question; keep Haiku for mechanical work; keep each agent's pinned
  model unless an escalation rule in CLAUDE.md applies.
- Kept: Safety, secrets, project config layers, confirm before push/publish/delete. Ask only for the user's decisions.
