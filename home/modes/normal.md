# Mode: normal (fewest agents at once, so the week lasts)

Same models per task, same lead effort, same quality gates as every mode (see the lead rules and CLAUDE.md). This mode only sets parallelism, workflows and report brevity.

- Lane budget: up to 2 agents at once; a parallel request gets a one-line usage-limit forecast first.
- Workflows (a script that runs many agents in phases): only when the user asks for one in their message; up to 4 agents. The cap limits agents, not coverage: remaining lenses run in later phases.
- Research: stop at the first sufficient authoritative source, except facts CLAUDE.md says need a second one.
- Terse reports from agents and in the final answer (evidence, not-run checks and open decisions stay); suggest `/compact` at a seam only when context is large (above ~100k).
- Do small things inline when briefing an agent costs more than doing it.
- Never downgrade a model or effort pick to save tokens; the quality gates still run.
- No turn caps: finish the run. At a usage limit, wait for the subscription reset.

Applies to this session only.
