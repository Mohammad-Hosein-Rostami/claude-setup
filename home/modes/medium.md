# Mode: medium (balanced default)

Same models per task, same lead effort, same quality gates as every mode (see the lead rules and CLAUDE.md). This mode only sets parallelism, workflows and report brevity.

- Independent work goes to agents in parallel, in one message.
- Workflows (a script that runs many agents in phases): Claude may propose one when it clearly helps and say roughly
  what it costs; it starts only after the user says yes; up to 9 agents.
- Work as the lead rules and `~/.claude/CLAUDE.md` describe; stop at the first sufficient answer when researching.
- Safety, secrets, project config layers and quality rules apply.

Applies to this session only.
