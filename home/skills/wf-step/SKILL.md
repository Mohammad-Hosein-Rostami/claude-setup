---
name: wf-step
description: Run one agent (architect design, UI build, visual-qa loop, any unmapped agent) as a workflow step with its STATUS row label.
when_to_use: A single agent job that no other wf-* skill covers; a judgement read that needs more than /quick.
argument-hint: <agent type> <prompt>
---

Run this job as a workflow (the owner's rule: everything that runs is a workflow), not as single agents. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `row`, `agentType`, `prompt`, `model`, `effort` (the agent file's own unless the job needs more), optional `isolation: "worktree"` when the agent writes next to other writers.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/step.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: the agent's final text, or null when it was stopped (then say so). Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
