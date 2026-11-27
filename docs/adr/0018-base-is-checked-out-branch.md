# 0018: The base is the branch checked out in the main checkout

- Status: accepted. Date: 2026-11-27. Builds on 0004 (content proof), 0010 (round loop), 0017 (branch drift).

## Context

The owner: "we must keep one line on the branch that i am already inside and no need to name a branch name". git-tidy took the
base from origin/HEAD, else main, master, develop; the status line from main, else master; sync required `main` on the synced machine; the
boss passed `--base <main sha>`; tick labels said "main" for develop. Land already used the checked-out branch, so on a feature
branch its sweep deleted a merged local develop.

## Options and decision

- D1 base source: origin/HEAD and names (old) / the folder's own HEAD / the main checkout's branch (chosen: the same from a lane,
  a hook or the main checkout; a detached main or a lane there stops with the step).
- D2 never deleted or claimed: the base / any tracked branch / the base, every branch marked `branch.<b>.cs-base` by claim or
  land, and each remote's HEAD branch (chosen: no name list, merged feature branches still cleaned).
- D3 lanes across a switch: nothing / a record `branch.<lane>.cs-lane-base` with land refusing a mismatch (chosen) / a fork-point
  test (misses a lane rebased onto a newer old base).
- D4 sync: the synced machine on main / it must match / it follows the source machine's branch, fast-forward only, clean
  tree (chosen).

## Consequences

- Good: no command names a branch; develop, master or a feature branch keeps one line; a branch left behind is never deleted;
  lanes never carry another branch's commits.
- Bad: two git config keys per branch; a marked branch stays until deleted by hand; a hand-made branch checked out in the main
  checkout becomes the base; the synced machine switches branch when the source machine does.

## Reversal

- The owner keeps the base in a linked worktree: take the `--repo` folder's branch.
- Marked branches pile up in `left:`: add an unmark step.
- A lane landed with another base's commits: make the record required for every lane.

## Sources

- Probes on git 2.54.0 (the job's plan, section 6, kept outside the repo): branch config section on -m, -d, update-ref -d,
  config.lock; worktree list when detached; fetch from a bundle into a branch.
- git-scm.com/docs/git-config ("branch.<name>.*"), git-scm.com/docs/git-branch, git-scm.com/docs/git-worktree.
