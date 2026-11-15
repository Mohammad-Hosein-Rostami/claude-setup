# claude-setup (this repo's own working rules)

This repo is the owner's personal Claude Code setup. `home/` is symlinked live into `~/.claude`, so an edit there is
live in every running session at once. A half-written hook breaks Bash everywhere.

- Edit hooks, the guard and tools in a git worktree; when the suite is green, rebase onto main and fast-forward (`git merge --ff-only`). Parallel agents each use their
  own worktree; never edit the main checkout while others work.
- Tests: `node --test tests/*.test.mjs` (never bare `node --test`). The pre-commit hook runs it plus gitleaks.
- Commit only your own paths: `git commit -m "<conventional message>" -- <paths>`. Never `--no-verify`.
- `~/.claude/settings.json` is a merged copy: change `settings/base.json` (or an OS file) and re-merge with
  `scripts/install.sh`.
- Guard changes get a security audit before they are kept.
- Never push unless the owner says so.
- Add or change a skill, agent, tool or hook: update `docs/catalog.md` in the same commit.
- Work habits for day-to-day use are in `docs/daily-use.md`; the global rules the sessions load are `home/CLAUDE.md`.
