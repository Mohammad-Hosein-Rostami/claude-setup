# claude-setup (this repo's own working rules)

This repo is a shareable Claude Code setup. `home/` is symlinked live into `~/.claude`, so an edit there is
live in every running session at once. A half-written hook breaks Bash everywhere.

- Shared text (`home/`, `docs/`, this file) holds no one's private facts (name, machines, accounts, billing, own standing
  rules); those go in `personal/CLAUDE.md` (git-ignored, its own git repo; template in `personal.example/`).
- Edit hooks, the guard and tools in a git worktree (`scripts/lane-new.sh <name>`). To land: rebase onto main, then
  fast-forward (`git merge --ff-only`), through the `land` script (`home/tools/land`). Parallel agents each use their own
  worktree; never edit the main checkout while others work.
- Tests: `node --test tests/*.test.mjs` (never bare `node --test`); ui-check's own tests: `npm run test:ui-check`
  (`npm run test:all` runs both). No test runs by itself: the commit hook and a push run none, and `land` only with `--test`
  or when both sides changed the same files. Run the whole suite by hand (or ask `tess`) when you want to know everything
  still works; `node ~/.claude/tools/suite/suite.mjs run --cache -- node --test tests/*.test.mjs` queues and caches it.
- The pre-commit hook runs gitleaks and `scripts/share-check.mjs --staged` (your private words) on the staged changes and
  `node --check` on each staged hook file; the commit-msg hook checks the message for the same words.
- Commit only your own paths: `git commit -m "<conventional message>" -- <paths>`. Never `--no-verify`.
- `~/.claude/settings.json` is a merged copy: change `settings/base.json` (or an OS file) and re-merge with
  `scripts/install.sh`.
- Never push unless the owner says so.
- Add or change a skill, agent, tool or hook: update `docs/catalog.md` in the same commit (`node scripts/catalog.mjs write`
  builds the skill, agent and hook-event parts; `check` exits 1 on drift).
- Work habits for day-to-day use are in `docs/daily-use.md`; the global rules the sessions load are `home/CLAUDE.md`
  (shared), then `personal/CLAUDE.md` (yours).
