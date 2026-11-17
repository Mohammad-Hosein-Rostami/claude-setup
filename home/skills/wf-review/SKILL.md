---
name: wf-review
description: Review a lane or branch with its tiered lens set, verify findings, fix them, and re-review the fixes until a round is clean (workflow). Fits panels with verifiers and fix rounds across lanes.
when_to_use: Review panels with verifiers and fix rounds across 2+ lanes, or the owner asks for it; one lane's review set is reviewer and security-auditor as parallel agents.
argument-hint: <branch or range>
---

Use this when the job fits a workflow by the rule in CLAUDE.md ("Inline, agent or workflow"); a single lane or one review set is one background agent instead. First add and start this job's STATUS.md rows
(`node ~/.claude/tools/status/status.mjs add|start`) so the progress line follows them; the script's agent labels start with the row ids you pass.

Args to fill: `row`, `repo`, `base`, `range`, `landing` (true before a push or landing), `fix`, `branch`, `worktree`, `suite`; optional `tier`, `addClasses`, `laneClasses`, `deltaOf`, `initialFindings`, `waiverAt`, `principles`, `audit`.
`waiverAt` (a sha) is set only by build.js after its checkpoints passed: round 0 then runs the waiver lenses alone, and any finding makes round 1 a whole-range full-set round; never pass it by hand. `principles` is `{id, question}[]` for the lens prompts. `audit` is `{base, tip}`, the recorded shas of a landed waived lane (needs `fix: false`, `landing: false`; `range` is `base..tip`): it reviews that range with the audit set, an empty audit is `failed`, and a `findings` result blocks sync and push until fixed (`audit-log`).

Call the Workflow tool with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/review.js` and `args` = those keys plus `scriptsDir` set to
`${CLAUDE_SKILL_DIR}/../../workflows`. If Workflow refuses the path, Read that file and pass its text as `script` (same args).
Result: `{status, rounds, tip, baseSha, waived, worktree, tierFile, suite, findings, optional, leadList, text}`. `clean` is the only status that lets a lane land; `incomplete` and `failed` mean a lens or a fix step did not finish (read `text`); every `leadList` item (a security finding a judge called not real) goes to the owner with its reason. Tell the owner what came back; never report more than the result says. Details: `home/workflows/README.md`.
