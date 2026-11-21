# Saved workflows (`home/workflows/`)

Scripts for the Workflow tool, used when the job needs one (2+ lanes in parallel, review panels across lanes, research over several sources, a multi-stage job that must survive an exit; `home/CLAUDE.md`, "Inline, agent or workflow"), so the progress view shows it and each agent's label
(`<STATUS row>:<step>`) links to a row of STATUS.md. Claude Code resolves a workflow name from the session's own workflow folders (a project's `.claude/workflows/`), never from this folder, so the
setup runs them by path: the `workflows` skill (`home/skills/workflows/SKILL.md`, one section per workflow with its args, statuses and row steps) calls `Workflow({scriptPath: "${CLAUDE_SKILL_DIR}/../../workflows/<name>.js", args})`; `wf-resume` relaunches stopped runs.
`~/.claude/workflows` is a link to this folder (the install adds its link path to `permissions.additionalDirectories`, so the path is readable
from any project).

## The eight workflows

Args marked `?` are optional. Every script also accepts `scriptsDir` (this folder, for a script that runs a child). Every script also takes `checks` (the owner's `/check` categories; `hooks/workflow-script-check.mjs` sets it on each launch and the scripts pass it to their children): the test stages (test-writer, related tests, checkpoints, suite at land, bugfix Verify, sync's suite PASS) run only with `test`, the review stages (review, post-land audit, research critic, sync's audit gate) only with `review`, Visual QA only with `ui` (spec r9-checks-off). A bad args object throws
`<name>: args.<key> must be <type>` before any agent starts.

| script | skill | phases | args |
| --- | --- | --- | --- |
| `build.js` | `workflows` (`build`) | Build, Join, Review, Visual QA, Land, Audit | `base, repo, suite, writers, statusFile, scriptsDir, resume?, probeC?, lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}, matrix?, principles?, checkpoints?, addClasses?}], appendOnly?` |
| `review.js` | `workflows` (`review`) | Tier, Review, Verify, Fix | `row, repo, base, range, landing, fix, branch, worktree, suite, whole?, fixer?, tier?, addClasses?, laneClasses?, deltaOf?, laneStart?, baseTips?, priorFindings?, initialFindings?, waiverAt?, principles?, spec?, checkpoints?, records?, audit?` |
| `land.js` | `workflows` (`land`) | Rebase, Suite, Land | `row, closeRow, statusFile, repo, base, branch, worktree, suite, tip, auditPending?, auditBase?` |
| `step.js` | `workflows` (`step`) | Step | `row, agentType, prompt, model, effort, isolation?, alone?, statusFile?` |
| `bugfix.js` | `workflows` (`bugfix`) | Reproduce, Hypotheses, Fix, Verify, Review, Visual QA, Land | `repo, symptom, scriptsDir, row?, closeRow?, statusFile?, base?, suite?, repro?, branch?, reproAtOwnerConditions?, matrix?, land?, probeC?` |
| `research.js` | `workflows` (`research`) | Scope, Gather, Synthesize, Critic | `row, question, out, depth: 'simple'|'compare'|'complex'` |
| `sync-machines.js` | `workflows` (`sync-machines`) | Verify, Sync, Doctor | `row, repo, base` |
| `git-cleanup.js` | `workflows` (`git-cleanup`) | Inventory, Plan, Apply | `row, repos` |

Children that `build` (and, for `visual-qa`, `bugfix`) runs; they call no workflow themselves (nesting is one level), and the `workflows` skill (section build) names them:

| script | phases | args |
| --- | --- | --- |
| `implement.js` | Build | `role (implement or tests), row, branch, base, spec, files, statusFile, acceptanceTests, model, effort, agentType?, matrix?, checkpoints?, principles?` |
| `join.js` | Join | `row, closeRow, branch, base, files, statusFile, worktree, sha, disputes?, checkpoints?, written?` |
| `visual-qa.js` | Visual QA | `row, repo, worktree, tip, base, matrix?, uiFiles?` |

`build`, `review`, `land` and `step` are described below. The other four ship in the next lane (round 4, W2) with their own tests.

## How the four core scripts work

- `review` reads a lane through the lenses `review-tier` names (models and efforts exactly as it prints them) as a pipeline: a lens's blocking
  and should-fix findings go to Sonnet-high verifiers at once, confirmed ones enter the lane's serial fix queue while slower lenses still
  read, and a round ends only when every lens, verifier and judge of it has returned. A verifier's `real: false` drops a finding only when the
  verifier is at least as strong as the finder and the finding is not security; otherwise an Opus-max judge rules, and a security finding the judge
  calls not real goes to `leadList` with the reason. A finding whose lines a fix already changed becomes an open item of the next round (delta
  round, `review-tier --delta`: the lane's whole set, classes and plans, never a lighter one). In a delta round a runner writes the prior findings (fixed and open ones, one line each with its severity,
  no fixed/open claim) to a file for `--prior`; `review-tier` must count exactly that many (else `failed`), every lens gets all of them with the file's hash and returns `prior: <n> fixed, <m> open`, and the
  round is clean only when every lens has `m` 0 and `n + m` that count (else `incomplete`). The prior line is read in every delta round, also one that still has findings to fix: no line, a line with anything after it, counts that do not add up,
  or a lens that says `needs the full range` end the round `incomplete`; a prior finding a lens counted open without returning it stays `open` in the next round's prior file. A file name, a finding's text and a weakened check's path enter a prompt and the prior file as one quoted string (the rule of `review-tier`'s `lib/brief-data.mjs`, repeated in the script).
  A run with `deltaOf` (the full 40-character sha that round read: its result's `tip`) needs `laneClasses` (the class names of the round that reviewed `deltaOf`: its result's `laneClasses`, written inline into `--lane-classes`, no file) and `priorFindings` (at most 200), the blocking and should-fix findings of that round (`[]` only on purpose, when it was clean), which every lens of round 0 verifies; without them the run is `failed` with the cause, and `tier` with `deltaOf` throws.
  A `deltaOf` run with `initialFindings` and `fix: true` (the re-review `build` starts after a conflict or a red suite at land) fixes first, on Opus because no tier exists yet, and reviews the fix as round 1 on the same `deltaOf`; those findings are its prior findings, so it needs no `priorFindings`.
  `review-tier` refuses an empty delta: a `deltaOf` that is the lane's HEAD is `failed` with that cause, and a round whose fixes left HEAD where it was is `failed` ("the fix committed nothing for <ids>") before `review-tier` is asked again. The delta command names the lane start as a full sha (`--base <sha>`): the script takes it from the caller (`laneStart`: the `laneStart` of the result that reviewed `deltaOf`), else from the `base` field `review-tier` itself prints (for the first round, or in a `deltaOf` run for `<base>...<deltaOf>`), and reuses it in every later round, so a base branch moved during the run changes nothing. No runner runs `git merge-base` in the lane's repository: a commit-graph file forged there would move the answer. A fix round does not rebase the lane (it is rebased when it lands). Only a run that fixes first rebases: a `base` step reads the base tip as a full sha before the fix, and the fix rebases onto that sha. The lane start moves to that tip only when the caller passed `laneStart` and `baseTips` (base-branch tips it recorded itself: `build` passes the tip it read at its start and the sha each of its own lands returned), the tip is one of them, and `review-tier --rebased-onto` accepts it (the old start is its ancestor, it is an ancestor of HEAD, and it is not part of what was already reviewed); otherwise the round reads from the older start (more, never less). `initialFindings` with `fix: false` is `failed` (nobody would fix or re-read them), and a `review-tier` that exits non-zero is `failed` with the tool's own error line, quoted.
  In every round, the first one included and also for a `tier` the caller passed in, the `tip` in `review-tier`'s JSON must be the full sha the runner found in the lane worktree; otherwise the round is `failed` before any lens starts (the tool read another commit, for example through a `core.worktree` setting in the lane's config, so its review set is for other code).
  The same file blocking in two rounds in a row calls the `deep-debugger` before the next fix.
  With `landing`, the full suite runs on each round's tip beside the reviews (`test-pass run --repo <dir> --suite`, never with the command text). Result `clean` is the only landable state.
  A runner recomputes the review set with `review-tier` every round, from the lane's worktree and with every `--add-class`; the fix agent never supplies it. A tier that did not exit 0, has no `reviews` list,
  or (landing, or any delta round) is empty with nothing carried over ends the run `failed`. A verifier or judge that threw ends the round `incomplete`. The result's `tip` is the reviewed sha.
