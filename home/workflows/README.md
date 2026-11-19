# Saved workflows (`home/workflows/`)

Scripts for the Workflow tool, used when the job needs one (2+ lanes in parallel, review panels across lanes, research over several sources, a multi-stage job that must survive an exit; `home/CLAUDE.md`, "Inline, agent or workflow"), so the progress view shows it and each agent's label
(`<STATUS row>:<step>`) links to a row of STATUS.md. Claude Code resolves workflow names only from a project's `.claude/workflows/`, so the
setup runs them by path: each `wf-*` skill (`home/skills/wf-*/SKILL.md`) calls `Workflow({scriptPath: "${CLAUDE_SKILL_DIR}/../../workflows/<name>.js", args})`.
`~/.claude/workflows` is a link to this folder (the install adds its link path to `permissions.additionalDirectories`, so the path is readable
from any project).

## The eight workflows

Args marked `?` are optional. Every script also accepts `scriptsDir` (this folder, for a script that runs a child). A bad args object throws
`<name>: args.<key> must be <type>` before any agent starts.

| script | skill | phases | args |
| --- | --- | --- | --- |
| `build.js` | `wf-build` | Build, Join, Review, Land, Audit | `base, repo, suite, writers, statusFile, scriptsDir, resume?, lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}, matrix?, principles?, checkpoints?, addClasses?}], appendOnly?` |
| `review.js` | `wf-review` | Tier, Review, Verify, Fix | `row, repo, base, range, landing, fix, branch, worktree, suite, tier?, addClasses?, laneClasses?, deltaOf?, initialFindings?, waiverAt?, principles?, audit?` |
| `land.js` | `wf-land` | Rebase, Suite, Land | `row, closeRow, statusFile, repo, base, branch, worktree, suite, tip` |
| `step.js` | `wf-step` | Step | `row, agentType, prompt, model, effort, isolation?, alone?, statusFile?` |
| `bugfix.js` | `wf-bugfix` | Reproduce, Hypotheses, Fix, Verify | `row, closeRow, statusFile, repo, base, symptom, repro?, suite, scriptsDir, branch?` |
| `research.js` | `wf-research` | Scope, Gather, Synthesize, Critic | `row, question, out, depth: 'simple'|'compare'|'complex'` |
| `sync-machines.js` | `wf-sync` | Verify, Sync, Doctor | `row, repo, base` |
| `git-cleanup.js` | `wf-git-cleanup` | Inventory, Plan, Apply | `row, repos` |

`build`, `review`, `land` and `step` are described below. The other four ship in the next lane (round 4, W2) with their own tests.

## How the four core scripts work

- `review` reads a lane through the lenses `review-tier` names (models and efforts exactly as it prints them) as a pipeline: a lens's blocking
  and should-fix findings go to Sonnet-high verifiers at once, confirmed ones enter the lane's serial fix queue while slower lenses still
  read, and a round ends only when every lens, verifier and judge of it has returned. A verifier's `real: false` drops a finding only when the
  verifier is at least as strong as the finder and the finding is not security; otherwise an Opus-max judge rules, and a security finding the judge
  calls not real goes to `leadList` with the reason. A finding whose lines a fix already changed becomes an open item of the next round (delta
  round, `review-tier --delta`: the lane's whole set, classes and plans, never a lighter one). In a delta round a runner writes the prior findings (fixed and open ones, one line each with its severity,
  no fixed/open claim) to a file for `--prior`; `review-tier` must count exactly that many (else `failed`), every lens gets all of them with the file's hash and returns `prior: <n> fixed, <m> open`, and the
  round is clean only when every lens has `m` 0 and `n + m` that count (else `incomplete`). `review-tier` refuses an empty delta, so a `deltaOf` run with nothing new to read is `failed`, also when it
  only carries `initialFindings` (the re-review `build` starts after a conflict or a red suite at land; open until `build` fixes first). The same file blocking in two rounds in a row calls the `deep-debugger` before the next fix.
  With `landing`, the full suite runs on each round's tip beside the reviews (`test-pass run --repo <dir> --suite`, never with the command text). Result `clean` is the only landable state.
  A runner recomputes the review set with `review-tier` every round, from the lane's worktree and with every `--add-class`; the fix agent never supplies it. A tier that did not exit 0, has no `reviews` list,
  or (landing) is empty with nothing carried over ends the run `failed`. A verifier or judge that threw ends the round `incomplete`. The result's `tip` is the reviewed sha.
