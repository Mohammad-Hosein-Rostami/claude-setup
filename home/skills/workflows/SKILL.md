---
name: workflows
description: Run one of the setup's 8 workflows (build, review, land, bugfix, research, sync-machines, git-cleanup, step) through the Workflow tool, with its args, result statuses and STATUS-row steps. Fits parallel lanes, review panels with fix rounds, landing, machine sync (the MacBook and its sync targets, or the targets to a tag), a bug that needs parallel hypotheses, research fan-out, git cleanup, or one agent in the progress view.
when_to_use: A job that fits a workflow by the rule in lead.md ("Inline, agent or workflow"): 2+ lanes in parallel (build), review panels with fix rounds (review), every landing (land), every machine sync (sync-machines), a bug that survived one fix (bugfix), research over several sources (research), a git tangle or several repos (git-cleanup), one agent in the progress view or a resumable step (step). Resuming stopped runs is the wf-resume skill.
argument-hint: <workflow> <its arguments>
---

One skill for the setup's workflows: pick the section of the workflow the job needs ($ARGUMENTS names it), fill its args and
call the Workflow tool. Every script lies in `${CLAUDE_SKILL_DIR}/../../workflows/` (`${CLAUDE_SKILL_DIR}` is this skill's
folder); `scriptsDir`, where a workflow takes it, is `${CLAUDE_SKILL_DIR}/../../workflows`. Resuming runs after an exit is
the separate `wf-resume` skill.

Use a workflow when the job fits one by the rule in the lead rules (lead.md, "Inline, agent or workflow"): landing and machine sync
always run theirs, whatever the size; for the others a single lane or one review set is one background agent instead. First
add and start this job's STATUS.md rows (`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows
them; the script's agent labels start with the row ids you pass. Every result is reported as it came back: tell the owner
what came back, never more than the result says (details: `home/workflows/README.md`).

| workflow | script | when it fits |
| --- | --- | --- |
| build | `build.js` | Implementing a spec of 2+ lanes or writers in parallel that must reach the base branch; a single lane is one implementer agent. |
| review | `review.js` | Review panels with verifiers and fix rounds across 2+ lanes, or the owner asks for it; one lane's review set is reviewer and security-auditor as parallel agents. |
| land | `land.js` | A lane passed its last review and must reach main; also for a finished branch of a git cleanup. |
| bugfix | `bugfix.js` | A bug that survived one fix attempt or needs parallel hypotheses and a landed fix. A first fix of a plain bug is inline or one agent; a hypothesis set inside a running job is one deep-debugger agent. |
| research | `research.js` | A fan-out over several sources: versions, limits, prices, standards, comparisons or any claim that needs two independent sources. One research question is one background agent; for one library API question read the installed package's own docs; for a one-line lookup use /quick. |
| sync-machines | `sync-machines.js` | After a landing on the setup repo, or when the owner asks to sync the machines: the MacBook and its sync targets (settings/local.json; default the PC) to the same base tip, or the targets to a tag; one pinned CLI, bundle, ff-only pull, install, doctor on each; never pushes. Not for project repos. Machine sync always runs this workflow, whatever the size. |
| git-cleanup | `git-cleanup.js` | The owner asks to clean git, or git-tidy reports findings, and the job is a tangled history or spans several repos. A single merged branch or worktree is `git-tidy prune` inline. |
| step | `step.js` | The owner asks for one agent in the progress view, or a step of a multi-stage job that must be resumable. Otherwise one agent is a plain background Agent call. |

## build (`<spec path> [lanes]`)

Args to fill: `base`, `repo`, `suite` (the repo's declared full-suite command), `writers` (the mode's lane budget), `statusFile`, `lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}, matrix?, principles?, checkpoints?, addClasses?}]` (`matrix` is required for a ui-implementer: a coverage matrix path or `none: <reason>`), and `appendOnly?` (files several lanes may list, such as `docs/catalog.md`).

