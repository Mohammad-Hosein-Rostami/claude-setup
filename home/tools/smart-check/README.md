# smart-check

The one check category that is on by default (`smart` in `home/checks/categories.json`). The owner's words (2026-11-21): "very
selective ... very low token usage and no time wasting ... makes sure we have a perfect resault ... in time we improve this smart check
based on our expirience and evidences". Spec: round 9 `spec-smart-check.md`; the rule table is round 2 of its research, section 8.3.

## How it runs

- Per edit (milliseconds): `home/hooks/post-edit.mjs` and `home/hooks/bash-writes.mjs` append each edited file to the session's smart
  edit log (`<temp>/claude-post-edit/smart-edits/<session>--<agent>`).
- At Stop and SubagentStop: `home/hooks/smart-check.mjs` keeps the logged files whose content changed since its last check, and per git
  work tree runs `run.mjs` on them. Outside git, with nothing changed, or with `/check off smart`: it passes at once. A FAIL blocks the
  stop once (exit 2, the report on stderr); a PASS is shown to the owner under the reply. Its own error is a guard-log line and a pass.

## The plan (`plan.mjs`)

One cheap pass over `git diff <lane base>` (commits since the base, uncommitted edits, untracked files):

- facts: review-tier's classes per file, diff stats, export and import changes, CSS facts (layout or paint properties, media queries,
  tokens or theme, RTL, scope: global, shared with 3+ importers, local), global triggers (lockfile, root or tool config, tsconfig,
  TS or `@types` versions, a global `.d.ts`, env files), the job kind;
- per check kind (`types`, `lint`, `build`, `tests`, `review`, `visual`, `security`, `probes`) a level `none`, `scoped` or `full` and one
  reason; the first matching rule wins (`lib/rules.mjs`); `review` full is the deep review-tier set (risky class, gate code, 4+
  directories or 20+ files, a past catch in a touched file within 90 days); `visual` scoped is a crop at 3 widths, full is the width x
  state matrix, or `visual-qa` once per lane in a Figma job;
- a kind whose category the owner turned on with `/check` is `full` by `owner`: its own gate runs it, the smart check does not again;
- then the learning step, which only raises: a trained model (after 200 labelled changes per kind), a kind whose miss-rate bound is over
  1% after 100 audited changes, and 20% exploration (one kind one level up); a file kind the rules do not know gets one Haiku label
  (`lib/label.mjs`), which only adds.

`node plan.mjs [--cwd <dir>] [--base <ref>] [--job <kind>] [--paths a,b] [--json] [--no-label]` prints the plan and runs nothing.

## The run (`run.mjs`)

Pinned checks first, on every change, never sampled (`lib/pinned.mjs`, `lib/pinned-code.mjs`): parse (`node --check`, JSON, `bash -n`),
relative imports and named exports resolve, new packages are declared (else looked up in the registry by name), the never-weaken scan
(report only), literal secrets on added lines, conflict markers and stubs, size caps (C3, C4, the session-start caps of this repo),
files vs the brief's list (report only), changed hook files load. Then each kind at its level, cheapest first, inside one deadline
(300 s by default; the hook gives at most 540 s): the project's typecheck script or an incremental tsc of the nearest tsconfig, eslint
on changed files kept to added lines, affected tests (`scripts/affected-tests.mjs` through `test-pass`, `vitest related`,
`jest --findRelatedTests`), the build script, `ui-check responsive` at 3 widths or the matrix (needs `SMART_CHECK_UI_URL`), hook
probes with an empty input, the cheap Haiku lens on a diff of at most 150 lines (`lib/lens.mjs`). The deep review and `visual-qa`
are handed to the lead: only the lead starts agents.

The report (`lib/report.mjs`), one line each: `checked: ...` / `not checked: <kind (reason)>` / `suggest: /check <cat>` (only when
a skipped heavy check matters), then at most 15 finding lines and the hand-overs.

## The ledger (`ledger.mjs`)

`~/.claude/state/smart-check/ledger.jsonl` (`SMART_CHECK_STATE` moves the folder): one row per check run (paths, kinds, diff stats,
kind, level, who picked it, reason, result, seconds, tokens) and truth rows that label a change later: `truth` (a catch, a false alarm,
an escape), `defect` (an owner defect from `status.mjs defect`: an escape of the change that touched the file), and the background
run of skipped levels (`smart-check.mjs background`, run when idle with `run_in_background`). `smart-check.mjs stats` prints the miss
rate per kind and overall with its 95% (Wilson) bound against the target of 1%; doctor prints the summary line. `smart-check.mjs
train` is the weekly retrain (`lib/model.mjs`, a logistic regression per kind with printed coefficients).

Never lowered by any learning: the pinned checks and security. A kind under 90% precision over 20 findings is report only.
