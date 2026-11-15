# git-tidy

Checks that a repository's history is one straight line, and finds (and, on request, removes) the branches and worktrees
whose work is already on the base. The rule it enforces: rebase, never merge; no merge commits; a branch and its
worktree are removed once their work is on the base. Node 22 and git 2.38 or newer (`merge-tree --write-tree`), no dependencies. Git is run
without a shell, with an explicit folder, and `GIT_DIR`, `GIT_WORK_TREE` and the other variables that pick a repository
are removed from its environment, so only the folder you give is ever read or changed.

Run: `node ~/.claude/tools/git-tidy/git-tidy.mjs check [dir] [--base <branch>] [--json]`
and `node ~/.claude/tools/git-tidy/git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]`.
Both print `base: <branch> (from --base | from origin/HEAD | fallback)` first.
`dir` defaults to the current folder (any folder inside a repository, a linked worktree or a bare repository).

The base is `--base`, else the branch `origin/HEAD` points at, else the first that exists of `main`, `master`, `develop`.
It must be a local branch; when none is found the exit code is 2 and the message names `--base`. `prune --apply` also
exits 2, deleting nothing, when the base was not given with `--base` and more than one of `main`, `master`, `develop`
exists here: a wrong base would call work "merged" that is not on the branch you work against.

| Code | `check` | `prune` |
| ---- | ------- | ------- |
| 0 | clean (hints never change it) | done, or nothing to do, or a plan without `--apply` |
| 1 | findings | `--apply` kept or could not remove something it planned to (the line says why) |
| 2 | usage error, not a git repository, base not found, any git command that fails | the same, and `--apply` while a rebase, merge, cherry-pick, revert or bisect is unfinished in any worktree, or with an ambiguous base |

## check

One line per item, `<kind> <subject> <detail>`, findings first, then hints (kind ends in `?`), then
`git-tidy: N findings, M hints (base <branch>), all local refs on one line: yes|no` (no when there is a `merge-commit`, `tangled-ref`, `merged-branch` or `merged-tag` finding; hints do not count). `--json` prints `{ base, findings, hints }` with items
`{ kind, subject, detail }` (a path with spaces is exact there).

