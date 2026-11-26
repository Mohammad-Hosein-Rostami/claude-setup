# git-tidy/lib

The parts of the `git-tidy` tool. `../git-tidy.mjs` is the command; see `../README.md` for what is checked and what
`prune --apply` never touches.

| File | Job |
| ---- | --- |
| `git.mjs` | run git without a shell and without environment variables that pick a repository; `UsageError` |
| `repo.mjs` | read facts: base branch, upstream, worktrees, branches, unfinished operations, uncommitted files, files marked assume-unchanged or skip-worktree |
| `branches.mjs` | is a branch on the base (`ancestor`, `patch-equal`, `content-equal`: merging it changes nothing and every path it changed is the same blob on the base) or how far ahead is it |
| `tags.mjs`, `tangled.mjs` | tags off the base's history (merged or not); branches and tags that still reach an unpublished merge commit |
| `reflog.mjs` | commits that exist only in a reflog (lost when a worktree or branch is removed); whether a branch has no commit of its own yet (its reflog records no work) |
| `leftovers.mjs` | merged branches, merged worktrees and stale worktrees (shared by `check` and `prune`) |
| `copies.mjs` | older copies of a re-done lane and agent leftover branches (shared by `check` and `prune`); patch ids |
| `in-lane.mjs` | the `in-lane?` hint: an unmerged branch whose commits are all in a live branch's history (a hint only, never a reason to remove) |
| `deletion-log.mjs` | the deletion log `cs-tidy-log.jsonl` in the git common dir: each branch prune deletes, with its sha, opened only as a regular file |
| `land.mjs` | `land`: rebase, PASS check, fast-forward, cleanup |
| `check.mjs` | merge commits and the findings and hints of `check` |
| `prune.mjs` | the plan and the re-checked removal of `prune` |
| `prune-stale.mjs` | prune's step for stale worktree entries: keep one that holds work, keep its HEAD on a `stale-head/<id>` branch, remove one entry at a time |
| `pinned-base.mjs` | the base commit one `prune --apply` compares with, and whether the base branch moved away from it |
| `report.mjs` | text and JSON output, the exit codes of `prune` and `land` |
| `ui-plan-check.mjs` | `land`'s UI step: the check plan of the rebased diff and its proof (`ui-proof check --plan`), the row pointer it proved |
| `lane-slots.mjs` | read the lane folder pool: each `lane-<n>` folder and whether it is free, busy (why), missing, filling or broken |
| `lane-pool.mjs` | `lane claim` (in clone mode two steps under the pool lock, the fill between them); re-exports lane-release.mjs, so callers import release, reclaim and `detachLandedSlot` from here |
| `lane-release.mjs` | `lane release`, `lane reclaim` and land's `detachLandedSlot`, plus the base names, branch tip and job-made record a claim shares |
| `lane-fill-state.mjs` | a slot's fill file `cs-lane-fill/lane-<n>.json` in the git common dir (who fills it, for which branch), and emptying a broken slot for its refill |
| `lane-fill.mjs` | fill a lane folder by clones of the main checkout (`cp -c`, or `cp --reflink=always` on Linux), the skip list, the repair; whether cloning works here (`GIT_TIDY_LANE_FILL=checkout` turns it off) |
| `pool-lock.mjs` | the one pool lock per repository (stale when its pid is gone or over 120 s old) |
| `nested-repository.mjs` | the git repositories nested in a folder (`ls-files -z --others`), which a removal, `clean -ffdx` or an install would delete; shared by the pool, prune, land and lane-prep |
| `lane-prep.mjs` | the installs a claimed folder needs, from its tracked lockfiles |
| `lane-deps.mjs` | the deps cache `cs-lane-deps/<key>/node_modules` in the git common dir: clone before an install, save after one, prune |
| `lane-cli.mjs` | the `lane` command: arguments, output, exit codes |
| `shell-word.mjs` | `shellWord`: one word of a command a person copies, quoted for a POSIX shell (used by `lane`, `lane release` and land's advice) |
