---
name: wf-bugfix
description: Fix a bug through the bugfix workflow - reproduce, three parallel hypotheses, fix, verify, then review and land. Fits a bug that needs parallel hypotheses and a landed fix.
when_to_use: A bug with a symptom to fix. A bugfix job always runs this workflow, whatever the size; a hypothesis set inside a running job is one deep-debugger agent.
argument-hint: <symptom, repro command if known>
---

A bugfix job always runs this workflow, whatever the size (rule in CLAUDE.md, "Inline, agent or workflow").
Add the work row and its `close:` row to STATUS.md first (`status.mjs add`). Then call Workflow with
`scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/bugfix.js` and `args`:
`{row, closeRow, statusFile, repo, base, symptom, repro?, suite, scriptsDir, branch?}` where `symptom` is the user's report ($ARGUMENTS),
`repro` the command that shows it (leave out when unknown: an implementer writes the failing test), `suite` the repo's declared
full-suite command (CLAUDE.md or the `test` script), `branch` defaults to `lane/<row>`, and `scriptsDir` is `${CLAUDE_SKILL_DIR}/../../workflows`.
The workflow returns `landed` (sha), `not-reproduced`, `unresolved` (the lead decides: `/escalate`), `failed`, or `review-findings` / `review-incomplete` / `review-failed` (nothing landed: read `text`). A land that finds the suite red, like a conflict, goes back to a fix agent and a new review inside the workflow. Every result carries `leadList`: list each item for the owner. It keeps working while you ask the owner anything.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.
