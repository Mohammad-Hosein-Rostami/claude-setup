---
name: wf-build
description: Build lanes of a spec in parallel worktrees, review them with fixes, and land each on the base branch (workflow).
when_to_use: Implementing a spec or plan of one or more lanes; any job that writes code and must reach the base branch.
argument-hint: <spec path> [lanes]
---

Run this job as a workflow (the owner's rule: everything that runs is a workflow), not as single agents. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `base`, `repo`, `suite` (the repo's declared full-suite command), `writers` (the mode's lane budget), `statusFile`, `lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}}]`.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/build.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, stop and tell the owner: build runs the child workflows `review` and `land`, which an inline `script` cannot run, so there is no inline fallback for this one.
Result: `{lanes: [{row, closeRow, status, sha, text, findings?, optional?}], leadList}`. Only a lane with status `landed` and a sha is landed; read `text` of every other status and decide (`lead-decision` is a clean lane held for a disputed security finding: show it to the owner, land with wf-land only after the ruling); list every `leadList` item and every `optional` finding for the owner. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
