# land-lane

Puts one lane on the base branch with one command: disk check, tip check, rebase check, tip-object and union-row checks, the done-check of the rebased tip, `git-tidy land`,
the STATUS.md row of the lane. Landing needs no workflow and no agent. The code checks are `done-check`'s (run, or reused when the same change was already
checked green); a risky lane needs the one review answered; the UI check plan of the rebased diff decides the UI proof, which `git-tidy land`
always runs (no waiver).

```
node ~/.claude/tools/land-lane/land-lane.mjs --repo <abs base folder> --branch <name> --tip <40-hex> --base <branch> \
  --status-file <abs STATUS.md> --close-row <row id> [--worktree <abs>] [--brief <file>] \
  [--reviewed <40-hex> | --skip-review "<reason>"] [--accept-open "<reason>"] [--json]
```

- `--tip` is the full sha the lane must be at. The branch must be there; `git-tidy land` checks it again itself (`--tip`, exit 9).
- `--worktree` is the lane's worktree, where the done-check runs. Without it the worktree that git lists for the branch is used, else a temporary
  detached one at the rebased tip (removed afterwards). The folder must be at the rebased tip with no uncommitted or untracked file, else exit 14.
- `--reviewed <sha>` says the one review of a risky lane read this sha: the `--tip` or an ancestor of it (`merge-base --is-ancestor`), else exit 2.
  `--skip-review "<reason>"` lands a risky lane without the review (1 to 200 characters, no control character). Give one or the other, not both.
- `--accept-open "<reason>"` lands a lane whose only open failure is a weakened-test item (an edited test script, a deleted test, an added skip).
  New type, lint or test failures cannot be accepted: fix them. Same reason rules.
- `--brief` is the lane's brief file: the request the UI check plan reads (the lead quotes the owner's request in it; a design word, a
  no-change request or a `UI-PLAN: <depth>` floor only raise the plan), and paths it names may add files over the size limit
  (`git-tidy land --brief`). A lane whose own diff changes the app (its plan is not none) needs it: without it, or with a brief that cannot
  be read, exit 2 before anything runs.
- `--audit-base`, `--checks` and the old UI waiver flag (any `--...waive...` flag) were removed: each exits 2 with a message saying so (an old caller is told, never ignored).
  There are no UI waivers (owner, 2026-11-23): the check plan decides what a lane must prove.

## UI check plan

`lib/ui-plan-step.mjs` computes it with `ui-proof plan --json` (rules: `home/standards/ui-checks.md`) from the rebased diff, the brief and the
lane's coverage matrix. The matrix comes from the road beside the `--status-file`: the `road-*.json` whose road id, step and lane match the
`--close-row` (`<road>.s<N>.<lane>`, an old-form `-land` row or a `fix-` row); a matrix that says `none: <reason>` is none. STATUS rule and
decision lines are no request text. Nothing a lane writes about itself feeds the plan.

- A docs page, tests or dev config only: plan none, no UI proof, no popup (a lane with no UI file at all lands with the output it had before).
- A plan with logic needs done-check `tests` ok: `none related` or `not run` is exit 4, `the change has logic: a test must run it`.
- `git-tidy land` proves the plan on its own recomputation (`ui-proof check --plan`, exit 6 with the failing states and the reason): runner or
  visual-qa records for same and render, a visual-qa PASS for visual and pixel (today's chain and today's output, word for word).
- A proved plan other than pixel prints `ui plan <depth>: proved` and its `follow-up:` lines (old problems on the base and the tip: the lead
  adds follow-up rows) and ends the row evidence with ` (ui plan <depth>: proved)`, the pointer the road gate's line 4 checks again.
- A plan that cannot be computed (the tool fails, evidence git cannot read, a road file beside the STATUS.md that cannot be read for that
  road, roads that give the lane two matrices) is exit 14. After a moved base the plan is computed again for the new rebased tip; a landing
  found again after a restart proves the plan of its landed range again, so its row keeps the pointer.
- Every value is checked first (exit 2, nothing run): shas are 40 lower-case hex, paths are absolute (`/x`, `C:\x`, `C:/x`; not `\\server\x`) with no
  control characters, branch names pass `git check-ref-format --branch` and do not start with `-`, the row id is what `status.mjs` takes.

## Steps

1. `disk-free check`: below the floor, or a check that could not run, is exit 11.
2. The branch is gone: when `git cherry <base> <tip>` shows no missing patch, `git-tidy range <tip>` finds the landing and the run goes to step 6
   (`already landed`); anything else is exit 14.
3. The branch is not at `--tip`: when `git-tidy range <tip> --landed <branch tip>` finds it on the base (a run killed after the fast-forward), the
   landing is recorded and the leftovers are pruned; else exit 9.
