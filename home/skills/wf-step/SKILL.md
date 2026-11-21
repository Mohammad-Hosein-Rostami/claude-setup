---
name: wf-step
description: Run one agent (architect design, UI build, visual-qa loop, any unmapped agent) as a workflow step with its STATUS row label, only when the owner asks for the progress view or the step is part of a multi-stage job that must survive an exit.
when_to_use: The owner asks for one agent in the progress view, or a step of a multi-stage job that must be resumable. Otherwise one agent is a plain background Agent call.
argument-hint: <agent type> <prompt>
---

Use this when the job fits a workflow by the rule in the lead rules (lead.md, "Inline, agent or workflow"); a single lane or one review set is one background agent instead. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `row`, `agentType`, `prompt`, `model`, `effort` (the agent file's own unless the job needs more), optional `isolation: "worktree"` when the agent writes next to other writers (a writer type needs it, or `alone: true` when no other writer runs), `statusFile` (the project's STATUS.md, so the agent reads its standing rules), and a `MATRIX:` line in the prompt for ui-implementer and visual-qa.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/step.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: the agent's final text, or null when it was stopped (then say so). Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
