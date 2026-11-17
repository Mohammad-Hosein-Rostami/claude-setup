---
name: wf-build
description: Build lanes of a spec in parallel worktrees, review them with fixes, and land each on the base branch (workflow).
when_to_use: Implementing a spec or plan of one or more lanes; any job that writes code and must reach the base branch.
argument-hint: <spec path> [lanes]
---

Run this job as a workflow (the owner's rule: everything that runs is a workflow), not as single agents. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `base`, `repo`, `suite` (the repo's declared full-suite command), `writers` (the mode's lane budget), `statusFile`, `lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}, matrix?, principles?, checkpoints?, addClasses?}]` (`matrix` is required for a ui-implementer: a coverage matrix path or `none: <reason>`), and `appendOnly?` (files several lanes may list, such as `docs/catalog.md`).

The lane contract comes from the spec's Contract block: `principles: [{id, question}]`, `checkpoints: [{id, run, exit, files, kind: 'red-first'|'keeps-working'}]` (ids unique within the lane; each `run` is a command with an expected exit code; the join runs it before and after the change and the script judges the exit codes), `addClasses` (review-tier classes to add). Two lanes may not share a file unless it is in `appendOnly`, and a checkpoint's `files` are locked: a lane that edits them comes back `contract-touched`, not reviewed.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/build.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, stop and tell the owner: build runs the child workflows `review` and `land`, which an inline `script` cannot run, so there is no inline fallback for this one.
Result: `{lanes: [{row, closeRow, status, sha, text, findings?, optional?, audit?}], leadList}`. A lane that passed its contract is reviewed with the short waived set and, once landed, audited beside the other lanes (`audit: {status: clean|findings|error|sampled-out, findings}`); `audit-findings` and `audit-error` lanes are landed but keep sync and push closed (`audit-log gate`): open a `rework:` row for the findings, or re-run the audit for an error. The one exception is an `audit-error` whose text says "gate holds nothing" (no usable shas, or the pending record failed): nothing was recorded, so run the audit by hand. An implementer's `contract-dispute` about a locked file comes back in `leadList` and blocks the lane's waived review: rule on it. A status `landed` lane with a sha is landed (`audit-findings` and `audit-error` too); read `text` of every other status and decide (`lead-decision` is a clean lane held for a disputed security finding: show it to the owner, land with wf-land only after the ruling); list every `leadList` item and every `optional` finding for the owner. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