4. `git-tidy land --rebase-only --tip`: exit 3 conflict.
5. `lib/union-rows.mjs` on the rebased tip: the tip commit and every object the lane adds over the base are in the repository (`git cat-file -t`, then
   `git rev-list --objects --quiet --missing=allow-promisor <tip> --not <base>`: no output to hold, and an object a partial clone's promisor remote holds
   is not missing; a missing one is exit 14, `tip-objects-missing`). Each file the lane changed that is `merge=union` at the base or at the tip
   (`git check-attr --source`, so dropping the attribute does not switch the check off) is read from the tip, not a working folder, for a table row key
   (first cell, trimmed, CRLF or LF alike, indented tables too; an empty first cell is no key) that appears twice in one table. Union merge keeps both
   sides' lines, so two lanes that each add the row `dup` rebase "cleanly" into two; that is exit 12 `duplicate-rows`, the keys named (capped at 60
   characters, 5 per file; keys, file names and git's text control-free), nothing landed, the lane stays rebased. A file git cannot read is exit 14.
6. The UI check plan of the rebased tip, `done-check run --where land --base <base tip>` on the lane at the rebased tip, then `git-tidy land --tip <rebased>`. The check is reused (no command
   runs) when a green run of the same change, base and commands is in the ledger, else it runs (at most 240 s plus 30 s for the base side) and prints
   its `checks:` line. New failures or an open weakened item: exit 4 (the lane stays, rebased). A risk class (security, data, money, concurrency, gate,
   large) with no `--reviewed` or `--skip-review`: exit 10 and `review: suggested (<classes>)`. A done-check that cannot run, times out or answers
   something unreadable: exit 14. The answers (`reviewed <sha>`, `skipped`, `accepted open`) are added to the row's evidence. After a moved base the
   check runs again for the new base. `git-tidy land --tip <rebased>` lands only that sha: when the base moved after step 4, its rebase rewrites the tip and
   it exits 5 with nothing landed, so the commit landed is always the commit steps 5 and 6 checked. Its exits 3, 6, 7, 8, 9 are passed on. Exit 5 (base moved) goes back to step 4 (rebase, steps 5 and 6 on the new tip) once per new base: the same base
   twice is exit 5 here. Any other exit is 14. Two landings at once cannot both win: the fast-forward is `git merge --ff-only` at the rebased tip, so the second
   finds the base moved (exit 5 inside, then a new rebase from step 4).
7. `status.mjs done <close-row> "landed <to> on <base> from <from>"`. `--close-row` takes any row id: for a road lane it is the lane's own row
   `<road>.s<N>.<name>` (one row per lane: the landing is that row's done evidence; an old-form road names its `-land` close row instead).
   A failure is exit 13, with the line to type by hand. A row that is already done is not a failure when it holds this landing's
   `landed <to>` line (a re-run after a kill closes the row once: the restart path, `found already on <base>`, writes the same row); one
   done without it (a lane row closed when its build ended) is exit 13 naming the `<row>.landed` correction row to add with the line.
8. `git-tidy check` findings left after the landing are exit 1 and are printed.

## Exits

0 landed clean, 1 landed with findings, 2 usage, 3 conflict, 4 done-check red, 5 base kept moving, 6 ui-proof, 7 new-file-size, 8 upstream-moved,
9 tip-moved, 10 review needed, 11 disk below the floor, 12 duplicate row key in a `merge=union` file, 13 landed but row not closed, 14 a tool failed. 3-12 and 14 land nothing. The first output line is `land: <state>`;
with `--json` one object `{ state, exit, to, from, lines }`.

## Layout

`land-lane.mjs` holds the steps and the exit codes; `lib/args.mjs` reads and checks the command line; `lib/checks-step.mjs` is the done-check step
(lane folder, verdict, exits 4, 10, 14); `lib/ui-plan-step.mjs` is the UI check plan (the road matrix, the brief rule, exits 2, 14); `lib/union-rows.mjs` is the tip-object and union-row step (exit 12); `lib/stop.mjs` is the refusal; `lib/tools.mjs` runs git and the sibling tools as
subprocesses with no shell and a timeout (a tool that cannot start is `status: null`, never a pass).
Tests: `tests/land-lane.test.mjs` (real tools on temp repos), `tests/land-lane-done-check.test.mjs` (the done-check step: reuse, exit 4, exit 10), `tests/land-lane-union-rows.test.mjs` (exit 12, missing objects),
`tests/land-lane-units.test.mjs` (arguments, base-moved loop), `tests/git-tidy-land.test.mjs` (`--tip`), `tests/land-lane-ui-plan.test.mjs`
(the UI check plan: none, render with follow-ups, exit 4 for untested logic, exit 6, the brief rule, restart, the removed waiver flag).
