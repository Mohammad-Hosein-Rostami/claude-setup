# claude-setup

Portable Claude Code setup: global rules, skills, agents, standards, hooks, tools, status line, settings and plugin
list. Managed content lives in `home/` and is symlinked into `~/.claude`, so edits made in `~/.claude` land in this
repo. `settings.json` is generated from `settings/` (it holds machine paths).

## Contents
| Path | What |
| ---- | ---- |
| `home/CLAUDE.md` | Model routing and token discipline |
| `home/rules`, `home/standards` | One-line rules (path-scoped) and the longer reference behind them |
| `home/skills`, `home/agents` | Skills and subagents (the Opus session plans, decides and delegates; Sonnet implements; Opus reviews risky changes; Haiku looks up and runs) |
| `home/hooks`, `home/statusline.mjs` | Bash guard, post-edit formatter, token audit, status line |
| `home/tools/ui-check` | Figma baseline pull, visual compare, responsive and column checks |
| `settings/`, `plugins/` | Settings layers (base, OS, local) and the plugin list |
| `home/lead-rules.md`, `home/lead.md` | The lead's rules, printed to the main session at start |
| `tests/`, `tools/`, `.githooks` | Repo tests (`node:test`), Brewfile and Windows tool script, pre-commit (gitleaks, `node --check` of hook files) |
| `scripts/` | `install.mjs` (the one installer; `install/`), `install.sh`, `install.ps1`, `doctor.sh`, `doctor-accounts.mjs`, `lane-new.sh`, `merge-settings.jq` |

## Quick start
Install on a new machine (macOS or Linux; needs git, Node 22+ and jq), in the folder you keep repos in:

    git clone <this repo> claude-setup && cd claude-setup
    scripts/install.sh               # links, start-up line, settings.json (your own kept as the first layer), plugins, tool deps
    scripts/doctor.sh                # read-only health report (never runs the repo tests)

Update, roll back, remove, sync:

    git pull --ff-only && scripts/install.sh --update   # update (safe to repeat: a second run changes nothing)
    scripts/install.sh --update --to <tag>              # roll back to a git tag (`git tag` lists them); plain --update comes back
    scripts/install.sh --uninstall                      # remove what the installer made, restore the backups
    node scripts/sync-machines.mjs --repo "$PWD"         # sync the machines in settings/local.json (bundle + ff-only pull, never a push); run it on the MacBook in this folder

`scripts/install.sh --dry-run` previews any of these. The sync targets, the phase's CLI pin and the values the sync copies
to every machine live in the git-ignored `settings/local.json` under `claudeSetup` (see `settings/local.json.example`).

Day-to-day use (starting a session, long runs, limits, another machine): [docs/daily-use.md](docs/daily-use.md).

Start a session: `claude --model <m> --effort <e>`, for example `claude --model opus --effort high` (see [docs/daily-use.md](docs/daily-use.md)).

Run tests (the second needs the ui-check deps that `install.sh` installs):

    node --test tests/*.test.mjs
    pnpm --dir home/tools/ui-check test

The done-check runs the tests that relate to your change when an agent or the session stops, and `land-lane` runs it again when a lane lands. The commit hook and a push run no tests; run the whole suite by hand when you want to know everything still works.

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Update [-To <tag>]] [-Uninstall]` (not verified on Windows yet). Needs git (Git for Windows).
Existing targets are moved to
`~/.claude-backup-<stamp>/`, never deleted. A gitleaks pre-commit hook guards commits.

Pixel-exact Figma work: pull once, build, compare, fix, check responsive:

    node ~/.claude/tools/ui-check/cli.mjs figma-pull --file KEY --node 12:34
    node ~/.claude/tools/ui-check/cli.mjs compare --url URL --root SEL --cache DIR --map map.json

## Docs
- [How this setup works](docs/how-it-works.md): folders, prompt flow, switching a hook off, reading the guard log; no AI needed
- [Setup on a new machine](docs/setup.md): install, `local.json`, `FIGMA_TOKEN`, plugins, updating
- [Editing the setup](docs/usage.md): edit, commit, push, pull; add a skill, agent, rule or tool
- [Catalog](docs/catalog.md): every skill, agent, rule, standard, hook, tool, plugin and settings key
- [Figma pixel-perfect workflow](docs/figma-pixel-perfect.md): exact commands and an example `map.json`
- [Token optimisation](docs/token-optimization.md)
- [Troubleshooting](docs/troubleshooting.md)
- [ui-check README](home/tools/ui-check/README.md)

Not carried over on purpose: history, projects, sessions, todos, plugin caches, credentials, `.env`, runtime state,
and per-machine `theme`, `tui`, `autoUpdatesChannel`, `extraKnownMarketplaces`.