The lane contract comes from the spec's Contract block: `principles: [{id, question}]`, `checkpoints: [{id, run, exit, files, kind: 'red-first'|'keeps-working'}]` (ids unique within the lane; each `run` is a command with an expected exit code; the join runs it before and after the change and the script judges the exit codes), `addClasses` (review-tier classes to add). Two lanes may not share a file unless it is in `appendOnly`, and a checkpoint's `files` are locked: a lane that edits them comes back `contract-touched`, not reviewed.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/build.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, stop and tell the owner: build runs the child workflows `review` and `land`, and its own children `workflows/implement.js` (writers and the hand-over), `workflows/join.js` and `workflows/visual-qa.js` (the UI gate, also run by `bugfix`), which an inline `script` cannot run, so there is no inline fallback for this one.
Result: `{lanes: [{row, closeRow, status, sha, text, findings?, optional?, audit?}], leadList}`. A lane that passed its contract is reviewed with the short waived set and, once landed, audited beside the other lanes (`audit: {status: clean|findings|error|sampled-out, findings}`); `audit-findings` and `audit-error` lanes are landed but keep sync and push closed (`audit-log gate`): open a `rework:` row for the findings, or re-run the audit for an error. The one exception is an `audit-error` whose text says "gate holds nothing" (no usable shas, or the pending record failed): nothing was recorded, so run the audit by hand. An implementer's `contract-dispute` about a locked file comes back in `leadList` and blocks the lane's waived review: rule on it. A status `landed` lane with a sha is landed (`audit-findings` and `audit-error` too); read `text` of every other status and decide (`lead-decision` is a clean lane held for a disputed security finding: show it to the owner, land with the land workflow only after the ruling); list every `leadList` item and every `optional` finding for the owner. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.

## review (`<branch or range>`)

