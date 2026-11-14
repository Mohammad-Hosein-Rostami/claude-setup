# claude-setup

Portable Claude Code setup: global rules, skills, agents, standards, hooks, tools, status line, settings and plugin
list. Managed content lives in `home/` and is symlinked into `~/.claude`, so edits made in `~/.claude` land in this
repo. `settings.json` is generated from `settings/` (it holds machine paths).

## Contents
| Path | What |
| ---- | ---- |
| `home/CLAUDE.md` | Model routing and token discipline |
| `home/rules`, `home/standards` | One-line rules (path-scoped) and the longer reference behind them |
| `home/skills`, `home/agents` | Workflows and subagents (the Opus session plans, decides and delegates; Sonnet implements and reviews; Haiku looks up and runs) |
| `home/hooks`, `home/statusline.mjs` | Bash guard, post-edit checks, token audit, status line |
| `home/tools/ui-check` | Figma baseline pull, visual compare, responsive and column checks |
| `settings/`, `plugins/` | Settings layers (base, OS, local) and the plugin list |
| `home/modes`, `home/bin/ccm` | Mode playbooks and the `ccm` launcher (`ccm.cmd` / `ccm.ps1` on Windows) |
| `tests/`, `tools/`, `.githooks` | Repo tests (`node:test`), Brewfile and Windows tool script, pre-commit (gitleaks, tests) |
| `scripts/` | `install.sh`, `install.ps1`, `doctor.sh`, `merge-settings.jq` |

## Quick start
    scripts/install.sh --dry-run     # preview, changes nothing
    scripts/install.sh               # links, settings.json, ui-check deps, plugins
    scripts/doctor.sh                # read-only health report

Day-to-day use (modes, long runs, limits, another machine): [docs/daily-use.md](docs/daily-use.md).

Launch a mode: `ccm [normal|medium|high|extra-high|ultra-high]` (see [docs/modes.md](docs/modes.md)).

Run tests (the second needs the ui-check deps that `install.sh` installs):

    node --test tests/*.test.mjs
    pnpm --dir home/tools/ui-check test

Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. It also puts `ccm.cmd` and `ccm.ps1` in `~/.claude/bin` and adds that folder to your user PATH. Needs git (Git for Windows).
Existing targets are moved to
`~/.claude-backup-<stamp>/`, never deleted. A gitleaks pre-commit hook guards commits.

Pixel-exact Figma work: pull once, build, compare, fix, check responsive:

    node ~/.claude/tools/ui-check/cli.mjs figma-pull --file KEY --node 12:34
    node ~/.claude/tools/ui-check/cli.mjs compare --url URL --root SEL --cache DIR --map map.json

## Docs
- [Setup on a new machine](docs/setup.md): install, `local.json`, `FIGMA_TOKEN`, plugins, updating
- [Daily use](docs/usage.md): edit, commit, push, pull; add a skill, agent, rule or tool
- [Catalog](docs/catalog.md): every skill, agent, rule, standard, hook, tool, plugin and settings key
- [Figma pixel-perfect workflow](docs/figma-pixel-perfect.md): exact commands and an example `map.json`
- [Modes](docs/modes.md): `ccm normal|medium|high|extra-high|ultra-high` and `/mode <m>`
- [Token optimisation](docs/token-optimization.md)
- [Troubleshooting](docs/troubleshooting.md)
- [ui-check README](home/tools/ui-check/README.md)

Not carried over on purpose: history, projects, sessions, todos, plugin caches, credentials, `.env`, runtime state,
and per-machine `theme`, `tui`, `autoUpdatesChannel`, `extraKnownMarketplaces`.
