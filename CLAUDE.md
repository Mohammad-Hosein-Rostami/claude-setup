# claude-setup (this repo's own working rules)

This repo is the owner's personal Claude Code setup. `home/` is symlinked live into `~/.claude`, so an edit there is
live in every running session at once. A half-written hook breaks Bash everywhere.

- Edit hooks, the guard and tools in a git worktree (`scripts/lane-new.sh <name>`). To land: rebase onto main, then
  fast-forward (`git merge --ff-only`), through `land-lane`. Parallel agents each use their own worktree; never edit the main
  checkout while others work.
- Tests: `node --test tests/*.test.mjs` (never bare `node --test`). Nothing runs them automatically: no commit, push or landing step
  runs the suite. Run the tests of what you changed by hand when you want to know it still works.
- The pre-commit hook runs gitleaks on the staged changes and `node --check` on each staged hook file.
- Commit only your own paths: `git commit -m "<conventional message>" -- <paths>`. Never `--no-verify`.
- `~/.claude/settings.json` is a merged copy: change `settings/base.json` (or an OS file) and re-merge with
  `scripts/install.sh`.
- Never push unless the owner says so.
- Add or change a skill, agent, tool or hook: update `docs/catalog.md` in the same commit.
- Work habits for day-to-day use are in `docs/daily-use.md`; the global rules the sessions load are `home/CLAUDE.md`.
