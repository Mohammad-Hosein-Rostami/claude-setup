---
name: wf-sync
description: Sync the MacBook and its sync targets (settings/local.json; default the PC) to the same base tip, or the targets to a tag, through the sync-machines workflow - one pinned CLI, bundle, ff-only pull, install, doctor on each. Never pushes. Fits a multi-stage job on two machines that must survive an exit.
when_to_use: After a landing on the setup repo, or when the owner asks to sync the machines. Not for project repos. Machine sync always runs this workflow, whatever the size.
argument-hint: <repo folder, base branch>
---

Machine sync always runs this workflow, whatever the size (rule in lead.md, "Inline, agent or workflow").
Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/sync-machines.js` and `args` `{row, repo, base}` (add `tag: 'r9-phase-N'` to put the targets on a phase tag)
(`repo` the setup checkout on this machine, `base` its base branch, usually `main`; `row` the STATUS.md row).
It stops unless the base folder has no tracked changes, `git-tidy` is clean, the full suite has a PASS at the tip and, when review-tier ships `audit-log`, `audit-log gate` exits 0 for the tip (no open or failed post-land audit).
It returns `{status, machines}` with sha and doctor exit per machine (`status` is `synced` only when both machines synced and passed doctor, else `partial` with each failed machine's diagnosis), or the problems that stopped it: fix those, then run it again.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.
