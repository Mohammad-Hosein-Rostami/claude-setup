# Mode: medium (balanced default)

Same models per task, same lead effort, same quality gates as every mode (see CLAUDE.md). This mode only sets speed and tokens.

- Fast mode: off (applied automatically by the mode hook).
- Independent work goes to agents in parallel, in one message.
- Workflows only on user opt-in; size medium (fewer than 10 agents).
- Work as `~/.claude/CLAUDE.md` describes; stop at the first sufficient answer when researching.
- Safety, secrets, project config layers and quality rules apply.