- `land` first checks that the branch is at the reviewed `tip` (else `failed`, nothing lands), runs `git-tidy land --rebase-only`, then a suite PASS at the tip, then `git-tidy land`; results `landed`, `conflict`, `needs-review`, `red`, `failed`.
- `land` and `build` start with a disk check (`~/.claude/tools/disk-free`, README there): below 5 GB free (`DISK_FAIL_FREE_GB`), or a check that could not run, `land` returns `failed` and `build` marks every lane `failed` before any agent or git step, with the message that names the caches to clear. `WARN` (below 15 GB) does not stop them.
- `build` runs lanes as a pipeline (implementer and, for `acceptanceTests`, a test-writer, each in a worktree), a Join runner, the `review`
  child, then a serial land queue through the `land` child, so lane A lands while lane B is still in review. A conflict, a `red` suite or changed patches go back through `review`.
  A lane whose review is clean but whose `leadList` holds a security finding ruled not real is held (`lead-decision`), never landed. `build` is run from its script file only: its children cannot run from an inline script.
- `step` runs one agent with the given type, model and effort. A workflow spawn does not fire `agent-model-guard`, so `step` repeats its gates by shape: a UI agent needs a `MATRIX:` line, a writer needs `isolation` or `alone: true`, `statusFile` adds the standing-rules line.

## Round 5: contracts, waiver and audit

Checkpoints and a waiver replace the second full review of a lane that a contract and its tests have already proven; an Opus-max audit after the land keeps the accuracy.

- `review`: `waiverAt` is the sha `build` proved by its checkpoints. Round 0 then runs only `tier.waivable.reviews`, and only when `waiverAt` is that sha, the tier came from the runner (not `args.tier`),
  `tier.waivable.reviews` is not empty, `tier.weakened` is empty and `deltaOf` is absent. `waived` in the result is true when that round 0 ended clean. Any confirmed finding, open item or red suite makes
  round 1 a whole-range, full-set round (`deltaOf` reset). `weakened` entries (a skipped test, a loosened bound, a removed assert) are listed in every lens prompt. `principles` (`{id, question}[]`,
  ids from `home/rules/principles.md`) are added to the tier's own `principles` in every lens prompt: each is answered yes or no with `file:line`, and a no is a finding. The result's `baseSha` (merge-base
  of the last round) and `tip` are the range that was reviewed.
- `review` audit mode: `audit: {base, tip}` (recorded shas, never a branch name) needs `fix: false` and `landing: false`, else the script throws; it refuses `deltaOf`, `tier`, `waiverAt` and `initialFindings`.
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
- `land`: a suite that exits non-zero at the rebased tip returns `red` (`patchesChanged: 0`, `tidy` holds the failing tests). `build` turns `red` into an `initialFindings` entry of a delta review, and that review's fix agent repairs it (a conflict is handled the same way).
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
that a runner adds and removes; a runner removes the lane worktree before each fix; the isolated fix agent then runs `git switch <branch> &&
git rebase <base>`, deletes its own throwaway branch (`worktree-...`, read with `git branch --show-current`) and reports its worktree path; join and land run as non-isolated runners.

## Rules the tests check (`tests/workflow-scripts.test.mjs`, runtime in `tests/workflow-sandbox.mjs`)

`export const meta` is a pure literal and the first statement; the statement after it is `checkArgs(args)`; phase titles used in the script are
in `meta.phases`; no `import()`; every agent call has a label starting with its row, a phase, a model and an effort; every script has a `wf-*`
skill that names it. Scripts cannot import, so `checkArgs` (and the writer limiter in `build.js`) are repeated per script on purpose. The tool cuts `meta` out
of the script body, so a script writes its own name where it needs it.
