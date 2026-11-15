# git-tidy/lib

The parts of the `git-tidy` tool. `../git-tidy.mjs` is the command; see `../README.md` for what is checked and what
`prune --apply` never touches.

| File | Job |
| ---- | --- |
| `git.mjs` | run git without a shell and without environment variables that pick a repository; `UsageError` |
| `repo.mjs` | read facts: base branch, upstream, worktrees, branches, unfinished operations, uncommitted files |
| `branches.mjs` | is a branch on the base (`ancestor`, `patch-equal`) or how far ahead is it |
| `leftovers.mjs` | merged branches, merged worktrees and stale worktrees (shared by `check` and `prune`) |
| `check.mjs` | merge commits and the findings and hints of `check` |
| `prune.mjs` | the plan and the re-checked removal of `prune` |
| `report.mjs` | text and JSON output, the exit code of `prune` |
