# land

Lands one lane on its base branch with one command and keeps history one straight line: it rebases the lane onto the base,
optionally tests the rebased tip, fast-forwards the base checkout to it with `git merge --ff-only`, then deletes the lane's
worktree and branch. It runs no review, and it never pushes. Node 22, git, no dependencies.

```sh
node ~/.claude/tools/land/land.mjs <branch> [--repo <path>] [--test <command>] [--test-timeout <seconds>]
```

`--repo` is the base checkout: the folder where the base branch is checked out (default: the current folder). The base is the
branch checked out there, so `land feat/x --repo ~/code/app` lands `feat/x` on whatever `~/code/app` has checked out.

`--test` runs the command (through the shell, in the lane's worktree, at the rebased tip) before the base moves, for example
`land lane/x --repo ~/code/app --test "node --test tests/*.test.mjs"`. `--test-timeout` is its deadline in seconds (default
1800, 30 minutes; at most 2147483, about 24 days, the longest a Node timer holds).

When the base and the lane both changed the same files since the lane branched, a rebase without a conflict can still combine
into broken code, so `land` prints those files and requires a test before it lands: `--test`, else `npm test` when the lane's
`package.json` has a `test` script. With neither, it refuses before anything changes and prints the command to run with
`--test`. The lane's branch moves only once the test passed, so after any refusal the next `land` sees the same files and
asks for the test again. A lane you rebase by hand has no overlap left to see: land it with `--test`.

Steps, in order; nothing changes until every check has passed:

1. Checks: the base checkout has a branch checked out, no unfinished rebase or merge and no changed or untracked file; the branch
   exists and is not the base; when the branch has a worktree, that worktree is clean too and is not the main worktree.
2. Overlap and test: the base's sha is read once; the files both the base and the lane changed since their merge base (a rename
   counts as both paths) decide whether a test must run. A lane with no commit in common with the base, or a needed test with
   no command or no lane worktree to run in, is refused here.
3. Rebase onto that sha: with no test, in the lane's worktree, or, for a branch with no worktree, in the base checkout (which is
   switched back to the base after). With a test, in the lane's worktree on a detached HEAD, so the branch stays where it was.
   A rebase that stops (a conflict) is aborted, so the lane is left as it was: rebase it by hand, then land again.
4. Test, when `--test` is given or files overlap: the command runs in the lane's worktree at the rebased tip (`test-gate.mjs`,
   `run-test.mjs`). It fails on a non-zero exit, a signal or the deadline. Its whole process group is killed when it ends, at
   the deadline and on a Ctrl-C of `land` (Windows: `taskkill /T`), so nothing it started in the background outlives it. A
   failure prints its last 40 output lines. Refused too: a worktree or branch that moved during the test, and a base checkout
   edited or switched to another branch meanwhile. On any refusal the worktree goes back to the unchanged branch; only a pass
   moves the branch to the tested sha.
5. Fast-forward: `git merge --ff-only <full sha>` in the base checkout, with the sha the rebase produced, which is the sha tested;
   a base that moved since step 2 is refused.
6. Clean-up: a locked worktree is unlocked, then removed with `git worktree remove` (ignored files in it, such as notes or
   `node_modules`, go with it); the branch is deleted with `git branch -d`.

Output on success, one line per step:

```text
landed feat/x on main at <full sha> (3 commit(s))
removed worktree /path/to/lane
deleted branch feat/x
```

With a test, these lines come first (the overlap lines only when files overlap):

```text
main and feat/x both changed 2 file(s) since feat/x branched:
  src/a.mjs
  src/b.mjs
testing <full sha> in /path/to/lane: npm test
test passed on <full sha>
```

| Exit | Meaning |
| ---- | ------- |
| 0 | landed and cleaned up |
| 1 | refused or stopped; the `land:` line says why and what to do (a dirty checkout, an unknown branch, a rebase conflict, overlapping files with no test, a failed or timed-out test, a lane, worktree or base that moved meanwhile, a clean-up step that failed after landing) |
| 2 | usage error |

Git runs without a shell and without the variables that point it at another repository (`../git-tidy/lib/git.mjs`); the
worktree list and the clean checks are git-tidy's (`../git-tidy/lib/repo.mjs`). Files: `land.mjs` (the CLI and its steps),
`test-gate.mjs` (overlap, which test, the test step), `run-test.mjs` (runs the command), `refusal.mjs` (the refusal and the
clean check). Tests: `tests/land.test.mjs`, `tests/land-test-gate.test.mjs`.
