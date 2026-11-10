# claude-setup

Portable Claude Code setup: global rules, skills, agents, standards, hooks, status line, settings and plugin list.
Managed content lives in `home/` and is symlinked into `~/.claude`, so edits made in `~/.claude` land in this repo
automatically. `settings.json` is generated (Claude and `/config` write to it and it holds machine paths).

## Install

macOS / Linux (needs `jq`; `brew bundle --file tools/Brewfile` installs the tools):

    scripts/install.sh --dry-run     # preview, changes nothing
    scripts/install.sh               # links, settings.json, plugins
    scripts/install.sh --no-plugins  # skip the `claude plugin` calls

Windows (PowerShell; symlinks need Developer Mode, otherwise files are copied and a warning is printed, and copies
will not follow later edits):

    powershell -ExecutionPolicy Bypass -File tools\windows-tools.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-NoPlugins]

Existing targets are moved to `~/.claude-backup-<YYYYMMDD-HHMMSS>/`, never deleted. `scripts/doctor.sh` reports
links, settings drift, plugins and tools. `install.ps1` is untested (written on a Mac).

## Daily workflow

Edit in `~/.claude` (or in `home/`, same files) -> `git commit` -> `git push`. On another machine: `git pull`, then
re-run the installer (needed only when `settings/` or `plugins/` changed; linked content updates on pull).
Changes made through `/config` live only in the generated `settings.json`; copy them into `settings/*.json` if you
want them shared. Per-machine overrides go in `settings/local.json` (gitignored; see `local.json.example`, which
holds `skipDangerousModePermissionPrompt`).

Settings = deep merge of `settings/base.json` + `settings/<macos|linux|windows>.json` + `settings/local.json`, then
`{{CLAUDE_HOME}}` is replaced by the real `~/.claude` path (forward slashes on Windows). Not carried over on purpose:
`theme`, `tui`, `autoUpdatesChannel`, `extraKnownMarketplaces` (per-machine).

## Plugins

`plugins/plugins.json` lists marketplaces and enabled/disabled plugins. `anthropic-plugin-directory` is built into
Claude Code (not in `known_marketplaces.json`), so it needs no `marketplace add`. `claude-plugins-official` is
`github:anthropics/claude-plugins-official`. `gitkraken` is installed by the GitKraken app (optional; not copied).
Install uses `claude plugin marketplace add <source>` and `claude plugin install <plugin@marketplace>`. If the CLI
lacks these, use `/plugin` manually.

## Excluded and why

History, projects, sessions, todos, `plugins/cache`, `plugins/marketplaces`, `policy-limits*`, `remote-settings*`,
`~/.claude.json`: machine/account state, large, or private. Credentials, `.env`, `daemon/ jobs/ state/ tasks/`,
`*.bak`: secrets or runtime state. A `gitleaks protect --staged` pre-commit hook (`.githooks/`) guards commits; the
installers set `core.hooksPath` when run inside the repo.

## Token optimisation

- **Env vars** (`settings/base.json`): `MAX_MCP_OUTPUT_TOKENS=15000` and `BASH_MAX_OUTPUT_LENGTH=12000` cap tool
  output that gets re-read on every call; `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` sets the compaction window;
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` removes survey noise.
- **Autocompact**: `autoCompactContext: true` compacts before the context grows costly.
- **Subagent models**: `subagents` pins `general-purpose` to Sonnet and `architect` to Opus; other agents in
  `home/agents/` pin their own model (scout/runner on Haiku).
- **Effort levels**: `modelSettings` sets Opus high, Sonnet medium, Haiku low.
- **Token-audit hook**: `home/hooks/token-audit.mjs` (used by the `token-audit` skill) prints the approximate
  recurring token cost (bytes/4) of the config visible from the current directory. Read-only.
- **Status line**: `home/statusline.mjs` shows model tier, effort, context size in tokens (green < 60k, yellow
  < 150k, red above), session cost and 5h usage. It reads only the JSON Claude passes on stdin; it does not call
  `ccusage` (checked), so nothing extra needs installing.
- **Model routing**: `home/CLAUDE.md` holds the policy: Opus plans, Sonnet implements, Haiku does lookups and runs;
  Opus hands Sonnet a spec by file path.

## Path placeholder

Machine paths never appear in the repo; `{{CLAUDE_HOME}}` stands for e.g. `/Users/you/.claude` or `C:/Users/you/.claude`.
