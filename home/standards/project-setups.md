# Project setups: lessons from real projects

How this setup and a project's own AI setup combine is the rule in `CLAUDE.md` "Project AI setups". These are lessons real
projects taught. Each is a check to make in any project, not a fact about one.

## Before you trust a check
- Runtime version: a project may pin its runtime (`.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, a `volta`
  or `engines` field in `package.json`). Compare the active version (`node -v`, `python --version`) with the pin before you
  run its checks, and put the version manager's folder first on `PATH` when the shell's default differs. A red or a green on
  the wrong version proves nothing.
- Tool shims: `node_modules/.bin/<tool>` may be a shell script (pnpm writes these), which `node` cannot load. Run the tool
  through the package manager (`pnpm exec <tool>`) or by its JavaScript entry file in `node_modules/<package>/`.
- The main check script may not run every check: one may need a sibling repo or service and be left out on purpose. Find
  the left-out ones in the project's scripts and run them when their area changes.

## Lists kept by hand
- Some projects keep lists that a change must also update and that fail nothing at once when missed: route coverage
  manifests for access tests, the tables an erase or export job walks, a feature registry. A change that adds a route, a
  table or the like updates each list, and a review checks every one.

## The project's AI files
- A project may keep AI rules where Claude Code does not load them: another tool's folder (such as `.cursor/rules`) or a
  requirements file the team's docs point to. The start note names only what Claude Code loads, so read those files too.
- The UI-skill reminder reads the prompt and the file being edited. UI that lives elsewhere (page styles or markup inside
  server code, a docs site theme) may get no reminder; the UI skills apply all the same, so load them yourself.
- Not git (SVN or another system): Claude Code's local files (`CLAUDE.local.md`, `.claude/settings.local.json`) are not
  kept out by a `.gitignore` there. Never add or commit them; that system's status shows them as untracked, and they stay so.

## What a project note holds
- Only what differs for this setup in that project and the project's own files do not say: extra checks and when to run
  them, lists kept by hand, which project skill replaces which of ours, rule files Claude Code does not load.
- Not the global rules again (skill routing, how the setups combine, which agent to use): a copy goes stale and then
  contradicts the rule it copied.
- Paths and commands go stale: write the date and the commit they were checked at, and re-check a path before relying on it.
