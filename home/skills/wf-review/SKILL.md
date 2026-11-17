---
name: wf-review
description: Review a lane or branch with its tiered lens set, verify findings, fix them, and re-review the fixes until a round is clean (workflow).
when_to_use: A change needs its review (and fixes) before landing, or the owner asks to review a branch.
argument-hint: <branch or range>
---

Run this job as a workflow (the owner's rule: everything that runs is a workflow), not as single agents. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `row`, `repo`, `base`, `range`, `landing` (true before a push or landing), `fix`, `branch`, `worktree`, `suite`; optional `tier`, `addClasses`, `laneClasses`, `deltaOf`, `initialFindings`.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/review.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: `{status, rounds, tip, worktree, tierFile, suite, findings, optional, leadList, text}`. `clean` is the only status that lets a lane land; `incomplete` and `failed` mean a lens or a fix step did not finish (read `text`); every `leadList` item (a security finding a judge called not real) goes to the owner with its reason. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
