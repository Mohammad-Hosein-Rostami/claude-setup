# land-lane

Puts one reviewed lane on the base branch with one command. It does what the `land` workflow did (disk check, tip check, rebase check, suite,
`git-tidy land`, pending audit record, STATUS.md close row), so landing needs no workflow and no agent.

```
node ~/.claude/tools/land-lane/land-lane.mjs --repo <abs base folder> --branch <name> --tip <40-hex> --base <branch> \
  --status-file <abs STATUS.md> --close-row <row id> [--worktree <abs>] [--brief <file>] [--audit-base <40-hex>] [--checks <cat,...>] [--json]
```

- `--tip` is the full sha the review cleared. The branch must be there; `git-tidy land` checks it again itself (`--tip`, exit 9).
- `--worktree` is the lane's worktree: the suite runs there when its HEAD is the rebased tip and `git status --porcelain` is empty, else in a
  detached temporary worktree at the tip that is always removed.
- `--brief` is the lane's brief file: paths it names may add files over the size limit (`git-tidy land --brief`).
- `--audit-base` is the sha the reviewed range starts at; with it the landed sha is recorded as a pending audit (`review-tier/audit-log.mjs record`).
- `--checks` names `/check` categories the owner turned on; it only adds to what `hooks/lib/checks-on.mjs` says. `test` runs the suite,
  `review` stops a rebase that changed patches, `ui` asks for the UI proof (the on categories are passed to `git-tidy land`).
- Every value is checked first (exit 2, nothing run): shas are 40 lower-case hex, paths are absolute (`/x`, `C:\x`, `C:/x`; not `\\server\x`) with no
  control characters, branch names pass `git check-ref-format --branch` and do not start with `-`, the row id is what `status.mjs` takes.

## Steps

1. `disk-free check`: below the floor, or a check that could not run, is exit 11.
2. The branch is gone: when `git cherry <base> <tip>` shows no missing patch, `git-tidy range <tip>` finds the landing and the run goes to step 7
   (`already landed`); anything else is exit 14.
3. The branch is not at `--tip`: when `git-tidy range <tip> --landed <branch tip>` finds it on the base (a run killed after the fast-forward), the
   landing is recorded and the leftovers are pruned; else exit 9.
4. `git-tidy land --rebase-only --tip`: exit 3 conflict. A rebase that changed patches with `review` on is exit 10 and prints
   `rebased <sha>: review the delta (review-tier --delta <tip> --base <new base>)`.
5. With `test` on: `test-pass check <rebased> --suite` reuses a PASS; else `test-pass run --suite` runs, and the PASS is checked again after the run.
   Red is exit 4: each failing test with its first error line, and the log path (a log kept in the temp folder).
6. `git-tidy land --tip <rebased>`; its exits 3, 4, 6, 7, 8, 9 are passed on. Exit 5 (base moved) goes back to step 4 once per new base: the same base
   twice is exit 5 here. Any other exit is 14.
7. With `--audit-base`: `audit-log record --state pending`. A failure goes on to step 8 and ends as exit 12 (`audit not recorded: gate holds nothing`).
8. `status.mjs done <close-row> "landed <to> on <base> from <from>"`. A failure is exit 13, with the line to type by hand; a row that is already done
   is not a failure (a re-run after a kill closes the row once).
9. `git-tidy check` findings left after the landing are exit 1 and are printed.

## Exits

0 landed clean, 1 landed with findings, 2 usage, 3 conflict, 4 suite red or no PASS, 5 base kept moving, 6 ui-proof, 7 new-file-size,
8 upstream-moved, 9 tip-moved, 10 needs-review, 11 disk below the floor, 12 landed but audit not recorded, 13 landed but row not closed, 14 a tool
failed. 3-11 and 14 land nothing. With both 12 and 13 the exit is 12. The first output line is `land: <state>`; with `--json` one object
`{ state, exit, to, from, lines }`.

## Layout

`land-lane.mjs` holds the steps and the exit codes; `lib/args.mjs` reads and checks the command line; `lib/tools.mjs` runs git and the sibling tools as
subprocesses with no shell and a timeout (a tool that cannot start is `status: null`, never a pass); `lib/suite-step.mjs` is step 5.
Tests: `tests/land-lane.test.mjs` (real tools on temp repos), `tests/land-lane-units.test.mjs` (arguments, base-moved loop), `tests/git-tidy-land.test.mjs`
(`--tip`).
