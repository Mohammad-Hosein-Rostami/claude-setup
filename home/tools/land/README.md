# land

Lands one lane on its base branch with one command and keeps history one straight line: it rebases the lane onto the base,
optionally tests the rebased tip, fast-forwards the base checkout to it with `git merge --ff-only`, then deletes the lane's
worktree and branch, then every other branch whose work is provably in what landed (folded into the lane, or merged), and
ends with a `left:` list of the branches still there and why. It runs no review, and it never pushes. Node 22, git, no
dependencies.

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
`package.json` has a `test` script. With neither, it refuses (after a trial rebase, so a conflict is still reported as one)
and prints the command to run with `--test`. The lane's branch moves only once the test and the checks after it passed, so
after a refusal the next `land` sees the same files and asks for the test again. A lane you rebase by hand has no overlap left
to see: land it with `--test`.

Steps, in order; nothing changes until every check has passed:

1. Checks: the base checkout has a branch checked out, no unfinished rebase or merge and no changed or untracked file; the branch
   exists and is not the base; when the branch has a worktree, that worktree is clean too and is not the main worktree.
2. Overlap: the base's sha is read once, and so is the lane's history ("Folded branches" below); the files both the base and the lane changed since their merge base (a rename counts
   as both paths) decide whether a test must run. A lane with no commit in common with the base is refused; so is a needed
   test for a branch with no worktree to run it in.
3. Rebase onto that sha: with no test, in the lane's worktree, or, for a branch with no worktree, in the base checkout (which is
   switched back to the base after). With a test, in the lane's worktree on a detached HEAD, so the branch stays where it was.
   A rebase that stops (a conflict) is aborted, so the lane is left as it was: rebase it by hand, then land again.
4. Test, when `--test` is given or files overlap (`test-gate.mjs`, `run-test.mjs`): `--test`, else the rebased `package.json`
   test script, else refused. The command runs in the lane's worktree at the rebased tip. It fails on a non-zero exit, a
   signal or the deadline. Its whole process group is ended when it ends, at the deadline and on a Ctrl-C of `land`: SIGTERM,
   then SIGKILL to what is left after 3 s (Windows: `taskkill /T /F`); a process that put itself in a group of its own is out
   of reach. A failure prints its last 40
   output lines. Refused too: a worktree or branch that moved during the test, tracked files the test changed in the worktree
   (untracked ones are allowed), and a base checkout edited or switched to another branch meanwhile. Every refusal in this
   step puts the worktree back on the unchanged branch; a pass moves the branch to the tested sha.
5. Fast-forward: `git merge --ff-only <full sha>` in the base checkout, with the sha the rebase produced, which is the sha tested.
   A base that moved since step 2 is refused; after a passing test that leaves the lane at the tested sha, and the next `land`
   compares it with the moved base.
6. Clean-up: a locked worktree is unlocked, then removed with `git worktree remove` (ignored files in it, such as notes or
   `node_modules`, go with it); the branch is deleted with `git branch -d`. Before that, right after the fast-forward, the
   landing is recorded ("Folded branches" below) with the history read in step 2, before anything moved the lane.
7. Sweep (`sweep.mjs`): git-tidy's `prune --apply` over the whole repository, with all its safety checks
   (`../git-tidy/README.md`, "prune"): branches folded into a lane that landed, merged branches, older copies, each with its
   clean worktree. A dirty, locked or recently used worktree, a branch that moved, or any doubt keeps the branch, with the
   reason. An unfinished rebase or merge in any worktree skips the sweep (`cleanup skipped: <reason>`); the record stays, so
   the next `land` or `git-tidy prune --apply` still has the proof. Then `left:` names every branch still there: `in <B>
   (lands with it)` (all its commits are in the live branch B: a stacked lane, a folded test branch), `kept: <reason>`,
   `idle <h> h, ahead <n>` (no commit for 2 hours or more) or `active, ahead <n>`; at most 20 lines, then `+N more`.

Output on success, one line per step:

```text
landed feat/x on main at <full sha> (3 commit(s))
removed worktree /path/to/lane
deleted branch feat/x
removed worktree /path/to/test-x
deleted test/x (was <full sha>, folded into feat/x)
kept /path/to/lane-y: 2 uncommitted or untracked files
kept lane/y: checked out in /path/to/lane-y
left:
  lane/y: kept: 2 uncommitted or untracked files
  lane/s: in lane/top (lands with it)
  lane/top: active, ahead 4
```

With no other branch the block is `left: none`.

## Folded branches

Work often reaches the landed lane through another branch: a `test/<topic>` branch fast-forwarded into it, a lane continued
on a test branch, a lower lane of a stack, a cherry-pick, then rewritten (fixup, autosquash, a rebase with conflicts). Its
old branch then has commits the base never got, so no ancestry or `git cherry` test proves it is done, and deleting the
landed lane deletes its reflog, the only record of the fold.

So before anything moves the lane, `land` reads its history: its tip and its reflog positions down to its newest reset
(`reset:` or `branch: Reset to`; older positions do not count, since the folded work may have been dropped on purpose
there), plus the `git patch-id --verbatim` of every commit they reach that the base lacks (none over 500 commits: ancestry
only). Right after the fast-forward it appends that record to `<git common dir>/cs-tidy-log.jsonl`. A branch is
`folded-branch` when every commit it has that the base lacks is reachable from one landing's positions, or (no merge
commit among the rest) has a patch id that landing had. Records are read for 30 days, so a branch kept today (a dirty
worktree, recent use) is still proven at the next sweep. A record that cannot be written is printed and the landing
stands: those branches then stay, as before.

A folded branch's worktree is kept when it was used in the last 60 minutes after the lane's last commit (someone may still
work there); used before that commit, it was left behind, and its recent use does not keep it. A read-only agent that touched
nothing in it since that commit is the risk that remains.

Every branch the sweep (or `git-tidy prune --apply`) deletes is appended to the same log, `{"deleted": {"branch", "sha",
"reason", "at"}}`, and printed as `deleted <b> (was <sha>...)`. Restore one with `git branch <b> <sha>` within 2 weeks: git
keeps unreachable commits that long by default (`gc.pruneExpire`). The log lives inside `.git`, never in a commit; a line that
does not parse is skipped, never taken as proof; past 1 MiB it is rewritten without the records older than 30 days.

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
worktree list and the clean checks are git-tidy's (`../git-tidy/lib/repo.mjs`), and so are the landing log
(`../git-tidy/lib/landed-log.mjs`), the fold proof (`../git-tidy/lib/folded.mjs`) and the sweep (`../git-tidy/lib/prune.mjs`); the test's process tree is ended by
`../long-run/lib/process-tree.mjs`. Files: `land.mjs` (the CLI and its steps), `sweep.mjs` (step 7: the sweep and the `left:` block),
`test-gate.mjs` (overlap, which test, the test step), `run-test.mjs` (runs the command), `refusal.mjs` (the refusal and the
clean check). Tests: `tests/land.test.mjs`, `tests/land-test-gate.test.mjs`.
