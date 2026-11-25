# land

Lands one lane on its base branch with one command and keeps history one straight line: it rebases the lane onto the base,
optionally tests the rebased tip, fast-forwards the base checkout to it with `git merge --ff-only`, then deletes the lane's
worktree and branch, then every other branch whose content is all on the base (one content proof, below), and
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

With no `--test`, `land` always rebases and lands, also when the base and the lane changed the same files. When both sides
changed the same files, run the full suite on the rebased tip (`land --test`) before landing: a rebase without a conflict
can still combine into broken code.

Steps, in order; nothing changes until every check has passed:

1. Checks: the base checkout has a branch checked out, no unfinished rebase or merge, no changed or untracked file and no file
   marked assume-unchanged, or skip-worktree and on disk (git status does not show edits there; a clean sparse checkout
   passes); the branch exists and is not the base; when
   the branch has a worktree, that worktree is clean in the same way and is not the main worktree.
2. Rebase onto the base's sha, read once; a lane with no commit in common with the base is refused. With no test, in the
   lane's worktree, or, for a branch with no worktree, in the base checkout (which is switched back to the base after). With a
   test, in the lane's worktree on a detached HEAD, so the branch stays where it was.
   A rebase that stops (a conflict) is aborted, so the lane is left as it was: rebase it by hand, then land again.
3. Test, only when `--test` is given (`test-gate.mjs`, `run-test.mjs`); a branch with no worktree to run it in is refused.
   The command runs in the lane's worktree at the rebased tip. It fails on a non-zero exit, a
   signal or the deadline. Its whole process group is ended when it ends, at the deadline and on a Ctrl-C of `land`: SIGTERM,
   then SIGKILL to what is left after 3 s (Windows: `taskkill /T /F`); a process that put itself in a group of its own is out
   of reach. A failure prints its last 40
   output lines. Refused too: a worktree or branch that moved during the test, tracked files the test changed in the worktree
   (untracked ones are allowed), and a base checkout edited or switched to another branch meanwhile. Every refusal in this
   step puts the worktree back on the unchanged branch; a pass moves the branch to the tested sha.
4. Fast-forward: `git merge --ff-only <full sha>` in the base checkout, with the sha the rebase produced (with a test, the sha tested).
   A base that moved since step 2 is refused; after a passing test that leaves the lane at the tested sha.
5. Clean-up: a locked worktree is unlocked, then removed with `git worktree remove` (ignored files in it, such as notes or
   `node_modules`, go with it); the branch is deleted with `git branch -d`. A git repository inside an ignored folder of the
   worktree stops the clean-up first (the landing stands, exit 1): its commits may be the only copy. The message names the
   repository; move it out of the worktree, then run `land <branch>` again, which finishes the clean-up.
