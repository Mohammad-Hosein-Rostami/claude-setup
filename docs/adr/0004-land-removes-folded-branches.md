# 0004: land removes the branches whose content landed, by one content proof

- Status: accepted (2026-11-25). The first version (record the landed lane's history and prove folds from it) was replaced
  the same day: three reviews found holes in it, and the owner's standard is the simpler, safer rule. Date: 2026-11-25.

## Context

Finished work often reaches a lane through a second branch before it lands: a fix made on the `test/<topic>` branch that
the tests were written on, a helper or test branch fast-forwarded into the lane, a stack that picks up its lower lanes. On
the way the commits are rewritten (fixup and autosquash, squashes, rebases, cherry-picks). Two things went wrong together:

1. git-tidy's proofs (ancestor; equal patch ids plus `merge-tree`) do not see a branch whose content landed in other
   commits (a squash), so such branches showed as `unmerged-branch?`, exactly like the live lanes.
2. Nothing ran `git-tidy prune` after a land, so even provable leftovers stayed.

Seven such branches were left in this repository at once; their clean-up was planned as a later job that nobody owned.

## Drivers

- D1: no finished branch outlives its landing without a printed reason.
- D2: nothing is deleted unless its content is on the base, and every deletion can be restored.
- D3: stacked and live lanes are never touched.
- D4: no new routine for agents to remember.
- D5: plain structure: a rule a person can check by hand.

## Options

| Driver | 1. rules only | 2. prune after each land, one content proof | 3. record the landed lane's history, prove folds from it |
|---|---|---|---|
| D1 | bad: the rule existed and was not followed | ok: a fold the lane changed stays, named under `left:` | good |
| D2 | ok (a person judges) | good: `git merge-tree` shows the content is on the base | bad: an amend, a same-parent move or a later removal made the history "prove" work that was not on the base |
| D3 | ok | good | good |
| D4 | bad | good | good |
| D5 | good | good: one git command per branch | bad: reflog steps, patch ids, change ids, a landing log |

## Decision

Option 2. After the fast-forward, `land` runs `git-tidy prune --apply` over the repository and prints `left:`. A branch is
deleted only when ONE content proof holds: its tip is an ancestor of the base, or `git merge-tree --write-tree <base>
<branch>` prints exactly the base's tree (merging it would change nothing, so all its content is on the base: state
`content-equal`). Patch ids (`patch-equal`) only name the state of a branch that also passes `merge-tree`. Reflogs and
landed history are never a reason to delete; they only give the `in <B> (lands with it)` hint of `left:`.

A merge runs the repository's merge drivers and attributes (`merge=ours`, `merge=union`, `merge.default`), which can drop the
branch's change and still give the base's tree. So every merge proof also needs a check that merges nothing: each path the
branch changed since its merge base (`git diff-tree --merge-base <base> <tip>`) is the same blob on the base as on the tip
(not listed by `git diff-tree <base> <tip>`). Plumbing diff-tree runs no driver, attribute or textconv. No merge base (an
orphan branch) or more than one (criss-cross merges) proves nothing, so such a branch is kept. We chose this over running
merge-tree without attributes: `.git/info/attributes` and `merge.default` cannot be switched off for one call, while a blob
comparison needs nothing switched off.

- The proofs of one sweep compare with one base commit, read once the candidates are found. Each branch delete is one
  `git update-ref --stdin` transaction that also verifies the base still points at that commit, and each worktree removal
  checks it first; a base that moved (another land, a reset) stops the sweep, and everything not yet removed is kept with
  the reason. A proof is about the tip commit that was read, which the delete also verifies.
- A worktree with an assume-unchanged file, or a skip-worktree file that exists on disk (`git ls-files -v`: a lowercase tag,
  or `S`), is kept: `git status` does not show edits there, and removing the worktree would lose them. `land` itself refuses
  such a lane or base checkout for the same reason. A sparse checkout's skip-worktree files outside its patterns are not on
  disk, hold no edit, and do not count, so a clean sparse checkout lands.
- A worktree with a git repository inside an ignored folder (`git clean -ffdx -n` lists it, `-fdx -n` does not) is kept:
  its commits may be the only copy. Untracked files and ignored files outside the rebuildable folders keep it too.
- A stale worktree entry (its folder is gone) is removed one at a time with `git worktree remove`, never `git worktree
  prune`. It stays when its HEAD reflog holds commits found nowhere else; when no branch holds its HEAD, that commit first
  becomes the branch `stale-head/<entry id>`, named under `left:`, so it stays reachable.

- The sweep holds the rule everywhere: older copies and agent leftover branches whose work is on another branch, not on the
  base, are kept and named under `left:` (prune's `onlyOnBase`). The standalone `git-tidy prune --apply` a person runs by
  hand keeps main's copy rule.
- A git older than 2.40 has no `merge-tree --stdin`: land still lands and skips the sweep with one stderr line.
- Prune's other checks stay: a dirty, locked or recently used worktree, ignored files that exist only there, commits that
  exist only in a reflog, the not-started rule and the protected branches keep a branch.
- Every branch is written to the deletion log `<git common dir>/cs-tidy-log.jsonl` with its sha before it is deleted, so it
  can be restored with `git branch <name> <sha>` within 2 weeks (`gc.pruneExpire`). A branch whose record cannot be written
  is kept. The log is opened only as a regular file (no symbolic link, no FIFO); anything else in its place stops the whole
  clean-up before it removes anything, with one stderr line, and the land still exits 0.
- The batch form `git merge-tree --stdin` checks every unmerged branch in one git call (`--allow-unrelated-histories`, so an
  orphan branch does not abort the batch); only the branches it proves get the two diff-tree calls of the blob check.

## Consequences

- Good: a person can check every deletion with one command. A rewrite of any kind (amend, `rebase --onto`, `drop`, a moved
  ref, a later removal in the lane) can no longer make a branch look done.
- Bad: a fold that the lane changed (a fixup of the folded commit, an amend after a fast-forward or a cherry-pick) stays,
  named under `left:` as `active` or `idle`; it is deleted by hand (`git branch -D`) once a person has looked.
- A revert pair (a commit and its revert) is content-equal and is deleted: no content is lost, only the two commits.
- Reversal signal: a deletion that had to be restored from the log, or a land clean-up over 3 s on 30 branches.
