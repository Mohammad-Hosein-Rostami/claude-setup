# land-lane

Puts one lane on the base branch with one command: disk check, tip check, rebase check, the done-check of the rebased tip, `git-tidy land`,
STATUS.md close row. Landing needs no workflow and no agent. The code checks are `done-check`'s (run, or reused when the same change was already
checked green); a risky lane needs the one review answered; the UI proof of `git-tidy land` is always on.

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
- `--brief` is the lane's brief file: paths it names may add files over the size limit (`git-tidy land --brief`).
- `--audit-base` and `--checks` were removed: either one exits 2 with a message saying so (an old caller is told, never ignored).
- Every value is checked first (exit 2, nothing run): shas are 40 lower-case hex, paths are absolute (`/x`, `C:\x`, `C:/x`; not `\\server\x`) with no
  control characters, branch names pass `git check-ref-format --branch` and do not start with `-`, the row id is what `status.mjs` takes.

## Steps

1. `disk-free check`: below the floor, or a check that could not run, is exit 11.
2. The branch is gone: when `git cherry <base> <tip>` shows no missing patch, `git-tidy range <tip>` finds the landing and the run goes to step 6
   (`already landed`); anything else is exit 14.
3. The branch is not at `--tip`: when `git-tidy range <tip> --landed <branch tip>` finds it on the base (a run killed after the fast-forward), the
   landing is recorded and the leftovers are pruned; else exit 9.
4. `git-tidy land --rebase-only --tip`: exit 3 conflict.
5. `done-check run --where land --base <base tip>` on the lane at the rebased tip, then `git-tidy land --tip <rebased>`. The check is reused (no command
   runs) when a green run of the same change, base and commands is in the ledger, else it runs (at most 240 s plus 30 s for the base side) and prints
   its `checks:` line. New failures or an open weakened item: exit 4 (the lane stays, rebased). A risk class (security, data, money, concurrency, gate,
   large) with no `--reviewed` or `--skip-review`: exit 10 and `review: suggested (<classes>)`. A done-check that cannot run, times out or answers
   something unreadable: exit 14. The answers (`reviewed <sha>`, `skipped`, `accepted open`) are added to the close row's evidence. After a moved base the
   check runs again for the new base. `git-tidy land --tip <rebased>`; its exits 3, 6, 7, 8, 9 are passed on. Exit 5 (base moved) goes back to step 4 once per new base: the same base
   twice is exit 5 here. Any other exit is 14. Two landings at once cannot both win: the fast-forward is `git merge --ff-only` at the rebased tip, so the second
   finds the base moved (exit 5 inside, then a new rebase from step 4).
6. `status.mjs done <close-row> "landed <to> on <base> from <from>"`. A failure is exit 13, with the line to type by hand; a row that is already done
   is not a failure (a re-run after a kill closes the row once).
7. `git-tidy check` findings left after the landing are exit 1 and are printed.

## Exits

0 landed clean, 1 landed with findings, 2 usage, 3 conflict, 4 done-check red, 5 base kept moving, 6 ui-proof, 7 new-file-size, 8 upstream-moved,
9 tip-moved, 10 review needed, 11 disk below the floor, 13 landed but row not closed, 14 a tool failed. 3-11 and 14 land nothing. The first output line is `land: <state>`;
with `--json` one object `{ state, exit, to, from, lines }`.

## Layout

`land-lane.mjs` holds the steps and the exit codes; `lib/args.mjs` reads and checks the command line; `lib/checks-step.mjs` is the done-check step
(lane folder, verdict, exits 4, 10, 14); `lib/stop.mjs` is the refusal; `lib/tools.mjs` runs git and the sibling tools as
subprocesses with no shell and a timeout (a tool that cannot start is `status: null`, never a pass).
Tests: `tests/land-lane.test.mjs` (real tools on temp repos), `tests/land-lane-done-check.test.mjs` (the done-check step: reuse, exit 4, exit 10),
`tests/land-lane-units.test.mjs` (arguments, base-moved loop), `tests/git-tidy-land.test.mjs` (`--tip`).
