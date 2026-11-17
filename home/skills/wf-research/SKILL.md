---
name: wf-research
description: Research a question through the research workflow - Opus scope, Sonnet gatherers in parallel, Opus synthesis and critic, URL re-checks. Fits a fan-out over several sources.
when_to_use: A fan-out over several sources: versions, limits, prices, standards, comparisons or any claim that needs two independent sources. One research question is one background agent; for one library API question use context7; for a one-line lookup use /quick.
argument-hint: <question>
---

Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/research.js` and `args`:
`{row, question, out, depth}` where `question` is $ARGUMENTS, `out` the report file (a `.md` path in the project's docs or the scratchpad;
the notes go next to it in `<out>.notes/`), and `depth` is `simple` (1-2 sub-questions), `compare` (2-4) or `complex` (5-8).
It returns `{path, unverified}`: read the report, tell the owner every claim listed as unverified and why.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.
