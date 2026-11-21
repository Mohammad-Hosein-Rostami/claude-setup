---
name: wf-land
description: Land one reviewed lane on the base branch on one straight line: rebase check, suite PASS at the tip, ff-only, prune (workflow). Fits landing that must survive an exit or several lanes in turn.
when_to_use: A lane passed its last review and must reach main; also for a finished branch of a git cleanup.
argument-hint: <branch>
---

Use this when the job fits a workflow by the rule in CLAUDE.md ("Inline, agent or workflow"). Landing always runs this workflow, whatever the size: land.js is the only check that the branch is still at the reviewed tip. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `row`, `closeRow`, `statusFile`, `repo`, `base`, `branch`, `worktree`, `suite`, `tip` (the sha the review cleared, the review result's `tip`; land refuses a branch that is not at it). A lane landed without its Opus-max pair (a waived lane, a hand land, a land after a usage limit) also gets `auditPending: true` and `auditBase` (the full sha its reviewed range starts at): land records the landed sha `pending` in audit-log right after the ff-only land, so sync and push wait for the audit; a failed record makes the land `failed` ("audit not recorded: gate holds nothing"). The hand audit is the `review` workflow in audit mode (`audit: {base, tip}`), recorded with `audit-log record ... --state done --confirmed <n>` or `--state error`.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/land.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: `{status, sha, patchesChanged, tidy}`. `landed` is the only landed state; `conflict` and `red` (the suite failed at the rebased tip; `tidy` is its output) need an implementer and a review of the delta; `needs-review` needs a review of the delta; `failed` names why in `tidy`. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
