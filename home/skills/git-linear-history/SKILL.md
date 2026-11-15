---
name: git-linear-history
description: Use before integrating a branch, pulling, or landing parallel lanes, and whenever the owner asks to clean up git - merge commits, tangled or leftover branches, old worktrees, a messy graph. History is one straight line - rebase, never merge.
---

Goal: `git log --graph` of the base branch is one line of small Conventional Commits, and no branch or worktree outlives its work (C37).

**Every day**
1. Start from the up-to-date base: `git switch -c <type>/<topic> <base>`. Parallel lanes each get their own worktree and branch.
2. Bring in the base with `git rebase <base>` (or `git pull --rebase`), never `git merge <base>` and never a merge from a sibling lane. A lane that needs another lane's work waits until that lane has landed, then rebases.
3. Land with `git switch <base> && git merge --ff-only <branch>`. If it refuses, rebase again; never drop `--ff-only`. Lanes land one at a time: land, re-run the checks, rebase the next.
4. Right after landing: `node ~/.claude/tools/git-tidy/git-tidy.mjs prune` lists the branches and worktrees whose work is fully on the base; add `--apply` to remove them. It keeps a dirty worktree, a worktree with ignored files that exist only there, a branch with work of its own, and anything used in the last hour (add `--include-recent` for lanes you landed yourself). Name the base with `--base` when the repo has more than one of main, master, develop.
5. Rewrite only your own unpublished commits (no interactive rebase here: `git commit --fixup <hash>` then `git rebase --autosquash <base>`, or `git reset --soft` and recommit). Commits already on a shared remote branch are never rewritten without the owner's yes. A feature branch you pushed is updated with `--force-with-lease`, never `--force`.

**Cleaning an existing tangle** (merge commits, branches merged into each other, leftovers)
1. Stop feature work; every worktree clean; list worktrees, local and remote branches.
2. Back up first: a tag `backup/<date>/<branch>` on every tip and `git bundle create <path outside the repo> --all`. Keep both until the owner releases them.
3. Inventory each branch against the base (`git log --oneline --no-merges <base>..<branch>`, `git cherry -v <base> <branch>`) in a STATUS.md table: commits not on the base, verdict (needed / contained elsewhere / obsolete), proof. Work that exists nowhere else is integrated or listed for the owner, never dropped on a guess.
4. Build the state that holds all needed work and passes the checks; note its tree (`git rev-parse <tip>^{tree}`). That tree is the reference.
5. Linearise on a new branch from the base: replay the real commits without the merge commits (`git rebase <base>` from the integrated tip), resolving conflicts as the merges did. Keep commits small; ask the owner before squashing a stretch that will not replay.
6. Proof, quoted in the report: `git diff <reference> <new tip>` is empty; `git log --merges <base>..<new tip>` is empty; the checks pass on the new tip.
7. Fast-forward the base to the new tip. If published history on the base would have to change: stop and ask the owner.
8. `git-tidy prune --apply`; then the owner confirms each remote step (push, remote branch delete, force-with-lease).

Done-gate: `node ~/.claude/tools/git-tidy/git-tidy.mjs check` exits 0 (no unpublished merge commit, no merged branch or worktree left). Report: branches removed, branches kept and why, backup tags and bundle path, the three proofs.
