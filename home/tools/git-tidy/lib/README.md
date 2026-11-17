# git-tidy/lib

The parts of the `git-tidy` tool. `../git-tidy.mjs` is the command; see `../README.md` for what is checked and what
`prune --apply` never touches.

| File | Job |
| ---- | --- |
| `git.mjs` | run git without a shell and without environment variables that pick a repository; `UsageError` |
| `repo.mjs` | read facts: base branch, upstream, worktrees, branches, unfinished operations, uncommitted files |
| `branches.mjs` | is a branch on the base (`ancestor`, `patch-equal`) or how far ahead is it |
| `tags.mjs`, `tangled.mjs` | tags off the base's history (merged or not); branches and tags that still reach an unpublished merge commit |
| `reflog.mjs` | commits that exist only in a reflog (lost when a worktree or branch is removed); whether a branch has no commit of its own yet (its reflog records no work) |
| `leftovers.mjs` | merged branches, merged worktrees and stale worktrees (shared by `check` and `prune`) |
| `copies.mjs` | older copies of a re-done lane and agent leftover branches (shared by `check` and `prune`); patch ids |
| `land.mjs` | `land`: rebase, PASS check, fast-forward, cleanup |
| `check.mjs` | merge commits and the findings and hints of `check` |
| `prune.mjs` | the plan and the re-checked removal of `prune` |
| `report.mjs` | text and JSON output, the exit codes of `prune` and `land` |