6. Sweep (`sweep.mjs`): git-tidy's `prune --apply` over the whole repository, with all its safety checks
   (`../git-tidy/README.md`, "prune"), held to the one rule: only branches whose content is on the base go ("Folded
   branches" below), each with its clean worktree. Older copies and agent leftover branches whose work is on another branch,
   not on the base, are kept (`its work is in <B>, not all on <base>`); the standalone `git-tidy prune --apply` still removes
   them. A dirty, locked or recently used worktree (an assume-unchanged file, a skip-worktree file on disk or a git repository
   inside an ignored folder counts as dirty), a branch
   that moved, or any doubt keeps the branch, with the reason. The sweep compares with one base commit; a base that moves
   meanwhile stops it, and the rest is kept (`<base> moved during the clean-up ...; stopped, nothing more removed`). A git
   older than 2.40 (no `git merge-tree --stdin`) skips the sweep with one stderr line; the landing stands, exit 0. An unfinished rebase or merge in any worktree skips the sweep (`cleanup skipped: <reason>`); a later
   `land` or `git-tidy prune --apply` does it. A deletion log that is not safe to write stops the sweep before it removes
   anything: one stderr line, exit 0. Then `left:` names every branch still there: `in <B> (lands with it)` (all its commits
   are in the live branch B: a stacked lane, a folded test branch), `kept: <reason>`, `on <base> (<state>), not removed`
   (merged, but the sweep was skipped), `idle <h> h, ahead <n>` (no commit for 2 hours or more) or `active, ahead <n>`, then
   each stale worktree entry (`<path> (stale worktree entry): kept: <reason>`): the sweep never removes one, since its folder
   may only have moved; `git-tidy prune --apply` removes it once nothing is lost. At most 20 lines, then `+N more`.

Output on success, one line per step:

```text
landed feat/x on main at <full sha> (3 commit(s))
removed worktree /path/to/lane
deleted branch feat/x
removed worktree /path/to/test-x
deleted test/x (was <full sha>)
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
on a test branch, a lower lane of a stack, a cherry-pick, often rewritten on the way (fixup, autosquash, squash, rebase). Its
old branch then has commits the base never got, so no ancestry or `git cherry` test proves it is done.

One content proof decides (decision record `docs/adr/0004-land-removes-folded-branches.md`): a branch is deleted only when
its tip is an ancestor of the base, or `git merge-tree --write-tree <base> <branch>` prints exactly the base's tree, so
merging it would change nothing and all its content is already on the base (`content-equal`). Because a merge runs merge
drivers and attributes (`merge=ours`, `merge=union`) that can drop the branch's change, a blob check that merges nothing must
hold too: every path the branch changed since its merge base is the same blob on the base as on its tip. A fold that landed as it is,
in other commits (a squash, a plain cherry-pick), goes. A fold the lane changed later (the folded commit fixed up or
amended, a file removed again, a commit dropped by `rebase --onto`) stays and is named under `left:`: look at it, then
delete it by hand with `git branch -D`. Reflogs and patch ids never delete a branch on their own.

Every branch the sweep (or `git-tidy prune --apply`) deletes is first appended to `<git common dir>/cs-tidy-log.jsonl`,
`{"deleted": {"branch", "sha", "reason", "at"}}`, and printed as `deleted <b> (was <sha>)`; a branch whose record cannot be
written is kept. Restore one with `git branch <b> <sha>` within 2 weeks: git keeps unreachable commits that long by default
(`gc.pruneExpire`). The log lives inside `.git`, never in a commit, and is opened only as a regular file: a symbolic link,
a FIFO, a folder or a file that cannot be written in its place stops the sweep (stderr, exit 0; move it away). A record after
a torn last line starts a line of its own.

With a test, these lines come first:

```text
testing <full sha> in /path/to/lane: npm test
test passed on <full sha>
```

| Exit | Meaning |
| ---- | ------- |
| 0 | landed and cleaned up |
| 1 | refused or stopped; the `land:` line says why and what to do (a dirty checkout, an unknown branch, a rebase conflict, a failed or timed-out test, a lane, worktree or base that moved meanwhile, a clean-up step that failed after landing) |
| 2 | usage error |

Git runs without a shell and without the variables that point it at another repository (`../git-tidy/lib/git.mjs`); the
worktree list and the clean checks are git-tidy's (`../git-tidy/lib/repo.mjs`), and so are the content proof
(`../git-tidy/lib/branches.mjs`), the deletion log (`../git-tidy/lib/deletion-log.mjs`), the `in <B>` hint
(`../git-tidy/lib/in-lane.mjs`) and the sweep (`../git-tidy/lib/prune.mjs`); the test's process tree is ended by
`../long-run/lib/process-tree.mjs`. Files: `land.mjs` (the CLI and its steps), `sweep.mjs` (step 6: the sweep and the `left:` block),
`test-gate.mjs` (the test step), `run-test.mjs` (runs the command), `refusal.mjs` (the refusal and the
clean check). Tests: `tests/land.test.mjs`, `tests/land-test-gate.test.mjs`, `tests/land-sweep*.test.mjs` (`land-sweep-strict` for the one rule), `tests/git-tidy-content-equal.test.mjs`.