Args to fill: `row`, `repo`, `base`, `range`, `landing` (true before a push or landing), `fix`, `branch`, `worktree`, `suite`; optional `tier`, `addClasses`, `laneClasses`, `deltaOf`, `laneStart`, `baseTips`, `priorFindings`, `initialFindings`, `waiverAt`, `principles`, `spec`, `checkpoints`, `records`, `audit`. `spec` (the lane spec's path), `checkpoints` (`{id, run, exit?, kind?}[]`) and `records` (proof record paths) go into every lens, verifier and judge brief as evidence; never pass the implementer's summary or a "tests pass" or "fixed" claim. With `deltaOf`, pass `laneStart` when the earlier result has one (its `laneStart`: the full sha the lane started from); pass `baseTips` only with base-branch tips you recorded yourself (full shas: the tip before the lane was built, the sha each of your own lands returned), never a tip read from the lane's repository now. Without them the lane start is read through `review-tier` and never moves.
`deltaOf` (the full 40-character sha an earlier round reviewed, its result's `tip`: this run reads only what changed since) needs two more args, else the run is `failed` with the cause: `laneClasses`, the `laneClasses` of that round's result (class names such as `["security", "logic"]`; no file), and `priorFindings` (at most 200), that round's blocking and should-fix findings as `{id, severity, file, line, problem}` (its `findings`), which every lens verifies. Pass `priorFindings: []` only when that round ended clean. Never pass `tier` with `deltaOf` (the script throws): a delta round's set is `review-tier`'s own. For a whole-range review leave `deltaOf` out.
`waiverAt` (a sha) is set only by build.js after its checkpoints passed: round 0 then runs the waiver lenses alone, and any finding makes round 1 a whole-range full-set round; never pass it by hand. `principles` is `{id, question}[]` for the lens prompts. `audit` is `{base, tip}`, the recorded shas of a landed waived lane (needs `fix: false`, `landing: false`; `range` is `base..tip`): it reviews that range with the audit set, an empty audit is `failed`, and a `findings` result blocks sync and push until fixed (`audit-log`).

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/review.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: `{status, rounds, tip, baseSha, laneStart, waived, worktree, laneClasses, suite, findings, optional, leadList, text}`. `clean` is the only status that lets a lane land; `incomplete` and `failed` mean a lens or a fix step did not finish, a delta round's lenses did not close every prior finding (`prior: <n> fixed, <m> open`) or one said it `needs the full range` (run again without `deltaOf`), a fix committed nothing, or `review-tier` refused the round (an empty delta) (read `text`); every `leadList` item (a security finding a judge called not real) goes to the owner with its reason. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.

## land (`<branch>`)

Landing always runs this workflow, whatever the size: land.js is the only check that the branch is still at the reviewed tip.

Args to fill: `row`, `closeRow`, `statusFile`, `repo`, `base`, `branch`, `worktree`, `suite`, `tip` (the sha the review cleared, the review result's `tip`; land refuses a branch that is not at it). A lane landed without its Opus-max pair (a waived lane, a hand land, a land after a usage limit) also gets `auditPending: true` and `auditBase` (the full sha its reviewed range starts at): land records the landed sha `pending` in audit-log right after the ff-only land, so sync and push wait for the audit; a failed record makes the land `failed` ("audit not recorded: gate holds nothing"). The hand audit is the `review` workflow in audit mode (`audit: {base, tip}`), recorded with `audit-log record ... --state done --confirmed <n>` or `--state error`.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/land.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: `{status, sha, patchesChanged, tidy}`. `landed` is the only landed state; `conflict` and `red` (the suite failed at the rebased tip; `tidy` is its output) need an implementer and a review of the delta; `needs-review` needs a review of the delta; `failed` names why in `tidy`. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.

## bugfix (`<symptom, repro command if known>`)

Use this for a bug that survived one fix or needs parallel hypotheses (rule in lead.md, "Inline, agent or workflow"); once
loaded, the job runs in this workflow, not in plain agents.
Add the work row and its `close:` row to STATUS.md first (`status.mjs add`). Then call Workflow with
`scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/bugfix.js` and `args`:
`{repo, symptom, scriptsDir, row?, closeRow?, statusFile?, base?, suite?, repro?, branch?, reproAtOwnerConditions?, matrix?, land?, probeC?}` (defaults: row `bugfix`, closeRow `close:<row>`, statusFile `<repo>/STATUS.md`, base `main`; `reproAtOwnerConditions` names the owner's zoom, pixel ratio, OS, theme or data for a UI bug; `land: false` returns `reviewed` for a repo that lands by pull request) where `symptom` is the user's report ($ARGUMENTS),
`repro` the command that shows it (leave out when unknown: an implementer writes the failing test), `suite` the repo's declared
full-suite command (CLAUDE.md or the `test` script), `branch` defaults to `lane/<row>`, and `scriptsDir` is `${CLAUDE_SKILL_DIR}/../../workflows`.
The workflow returns `landed` (sha), `not-reproduced`, `unresolved` (the lead decides: `/escalate`), `failed`, or `review-findings` / `review-incomplete` / `review-failed` (nothing landed: read `text`). A land that finds the suite red, like a conflict, goes back to a fix agent and a new review inside the workflow. Every result carries `leadList`: list each item for the owner. It keeps working while you ask the owner anything.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.

## research (`<question>`)

Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/research.js` and `args`:
`{row, question, out, depth}` where `question` is $ARGUMENTS, `out` the report file (a `.md` path in the project's docs or the scratchpad;
the notes go next to it in `<out>.notes/`), and `depth` is `simple` (1-2 sub-questions), `compare` (2-4) or `complex` (5-8).
It returns `{path, unverified}`: read the report, tell the owner every claim listed as unverified and why.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.

## sync-machines (`<repo folder, base branch>`)

Machine sync always runs this workflow, whatever the size (rule in lead.md, "Inline, agent or workflow").
Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/sync-machines.js` and `args` `{row, repo, base}` (add `tag: 'r9-phase-N'` to put the targets on a phase tag)
(`repo` the setup checkout on this machine, `base` its base branch, usually `main`; `row` the STATUS.md row).
It stops unless the base folder has no tracked changes, `git-tidy` is clean, the full suite has a PASS at the tip and, when review-tier ships `audit-log`, `audit-log gate` exits 0 for the tip (no open or failed post-land audit).
It returns `{status, machines}` with sha and doctor exit per machine (`status` is `synced` only when both machines synced and passed doctor, else `partial` with each failed machine's diagnosis), or the problems that stopped it: fix those, then run it again.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.

## git-cleanup (`<repo folders>`)

Use this for a tangle or several repos (rule in lead.md, "Inline, agent or workflow"); once loaded, the job runs in this
workflow, not in plain agents.
Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/git-cleanup.js` and `args` `{row, repos}`
(`repos` an array of absolute repo folders; `row` the STATUS.md row).
It removes only what `git-tidy prune` proves merged and the plan clears, after a backup bundle in each repo's `.git/`.
It never touches dirty worktrees, unique commits or published merges: they return in `ownerItems`. Ask the owner each item
(`ask-owner`), land what `NEEDS LANDING` says, then run it again.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.

## step (`<agent type> <prompt>`)

Args to fill: `row`, `agentType`, `prompt`, `model`, `effort` (the agent file's own unless the job needs more), optional `isolation: "worktree"` when the agent writes next to other writers (a writer type needs it, or `alone: true` when no other writer runs), `statusFile` (the project's STATUS.md, so the agent reads its standing rules), and a `MATRIX:` line in the prompt for ui-implementer and visual-qa.

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/step.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: the agent's final text, or null when it was stopped (then say so). Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
