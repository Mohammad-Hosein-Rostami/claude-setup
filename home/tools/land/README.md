# land

Lands one lane on its base branch with one command and keeps history one straight line: it rebases the lane onto the base,
fast-forwards the base checkout to the rebased tip with `git merge --ff-only`, then deletes the lane's worktree and branch.
It runs no tests and no review, so run those before landing, and it never pushes. Node 22, git, no dependencies.

```sh
node ~/.claude/tools/land/land.mjs <branch> [--repo <path>]
```

`--repo` is the base checkout: the folder where the base branch is checked out (default: the current folder). The base is the
branch checked out there, so `land feat/x --repo ~/code/app` lands `feat/x` on whatever `~/code/app` has checked out.

Steps, in order; nothing changes until every check has passed:

1. Checks: the base checkout has a branch checked out, no unfinished rebase or merge and no changed or untracked file; the branch
   exists and is not the base; when the branch has a worktree, that worktree is clean too and is not the main worktree.
2. Rebase: in the lane's worktree, or, for a branch with no worktree, in the base checkout (which is switched back to the base
   after). A rebase that stops (a conflict) is aborted, so the lane is left as it was: rebase it by hand, then land again.
3. Fast-forward: `git merge --ff-only <full sha>` in the base checkout, with the sha the rebase produced.
4. Clean-up: a locked worktree is unlocked, then removed with `git worktree remove` (ignored files in it, such as notes or
   `node_modules`, go with it); the branch is deleted with `git branch -d`.

Output on success, one line per step:

```text
landed feat/x on main at <full sha> (3 commit(s))
removed worktree /path/to/lane
deleted branch feat/x
```

| Exit | Meaning |
| ---- | ------- |
| 0 | landed and cleaned up |
| 1 | refused or stopped; the `land:` line says why and what to do (a dirty checkout, an unknown branch, a rebase conflict, a base that moved meanwhile, a clean-up step that failed after landing) |
| 2 | usage error |

Git runs without a shell and without the variables that point it at another repository (`../git-tidy/lib/git.mjs`); the
worktree list and the clean checks are git-tidy's (`../git-tidy/lib/repo.mjs`). Tests: `tests/land.test.mjs`.
