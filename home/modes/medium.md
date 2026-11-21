# Mode: medium (balanced default)

Same models per task, same lead effort, same quality gates as every mode (see the lead rules and CLAUDE.md). This mode only sets parallelism and report brevity; the job decides inline, agent or workflow (CLAUDE.md, "Inline, agent or workflow").

- Lane budget: up to 3 agents at once (writing agents, test-writers included; reads, reviews and verifiers are not capped by the mode); independent work goes in parallel. A parallel request gets a
  one-line usage-limit forecast first.
- Work as the lead rules and `~/.claude/CLAUDE.md` describe.

Applies to this session only.
