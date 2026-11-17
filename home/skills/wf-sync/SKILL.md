---
name: wf-sync
description: Sync the MacBook and the PC to the same base tip through the sync-machines workflow - bundle, ff-only pull, install, doctor on both. Never pushes.
when_to_use: After a landing on the setup repo, or when the owner asks to sync the machines. Not for project repos.
argument-hint: <repo folder, base branch>
---

Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/sync-machines.js` and `args` `{row, repo, base}`
(`repo` the setup checkout on this machine, `base` its base branch, usually `main`; `row` the STATUS.md row).
It stops unless the base folder has no tracked changes, `git-tidy` is clean and the full suite has a PASS at the tip.
It returns `{status, machines}` with sha and doctor exit per machine (`status` is `synced` only when both machines synced and passed doctor, else `partial` with each failed machine's diagnosis), or the problems that stopped it: fix those, then run it again.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.