| Finding | Meaning |
| ------- | ------- |
| `merge-commit <hash> <subject>` | a merge commit reachable from `HEAD` or the base that the base's upstream does not have; with no upstream, every merge commit on the base and on `base..HEAD` |
| `merged-branch <name> <hash> ancestor` | the branch tip is on the base (a branch created and never committed to also lands here) |
| `tangled-ref <ref> <n> merge commits ...` | a local branch or a `backup/` tag (full ref name; not the base, not the current branch) that still reaches a merge commit no remote-tracking ref has (with no remote: that the base lacks). Old tangled history stays visible in `git log --graph --all` through such refs |
| `merged-branch <name> <hash> patch-equal` | every non-merge commit has an equal patch on the base (a rebase or cherry-pick that landed) AND merging the branch into the base would change nothing (`git merge-tree --write-tree` gives the base's own tree). Patch ids ignore whitespace and skip merge commits, so the second proof is what keeps a branch that differs only in indentation, or holds a hand-made change in a merge, from being called merged |
| `merged-tag <tag> <hash> patch-equal` | a `backup/` tag that is not on the base's history but whose work is all on the base by the same test: a temporary backup made before a history clean-up. A tag that is an ancestor of the base (a release tag) is never reported |
| `merged-worktree <path> branch <name>` | a linked worktree whose branch is a `merged-branch` |
| `stale-worktree <path> folder missing` | a registered worktree whose folder is gone |

The base and the branch checked out in the main worktree are never reported as merged.

| Hint | Meaning |
| ---- | ------- |
| `published-merge?` | merge commits already on the base's upstream; rewriting them needs the owner |
| `merged-tag?`, `tangled-tag?` | the same two checks for a tag NOT named `backup/`. Whether a tag is published cannot be known without the network (a release tag on a backport branch is normal), so only `backup/` tags, the name the clean-up procedure gives its temporary tags, are findings |
| `unmerged-branch?`, `unmerged-tag?` | a local branch or tag with commits the base lacks: how many, and the date of its last commit |
| `ignored-files?` | a merged worktree holds ignored files that exist only there (`prune` keeps it) |
| `merged-remote-branch?` | an `origin/*` branch fully contained in the base's upstream; deleting it is the owner's call |
| `behind-base?` | the current branch does not contain the base tip (rebase needed) |
| `dirty-worktree?` | a linked worktree with uncommitted or untracked files |
| `in-progress?` | a rebase, merge, cherry-pick, revert or bisect is unfinished in that worktree |
| `shallow?` | a shallow clone: history is cut, so a branch may look unmerged (never the other way round) |

## prune

Without `--apply` it prints the plan and changes nothing (it may add unreferenced tree objects through `merge-tree`, which
`git gc` removes): `remove` lines for each stale worktree, merged worktree and merged branch it would remove, `keep` lines
with the reason for each it would not, a `tags (...)` line naming merged tags, and a summary. A merged branch whose only
holders are worktrees in the plan is planned for removal too.

Principle: it removes only what is provably on the base AND leaves no only-copy of anything behind. When in doubt it keeps
and prints why. With `--apply`, in this order, each fact read again from git right before it is acted on:

1. `git worktree prune`, for stale entries (a locked one is kept).
2. Each merged worktree is kept (`kept ...: <reason>`) when any of these holds, else `git worktree remove` (never `--force`):
   it is locked; it is the folder the command runs from or contains the shell's current folder; its branch is no longer
   merged; it has any `git status --porcelain` output (untracked files included, whatever `status.showUntrackedFiles` says)
   or git status fails; it holds ignored files (not OS clutter: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`) outside `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`,
   `.turbo`, `.cache`, `.nx`, `test-results`, `playwright-report`, `.vite` (up to 5 paths are printed, `+N more`);
   its branch reflog or its HEAD reflog holds commits that are on no other ref (branch, tag, remote-tracking), not on the base
   and not landed there (a pre-rebase copy of a landed commit does not count, nor a commit of another branch the worktree
   once visited); more than 200 reflog entries (not checked); or any tracked file, its index or its HEAD
   reflog changed in the last 60 minutes (`used <n> min ago`; `--include-recent` lifts only this rule).
   A lane with no commit of its own yet (its branch reflog records no commit, cherry-pick, revert, am or pull, and every entry is on the base; a rebase or
   fast-forward onto a moved base does not count) keeps this rule even with `--include-recent`, printed as `not started yet (no commit of its own), used in
   the last 60 min`; a missing or unreadable reflog counts as started. That rule reads file and reflog times, so `touch` can defeat it: it is a
   courtesy guard, not a lock.
3. Each merged branch that is not checked out in any remaining worktree and whose reflog holds nothing that is not on the
   base: deleted with `git update-ref -d refs/heads/<name> <tip read a moment ago>`, so a branch that moved since is kept,
   printing `deleted <name> (was <full hash>)`. Its `branch.<name>.*` config section goes too. A branch name is always passed
   as a full ref, so a tag with the same name is never confused with it.

A failure of one item does not stop the others; the run ends with exit code 1 if anything was kept or failed.

### What `prune --apply` never touches

The base, the current branch, a branch with commits the base lacks (`unmerged-branch?`), the branch checked out in the
main worktree, the main worktree, a linked worktree with uncommitted, untracked or ignored files, a locked worktree, a
detached-HEAD worktree (listed as kept), a worktree used in the last hour (unless `--include-recent`, which does not apply to a lane with no commit of its own yet), anything whose reflog
holds commits that exist nowhere else, remote branches and tags. Nothing is removed while any worktree has an unfinished
rebase, merge, cherry-pick, revert or bisect.

### Tags are never deleted by this tool

A tag may be the only backup of a history clean-up, so `prune` lists the `backup/` ones that are merged and leaves them. Delete one by
hand after you have verified your backup bundle: `git bundle verify <file>` (is it complete and valid) and
`git bundle list-heads <file>` (does it hold the refs you expect).

### Restoring after a deletion

A deleted branch can be recreated with `git branch <name> <hash>` from the hash printed on its `deleted` line, but only
while its commits are still in the object store (not yet garbage-collected). The branch's reflog and, for a removed
worktree, its HEAD reflog, its ignored files and its untracked files are NOT recoverable. That is why a worktree or
branch whose reflog holds only-copy commits, and a worktree holding ignored or untracked files, are kept instead.

## Notes

- Merged detection is by commit, or by patch plus an exact content check. A squash merge, or a branch whose commits were edited
  while rebasing, does not match and shows as `unmerged-branch?`; the tool leaves it for the owner.
- Submodules are not looked into. A worktree that holds an initialised submodule is refused by `git worktree remove`
  itself and shows up as `failed` with git's message.
- Speed: `check` and the plan cost about one git call per branch not already on the base, plus one per unpublished merge
  commit (300 branches take about 4 s each); `--apply` re-reads each branch, its reflog and the worktree list before every
  removal (about 7 git calls, 0.1 s per branch).

## Layout

`git-tidy.mjs` (arguments, printing, exit code) over `lib/`; see `lib/README.md`. Tests: `tests/git-tidy-*.test.mjs`.
