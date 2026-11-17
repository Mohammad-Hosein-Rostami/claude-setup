# Mode: medium (balanced default)

Same models per task, same lead effort, same quality gates as every mode (see the lead rules and CLAUDE.md). This mode only sets parallelism, workflows and report brevity.

- Lane budget: up to 3 agents at once (writing agents; reads, reviews and verifiers are not capped by the mode); independent work goes in parallel. A parallel request gets a
  one-line usage-limit forecast first.
- Workflows: every agent runs in one (CLAUDE.md).
- Work as the lead rules and `~/.claude/CLAUDE.md` describe.

Applies to this session only.
