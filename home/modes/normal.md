# Mode: normal (thrift, so the week lasts)

Same models per task, same lead effort, same quality gates as every mode (see CLAUDE.md). This mode only sets speed and tokens.

- Fast mode: off (applied automatically by the mode hook).
- Run agents one at a time, unless two are independent and both needed now.
- Workflows only when the user asks; size small (fewer than 5 agents).
- Research: stop at the first sufficient authoritative source.
- No speculative or nice-to-have work; do what the task needs.
- Terse reports from agents and in the final answer; `/compact` at every seam.
- Do small things inline when briefing an agent costs more than doing it.
- Never downgrade a model or effort pick to save tokens; the quality gates still run.
- No turn caps: finish the run.
