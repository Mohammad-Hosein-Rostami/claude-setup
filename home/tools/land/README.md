# land

Lands one lane on its base branch by rebase and fast-forward, then deletes the lane and every other branch already on the base.

Lands one lane on its base branch with one command and keeps history one straight line: it rebases the lane onto the base,
optionally tests the rebased tip, fast-forwards the base checkout to it with `git merge --ff-only` and writes one line to the
land ledger (below), then clears the lane's folder away (a pool folder from `git-tidy lane claim` stays for the next lane, any
other worktree is removed) and deletes its branch, then every other branch whose content is all on the base (one content
proof, below), and ends with a `left:` list of the branches still there and why. It runs no review, and it never pushes.
Node 22, git, no dependencies. It replaces `land-lane` (plan 2026-11-24).

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
2. Rebase onto the base's sha, read once, with `--reapply-cherry-picks`: a commit is dropped only when its change is already
   on the base (git's default also drops one whose patch id pairs with a base commit while its change differs). A lane with no
   commit in common with the base is refused. With no test, in the
   lane's worktree, or, for a branch with no worktree, in the base checkout (which is switched back to the base after). With a
   test, in the lane's worktree on a detached HEAD, so the branch stays where it was.
   A rebase that stops (a conflict) is aborted, so the lane is left as it was: rebase it by hand, then land again.
3. Test, only when `--test` is given (`test-gate.mjs`, `run-test.mjs`); a branch with no worktree to run it in is refused,
   and the refusal gives the step that makes one: `node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <dir>
   --branch <branch> --base <its tip sha>` (a pool folder, kept for the next lane once it lands), then land again. The command runs in the lane's worktree at the rebased tip. It fails on a non-zero exit, a
   signal or the deadline. Its whole process group is ended when it ends, at the deadline and on a Ctrl-C of `land`: SIGTERM,
   then SIGKILL to what is left after 3 s, or at once on a second Ctrl-C (Windows: `taskkill /T /F`); a process that put itself in a group of its own is out
   of reach. A failure prints its last 40
   output lines and leaves the base and the lane as they were. Refused too: a worktree or branch that moved during the test, tracked files the test changed in the worktree
   (untracked ones are allowed), and a base checkout edited or switched to another branch meanwhile. Every refusal in this
   step puts the worktree back on the unchanged branch; a pass moves the branch to the tested sha.
4. Fast-forward: `git merge --ff-only <full sha>` in the base checkout, with the sha the rebase produced (with a test, the sha tested).
   A base that moved since step 2 is refused; after a passing test that leaves the lane at the tested sha. Then one line goes
   to the land ledger ("Land ledger" below).
5. Clean-up of the lane's folder, then its branch:
   - A pool folder (`<main worktree>/.claude/worktrees/lane-<n>`, handed out by `git-tidy lane claim` and locked with
     `cs-lane-pool <branch>`) is not removed: git-tidy's `detachLandedSlot` (`../git-tidy/lib/lane-pool.mjs`) detaches it at
     the landed sha and unlocks it, so `git-tidy lane list` shows it `free` (`busy` while untracked files a `--test` run left
     are there) and the next claim reuses it with its caches warm (`lane folder <path> detached at <sha> (kept for the next
     lane)`). Its ignored files (`node_modules`, a local `.env`) stay; the next claim cleans them, and `git-tidy lane reclaim`
     removes idle folders (`../git-tidy/README.md`, "lane"). The detach reads the worktrees under the pool lock, so no
     claim or release can change the folder between that read and the switch. A pool folder that cannot be freed (its HEAD
     is not the landed sha, it has tracked changes, or git fails) is never removed or unlocked: it is kept, locked, the
     landing stands, and land exits 1 with
     `land: <branch> landed on <base> at <sha>; lane folder <path> not freed: <why>; deal with that, then free it with: node ~/.claude/tools/git-tidy/git-tidy.mjs lane release --repo <repo> --folder <path>`.
     Running `land <branch>` again once the cause is gone also frees it. A pool lock that stays busy for 60 s stops the
     clean-up with nothing touched, also exit 1 (`... but the clean-up stopped: <why>; deal with that, then run land <branch> again`).
   - Any other worktree that holds the branch (read under the same lock) is unlocked when locked, then removed with `git worktree remove` (ignored files in it, such as notes
     or `node_modules`, go with it). A git repository inside an ignored folder of that worktree stops the clean-up first (the
     landing stands, exit 1): its commits may be the only copy. The message names the repository; move it out of the
     worktree, then run `land <branch>` again, which finishes the clean-up.
   - Then the branch is deleted with `git branch -d`. A branch already deleted (a `lane release` ran during the land) prints
     `branch <branch> already deleted`.
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

With no other branch the block is `left: none`. A lane in a pool folder prints
`lane folder /path/to/.claude/worktrees/lane-1 detached at <full sha> (kept for the next lane)` in place of its
`removed worktree` line.

## Land ledger

Each landing appends one JSON line, right after the fast-forward, to `~/.claude/state/land/<repo-key>.jsonl` (`~` is the
`HOME` land runs with), so a tool such as `board tick` can tell what landed without asking an agent. A base that moved
always gets its line. A base that did not move gets none when the ledger already has a line for the branch at a sha the
base holds: that is a re-run of `land` after a clean-up stop, also when other lanes moved the base in between. Otherwise (a
lane with no new commit) it gets a line with `"commits":0`, so a reader sees the lane as landed.

```json
{"at":"2026-11-25T10:00:00.000Z","repo":"/path/to/app","branch":"lane/x","from":"<40-hex>","to":"<40-hex>","commits":3}
```

`at` is the time of the landing, `repo` the base checkout, `from` the base's sha before the fast-forward, `to` the landed sha
(the base's new tip) and `commits` how many commits landed. `<repo-key>` is the first 16 hex of the sha256 of the real path
of the repository's git common dir (`git rev-parse --path-format=absolute --git-common-dir`), so every worktree of one
repository writes the same file, whatever link or letter case its path came through. `ledger.mjs` holds the format: land
writes with `appendLandEntry`, a reader uses `readLandEntries` (it skips and counts lines that do not parse or lack a field)
and `landLedgerPath`.

A line that cannot be written (a link, FIFO or folder at the path, a file that would pass its 32 MB cap, a disk error)
never fails the landing: land prints one `land: the ledger line of <branch> was not written (<why>) ...` line on stderr and
goes on (exit 0). A ledger that cannot be checked for an earlier line prints `land: the ledger could not be checked (<why>);
...` and the line is written. `git-tidy range <to sha>` finds that landing's range again from the base's reflog. The ledger is a plain
state file: move it away or delete it to start again.

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
| 1 | refused or stopped; the `land:` line says why and what to do (a dirty checkout, an unknown branch, a rebase conflict, a failed or timed-out test, a lane, worktree or base that moved meanwhile, a clean-up step that failed after landing, a pool folder kept locked) |
| 2 | usage error |

Git runs without a shell and without the variables that point it at another repository (`../git-tidy/lib/git.mjs`); the
worktree list and the clean checks are git-tidy's (`../git-tidy/lib/repo.mjs`), and so are the content proof
(`../git-tidy/lib/branches.mjs`), the deletion log (`../git-tidy/lib/deletion-log.mjs`), the `in <B>` hint
(`../git-tidy/lib/in-lane.mjs`) and the sweep (`../git-tidy/lib/prune.mjs`); the test's process tree is ended by
`../long-run/lib/process-tree.mjs`; the pool folder detach is git-tidy's (`../git-tidy/lib/lane-pool.mjs`). Files: `land.mjs`
(the CLI and its steps), `ledger.mjs` (the land ledger), `sweep.mjs` (step 6: the sweep and the `left:` block),
`test-gate.mjs` (the test step), `run-test.mjs` (runs the command), `refusal.mjs` (the refusal and the
clean check). Tests: `tests/land.test.mjs`, `tests/land-test-gate.test.mjs`, `tests/land-sweep*.test.mjs` (`land-sweep-strict` for the one rule), `tests/git-tidy-content-equal.test.mjs`.
