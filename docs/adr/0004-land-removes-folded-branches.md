# 0004: land removes the branches folded into the lane it landed

- Status: accepted (the owner chose the deletion rule, 2026-11-25). Date: 2026-11-25.

## Context

Finished work often reaches a lane through a second branch before it lands: a fix made on the `test/<topic>` branch that
the tests were written on, a helper or test branch fast-forwarded into the lane, a stack that picks up its lower lanes. On
the way the commits are rewritten (fixup and autosquash, rebases with conflicts, cherry-picks). Three things then went
wrong together:

1. `land` deleted only the branch it landed, and deleting a branch deletes its reflog: the only record that the earlier
   branch was folded into it. After that no tool could prove the earlier branch was done.
2. git-tidy's proofs (ancestor; equal patch ids plus `merge-tree`; a copy within one name family) cannot see rewritten work,
   so those branches showed as `unmerged-branch?`, exactly like the live lanes.
3. Nothing ran `git-tidy prune` after a land, so even provable leftovers stayed.

Seven such branches were left in this repository at once; their clean-up was planned as a later job that nobody owned.

## Drivers

- D1: no finished branch outlives its landing without a printed reason.
- D2: nothing is deleted without proof that its commits are in what landed, and every deletion can be restored.
- D3: stacked and live lanes are never touched.
- D4: no new routine for agents to remember.
- D5: plain structure.

## Options

| Driver | 1. rules only | 2. prune after each land | 3. record the history, prove folds, then prune |
|---|---|---|---|
| D1 | bad: the rule existed and was not followed | bad: 5 of the 7 leftovers stay | good |
| D2 | ok (a person judges) | good | good: ancestry or a patch id in the landed history, no reset after the point it relies on, prune's other checks, deletions logged |
| D3 | ok | good | good: proofs come only from landed lanes; a live stack gets the `in-lane?` hint |
| D4 | bad | good | good |
| D5 | good | good | ok: one log file and one proof module |

## Decision

Option 3. `land` reads the lane's history (its tip and reflog down to its newest reset, and the patch ids of the commits they
reach) before anything moves the lane, appends it to `<git common dir>/cs-tidy-log.jsonl` right after the fast-forward, then
runs `git-tidy prune --apply` over the repository and prints `left:`. Prune gets the `folded-branch` proof from those records.

- The proof comes from landed lanes only; a branch inside a live lane is a hint and is never deleted.
- A reset ends the proof: positions older than the landed lane's newest `reset:` or `branch: Reset to` entry do not count,
  because the folded work may have been dropped on purpose there.
- A reflog step that may have dropped a commit ends the proof too: a step counts only when the new position descends from
  the old one, is an amend of it, or merging the old one into it changes nothing (`git merge-tree`).
- Cherry-picks count when they make exactly the change of a commit of the landed history: the same `git patch-id --verbatim`
  and the same files before and after (a patch id alone leaves out line numbers).
- A landing proves nothing once its landed tip is no longer on the base (the landing was undone).
- A folded branch's worktree used in the last 60 minutes after the lane's last commit is kept; one last used before that
  commit was left behind, so its recent use does not keep it. A dirty, locked or untracked worktree, ignored files that exist
  only there, commits that exist only in a reflog and the not-started rule keep it as before.
- Records are read for 30 days, so a branch kept today is still proven at the next prune. Every deleted branch is logged
  with its sha and can be restored with `git branch <name> <sha>` within 2 weeks (`gc.pruneExpire`).

## Consequences

- Good: every land leaves the repository tidy or names what stays and why, with no extra step.
- Bad: land takes a little longer (one prune). A branch folded into a lane that was later reset, with no other proof, stays
  on purpose. One more file inside `.git`.
- A rebase that drops folded commits without a reset entry (`rebase -i` with `drop`, `rebase --onto`) ends the proof, so such
  a branch stays. An amend counts as an edit, as a later commit would: an amend that undoes a folded tip commit still proves it.
- A cherry-pick onto content that differs (the base changed the same file elsewhere) is not proven and stays.
- Reversal signal: a deletion that had to be restored from the log, or a land clean-up over 5 s. Then narrow the proof to
  ancestry of the landed lane's tip only.
