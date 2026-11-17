# Saved workflows (`home/workflows/`)

Scripts for the Workflow tool: every job that runs agents goes through one of them, so the progress view shows it and each agent's label
(`<STATUS row>:<step>`) links to a row of STATUS.md. Claude Code resolves workflow names only from a project's `.claude/workflows/`, so the
setup runs them by path: each `wf-*` skill (`home/skills/wf-*/SKILL.md`) calls `Workflow({scriptPath: "${CLAUDE_SKILL_DIR}/../../workflows/<name>.js", args})`.
`~/.claude/workflows` is a link to this folder (the install adds its link path to `permissions.additionalDirectories`, so the path is readable
from any project).

## The eight workflows

Args marked `?` are optional. Every script also accepts `scriptsDir` (this folder, for a script that runs a child). A bad args object throws
`<name>: args.<key> must be <type>` before any agent starts.

| script | skill | phases | args |
| --- | --- | --- | --- |
| `build.js` | `wf-build` | Build, Join, Review, Land | `base, repo, suite, writers, statusFile, scriptsDir, lanes: [{row, closeRow, branch, spec, files, acceptanceTests, implementer: {agentType?, model, effort}}]` |
| `review.js` | `wf-review` | Tier, Review, Verify, Fix | `row, repo, base, range, landing, fix, branch, worktree, suite, tier?, addClasses?, laneClasses?, deltaOf?, initialFindings?` |
| `land.js` | `wf-land` | Rebase, Suite, Land | `row, closeRow, statusFile, repo, base, branch, worktree, suite, tip` |
| `step.js` | `wf-step` | Step | `row, agentType, prompt, model, effort, isolation?, alone?, statusFile?` |
| `bugfix.js` | `wf-bugfix` | Reproduce, Hypotheses, Fix, Verify | `row, closeRow, statusFile, repo, base, symptom, repro?, suite, scriptsDir` |
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
  round, `review-tier --delta`, lane classes and plans kept). The same file blocking in two rounds in a row calls the `deep-debugger` before the next fix.
  With `landing`, the full suite runs on each round's tip beside the reviews (`test-pass run --repo <dir> --suite`, never with the command text). Result `clean` is the only landable state.
  A runner recomputes the review set with `review-tier` every round, from the lane's worktree and with every `--add-class`; the fix agent never supplies it. A tier that did not exit 0, has no `reviews` list,
  or (landing) is empty with nothing carried over ends the run `failed`. A verifier or judge that threw ends the round `incomplete`. The result's `tip` is the reviewed sha.
- `land` first checks that the branch is at the reviewed `tip` (else `failed`, nothing lands), runs `git-tidy land --rebase-only`, then a suite PASS at the tip, then `git-tidy land`; results `landed`, `conflict`, `needs-review`, `failed`.
- `build` runs lanes as a pipeline (implementer and, for `acceptanceTests`, a test-writer, each in a worktree), a Join runner, the `review`
  child, then a serial land queue through the `land` child, so lane A lands while lane B is still in review. A conflict or changed patches go back through `review`.
  A lane whose review is clean but whose `leadList` holds a security finding ruled not real is held (`lead-decision`), never landed. `build` is run from its script file only: its children cannot run from an inline script.
- `step` runs one agent with the given type, model and effort. A workflow spawn does not fire `agent-model-guard`, so `step` repeats its gates by shape: a UI agent needs a `MATRIX:` line, a writer needs `isolation` or `alone: true`, `statusFile` adds the standing-rules line.

## Worktree protocol (why the scripts look like this)

An isolated agent cannot be relied on to run git in another agent's worktree, so: reviewers read a detached review worktree at the reviewed sha
that a runner adds and removes; a runner removes the lane worktree before each fix; the isolated fix agent then runs `git switch <branch> &&
git rebase <base>`, deletes its own throwaway branch (`worktree-...`, read with `git branch --show-current`) and reports its worktree path; join and land run as non-isolated runners.

## Rules the tests check (`tests/workflow-scripts.test.mjs`, runtime in `tests/workflow-sandbox.mjs`)

`export const meta` is a pure literal and the first statement; the statement after it is `checkArgs(args)`; phase titles used in the script are
in `meta.phases`; no `import()`; every agent call has a label starting with its row, a phase, a model and an effort; every script has a `wf-*`
skill that names it. Scripts cannot import, so `checkArgs` (and the writer limiter in `build.js`) are repeated per script on purpose. The tool cuts `meta` out
of the script body, so a script writes its own name where it needs it.
