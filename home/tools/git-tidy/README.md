# git-tidy

Checks that a repository's history is one straight line, and finds (and, on request, removes) the branches and worktrees
whose work is already on the base. The rule it enforces: rebase, never merge; no merge commits; a branch and its
worktree are removed once their work is on the base. Node 22 and git 2.36 or newer, no dependencies. Git is run
without a shell, with an explicit folder, and `GIT_DIR`, `GIT_WORK_TREE` and the other variables that pick a repository
are removed from its environment, so only the folder you give is ever read or changed.

Run: `node ~/.claude/tools/git-tidy/git-tidy.mjs check [dir] [--base <branch>] [--json]`
and `node ~/.claude/tools/git-tidy/git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--json]`.
`dir` defaults to the current folder (any folder inside a repository, a linked worktree or a bare repository).

The base is `--base`, else the branch `origin/HEAD` points at, else the first that exists of `main`, `master`, `develop`.
It must be a local branch; when none is found the exit code is 2 and the message names `--base`.

| Code | `check` | `prune` |
| ---- | ------- | ------- |
| 0 | clean (hints never change it) | done, or nothing to do, or a plan without `--apply` |
| 1 | findings | `--apply` kept or could not remove something it planned to (the line says why) |
| 2 | usage error, not a git repository, base not found | the same, and `--apply` while a rebase, merge, cherry-pick, revert or bisect is unfinished in any worktree |

## check

One line per item, `<kind> <subject> <detail>`, findings first, then hints (kind ends in `?`), then
`git-tidy: N findings, M hints (base <branch>)`. `--json` prints `{ base, findings, hints }` with items
`{ kind, subject, detail }` (a path with spaces is exact there).

| Finding | Meaning |
| ------- | ------- |
| `merge-commit <hash> <subject>` | a merge commit reachable from `HEAD` or the base that the base's upstream does not have; with no upstream, every merge commit on the base and on `base..HEAD` |
| `merged-branch <name> <hash> ancestor` | the branch tip is on the base (a branch created and never committed to also lands here) |
| `merged-branch <name> <hash> patch-equal` | every commit has an equal patch on the base (a rebase or cherry-pick that landed). A branch holding a merge commit is never patch-equal, because patch ids skip merges |
| `merged-worktree <path> branch <name>` | a linked worktree whose branch is a `merged-branch` |
| `stale-worktree <path> folder missing` | a registered worktree whose folder is gone |

The base and the branch checked out in the main worktree are never reported as merged.

| Hint | Meaning |
| ---- | ------- |
| `published-merge?` | merge commits already on the base's upstream; rewriting them needs the owner |
| `unmerged-branch?` | a local branch with commits the base lacks: how many, and the date of its last commit |
| `merged-remote-branch?` | an `origin/*` branch fully contained in the base's upstream; deleting it is the owner's call |
| `behind-base?` | the current branch does not contain the base tip (rebase needed) |
| `dirty-worktree?` | a linked worktree with uncommitted or untracked files |
| `in-progress?` | a rebase, merge, cherry-pick, revert or bisect is unfinished in that worktree |
| `shallow?` | a shallow clone: history is cut, so a branch may look unmerged (never the other way round) |

## prune

Without `--apply` it prints the plan and changes nothing: `remove` lines for each stale worktree, merged worktree and
merged branch it would remove, `keep` lines with the reason for each it would not, and a summary. A merged branch whose
only holders are worktrees in the plan is planned for removal too.

With `--apply`, in this order, each fact read again from git right before it is acted on:

1. `git worktree prune`, for stale entries (a locked one is kept).
2. Each merged worktree: kept when it has any `git status --porcelain` output (untracked files included, whatever
   `status.showUntrackedFiles` says), when `git status` fails, when it is locked, when it is the folder the command
   runs from, or when its branch is no longer merged; else `git worktree remove` (never `--force`).
3. Each merged branch that is not checked out in any remaining worktree: `git branch -D -- <name>`, printing
   `deleted <name> (was <full hash>)`. A branch name is always passed as `refs/heads/<name>` or after `--`, so a tag
   with the same name is never confused with it.

A failure of one item does not stop the others; the run ends with the exit code 1 if anything was kept or failed.

### What `prune --apply` never touches

The base, the current branch, a branch with commits the base lacks (`unmerged-branch?`), the branch checked out in the
main worktree, the main worktree, a linked worktree with uncommitted or untracked files, a locked worktree, a
detached-HEAD worktree (listed as kept), remote branches and tags. Nothing is removed while any worktree has an
unfinished rebase, merge, cherry-pick, revert or bisect.

### Restoring a deleted branch

Every deleted branch is printed with its full hash: `git branch <name> <hash>` brings it back (also found in
`git reflog` for a while). A removed worktree held no uncommitted work by the rules above; check it out again with
`git worktree add <path> <name>` after restoring the branch.

## Notes

- Merged detection is by commit or by patch (`git cherry`). A squash merge, or a branch whose commits were edited
  while rebasing, does not match and shows as `unmerged-branch?`; the tool leaves it for the owner.
- Submodules are not looked into. A worktree that holds an initialised submodule is refused by `git worktree remove`
  itself and shows up as `failed` with git's message.
- Speed: `check` and the plan cost about one git call per branch not already on the base (300 branches take about 2 s);
  `--apply` re-reads each branch and the worktree list before every removal (about 30 ms per branch).

## Layout

`git-tidy.mjs` (arguments, printing, exit code) over `lib/`; see `lib/README.md`. Tests: `tests/git-tidy-*.test.mjs`.