- `land` first checks that the branch is at the reviewed `tip` (else `failed`, nothing lands), runs `git-tidy land --rebase-only`, then a suite PASS at the tip, then `git-tidy land`; results `landed`, `conflict`, `needs-review`, `red`, `failed`.
- `land` and `build` start with a disk check (`~/.claude/tools/disk-free`, README there): below 5 GB free (`DISK_FAIL_FREE_GB`), or a check that could not run, `land` returns `failed` and `build` marks every lane `failed` before any agent or git step, with the message that names the caches to clear. `WARN` (below 15 GB) does not stop them.
- `build` runs lanes as a pipeline (implementer and, for `acceptanceTests`, a test-writer, each in a worktree), a Join runner, the `review`
  child, then a serial land queue through the `land` child, so lane A lands while lane B is still in review. A conflict, a `red` suite or changed patches go back through `review`.
  A lane whose review is clean but whose `leadList` holds a security finding ruled not real is held (`lead-decision`), never landed. `build` is run from its script file only: its children cannot run from an inline script.
- `build` hand-over: every writer brief tells the agent to write its constraints into the lane's hand-over note first (`HANDOFF-<row>.md` beside
  STATUS.md, never committed) and re-read it after a compaction, and, when it must stop, to commit, write done / left / next step / don't redo
  there and return `unfinished: true`. A stopped or unfinished implementer is handed over to a fresh agent from the branch tip with a six-field
  brief (objective and why; inputs: spec, diff, last report, note; Constraints; tools and sources; acceptance with defaults; output with "Not run"
  and "Caveats"); two stops in a row end the lane `implementer-stopped`.
