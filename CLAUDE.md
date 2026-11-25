# claude-setup (this repo's own working rules)

This repo is a shareable Claude Code setup. `home/` is symlinked live into `~/.claude`, so an edit there is
live in every running session at once. A broken hook or tool there breaks every session at once.

- Shared text (`home/`, `docs/`, this file) holds no one's private facts (name, machines, accounts, billing, own standing
  rules); those go in `personal/CLAUDE.md` (git-ignored, its own git repo; template in `personal.example/`).
- Edit hooks and tools in a git worktree: a pool lane (`node ~/.claude/tools/git-tidy/git-tidy.mjs lane claim --repo <abs>
  --branch lane/<name> --base <main sha>`) or `scripts/lane-new.sh <name>`. To land: rebase onto main, then fast-forward
  (`git merge --ff-only`), through the `land` script (`home/tools/land`). Parallel agents each use their own
  worktree; never edit the main checkout while others work.
- Tests: `node --test tests/*.test.mjs` (never bare `node --test`); ui-check's own tests: `npm run test:ui-check`
  (`npm run test:all` runs both). No test runs by itself; `land` runs one only with `--test`. Run the whole suite by hand
  (or ask `tess`): `node --test tests/*.test.mjs`.
- Before each commit, stage first, then check by hand what is staged: `git add -- <paths>` (only your own paths;
  `git diff --cached --name-only` lists them), `gitleaks git --staged --redact --verbose` and
  `node scripts/share-check.mjs --staged`; write the message to a file and run
  `node scripts/share-check.mjs --commit-msg <file>`. Then commit only what is staged: `git commit -F <file>`, with no
  paths and no `-a` (`git commit -- <paths>` commits the working-tree files, not the checked index, so an unstaged secret
  gets past the checks). A change made after the checks is staged and checked again. A hit stops the commit.
- Commit only your own paths, staged as above, with a Conventional Commits message. Never `--no-verify`.
- `~/.claude/settings.json` is a merged copy: change `settings/base.json` (or an OS file) and re-merge with
  `scripts/install.sh`.
- Never push unless the owner says so.
- Never set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` (in
  `settings/*.json` or the shell): they override the model and effort every agent file sets.
- `docs/catalog.md` is generated and git-ignored (install writes it; `node scripts/catalog.mjs write` by hand). A skill, agent,
  tool or hook gets its description in its own file: frontmatter, or the first header line.
- Work habits for day-to-day use are in `docs/daily-use.md`; the global rules the sessions load are `home/CLAUDE.md`
  (shared), then `personal/CLAUDE.md` (yours).