- Visual QA (`build` and `bugfix`): a change whose UI files differ (ui-proof's one definition: the join's `uiFiles`, bugfix's verify) passes the
  `visual-qa` child on the tree that lands before each land; a FAIL is a fix round whose fixer is `ui-implementer` (`review`'s `fixer` arg in
  `build`, the lane agent in `bugfix`), then the gate again; `ui-proof` from `land` runs the gate on the rebased tip, never a review alone, then
  lands again. With `probeC: 'fail'` (phase 0 Probe C: hooks do not fire in workflow agents) a UI change is refused: UI lanes run as plain agents.
- `review` refuses a whole-range lane over 400 changed lines or 15 files (`failed`, "split the lane") unless `whole: true`; a delta round or an
  audit is never refused. A resumed run is served from the journal for the longest unchanged prefix, so relaunch with the same args.
- `step` runs one agent with the given type, model and effort. A workflow spawn does not fire `agent-model-guard`, so `step` repeats its gates by shape: a UI agent needs a `MATRIX:` line, a writer needs `isolation` or `alone: true`, `statusFile` adds the standing-rules line.

## Round 5: contracts, waiver and audit

Checkpoints and a waiver replace the second full review of a lane that a contract and its tests have already proven; an Opus-max audit after the land keeps the accuracy.

- `review`: `waiverAt` is the sha `build` proved by its checkpoints. Round 0 then runs only `tier.waivable.reviews`, and only when `waiverAt` is that sha, the tier came from the runner (not `args.tier`),
  `tier.waivable.reviews` is not empty, `tier.weakened` is empty and `deltaOf` is absent. `waived` in the result is true when that round 0 ended clean. Any confirmed finding, open item or red suite makes
  round 1 a whole-range, full-set round (`deltaOf` reset). `weakened` entries (a skipped test, a loosened bound, a removed assert) are listed in every lens prompt. `principles` (`{id, question}[]`,
  ids from `home/rules/principles.md`) are added to the tier's own `principles` in every lens prompt: each is answered yes or no with `file:line`, and a no is a finding. The result's `baseSha` (where the
  last round's tier started the lane) and `tip` are the range that was reviewed; `laneStart` is the lane start to pass on with `deltaOf`.
- `review` audit mode: `audit: {base, tip}` (recorded shas, never a branch name) needs `fix: false` and `landing: false`, else the script throws; it refuses `deltaOf`, `tier`, `waiverAt`, `initialFindings` and `priorFindings`.
  It reviews `tier.waivable.audit`, or the full set when the range is no longer waivable; a missing set gets the full set, but only an empty set, or 0 changed lines, is `failed` ("empty audit"), never clean.
- `build` contract: each lane may carry `principles`, `checkpoints` (`{id, run, exit, files, kind: 'red-first'|'keeps-working'}`) and `addClasses`; top-level `appendOnly` lists the files lanes may share.
  `checkArgs` throws when two lanes share another file or a checkpoint's `files` overlap its lane's `files`. The implementer never edits locked files (checkpoint files and the test-writer's); it writes `contract-dispute: <file>: <why>` instead.
- `build` join: a runner reports, the script judges. Lists: `vacuous` (test-writer files that already pass at the base side), `outOfScope` (changed files outside `files` and the tests), `contractTouched`
  (locked files the implementer changed), and `checkpoints` with `baseExit` and `headExit`. `contractTouched` not empty gives status `contract-touched`: refused, not reviewed. A checkpoint passes when `headExit`
  equals its `exit`; `red-first` must differ at the base side, `keeps-working` must pass at both. `waiverAt` is the joined sha only with a test-writer, one `red-first` checkpoint, every checkpoint met,
  `vacuous` and `outOfScope` empty, and no `contract-dispute` from the implementer. Each failure becomes a first finding of the review.
- `build` stage 5, `auditLane` (a lane that is `landed` and was `waived`): `audit-log record --state pending` under the landed sha (the gate key), then `should-audit`; sampled out is recorded as such; otherwise a detached
  worktree at the reviewed tip T and a `review` child in audit mode on `B..T`; the result is `record --state done --confirmed N`, or `error` when the child did not finish. N above 0 gives the lane status
  `audit-findings` (landed, with the findings); an audit that could not run gives `audit-error`. While a record is `pending`, `error` or has findings with no `resolve`, `audit-log gate` fails, and so do the push hook and the sync-machines verify step.
  One exception: when `record --state pending` itself fails, the gate holds nothing for the lane, and the lane's text says to run the audit by hand.
- `land`: a suite that exits non-zero at the rebased tip returns `red` (`patchesChanged: 0`, `tidy` holds the failing tests). `build` turns `red` into an `initialFindings` entry of a delta review, and that review's fix agent repairs it before the review reads anything (a conflict is handled the same way). `build`'s `needs-review` call passes `priorFindings: []` on purpose: the lane's last review was clean, so the delta round has no finding to carry.
- `bugfix`: takes no `tier` arg (the review runner computes it); a land `red` goes to a lane fix agent, then the whole range is reviewed again, like a conflict.

## Restart (after a stop that lost the journal)

The Workflow tool resumes a run from its journal (`resumeFromRunId`, see `docs/daily-use.md`, "Resume after an exit"); `tools/wf-resume` finds the runs and
copies the journal into a new session. When the journal is gone the script is run again with the same args, so each script checks the real state first:
`land` looks a vanished branch up on the base (`git cherry`: no patch of the reviewed tip missing) and returns `landed` with the base tip and records the
close row; `build` takes `resume: true` and skips a lane whose close row STATUS.md shows landed; `review` removes the review worktree a killed run left at
the same path. A lane worktree a killed fix agent still holds (its branch checked out there) is not repaired by a script: the resume notice names the
worktrees and branches a run owns, and the lead continues that lane from them.

## Worktree protocol (why the scripts look like this)

An isolated agent cannot be relied on to run git in another agent's worktree, so: reviewers read a detached review worktree at the reviewed sha
that a runner adds and removes; a runner removes the lane worktree before each fix; the isolated fix agent then runs `git switch <branch>`
(plus `git rebase <base tip sha>` only in a run that fixes first), deletes its own throwaway branch (`worktree-...`, read with `git branch --show-current`) and reports its worktree path; join and land run as non-isolated runners.

## Rules the tests check (`tests/workflow-scripts.test.mjs`, runtime in `tests/workflow-sandbox.mjs`)

`export const meta` is a pure literal and the first statement; the statement after it is `checkArgs(args)`; phase titles used in the script are
in `meta.phases`; no `import()`; every agent call has a label starting with its row, a phase, a model and an effort; every script is named in
the `workflows` skill. Scripts cannot import, so `checkArgs` (and the writer limiter in `build.js`) are repeated per script on purpose. The tool cuts `meta` out
of the script body, so a script writes its own name where it needs it.
