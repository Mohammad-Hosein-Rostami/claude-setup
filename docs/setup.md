# Setup on a new machine

## Prerequisites
- `git` (on Windows, Git for Windows, which also provides Git Bash), Node 22 (volta recommended), `jq`, `ripgrep`, `gitleaks`, `gh`, the `claude` CLI.
- macOS: `brew bundle --file tools/Brewfile`. Windows: `powershell -ExecutionPolicy Bypass -File tools\windows-tools.ps1`
  (winget). Linux: install the same tools with your package manager.
- A target project with `@playwright/test` and Chromium (`npx playwright install chromium`) if you use `ui-check`.

## Install
    git clone <repo> ~/Desktop/claude-setup && cd ~/Desktop/claude-setup
    scripts/install.sh --dry-run        # preview
    scripts/install.sh                  # macOS, Linux, Git Bash
    scripts/install.sh --no-plugins     # skip `claude plugin` calls
    scripts/install.sh --no-tools       # skip ui-check dependency install

Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-NoPlugins] [-NoTools]`.
Symlinks need Developer Mode on Windows; otherwise items are copied (a warning is printed) and do not follow later
edits. `install.ps1` also installs `ccm.cmd` into `~/.claude/bin` (launch with `ccm <mode>`, no execution-policy change needed) and `ccm.ps1` into `~/.claude/bin/ps/` (called by the shim; kept off PATH so PowerShell cannot pick it before the shim), and adds `~/.claude/bin` to the user PATH. `install.ps1` runs on Windows PowerShell 5.1 and 7 (it has not been run on Windows yet).

The installer links `home/*` (CLAUDE.md, rules, skills, agents, standards, hooks, tools, modes, project-notes, statusline.mjs, and `commands` when it has files) into
`~/.claude` (macOS/Linux/Git Bash also put `ccm` in `~/.local/bin`; keep it on PATH), builds `~/.claude/settings.json`, installs `home/tools/ui-check` dependencies (lockfile if present,
otherwise a plain install), sets `core.hooksPath` to `.githooks`, then installs plugins. Anything replaced is moved
to `~/.claude-backup-<stamp>/`, never deleted. Check the result with `scripts/doctor.sh`
(`DOCTOR_PROJECT=/path/to/app scripts/doctor.sh` also checks Playwright and Chromium from that project).

## settings and local.json
`settings.json` = deep merge of `settings/base.json` + `settings/<macos|linux|windows>.json` + `settings/local.json`,
with `{{CLAUDE_HOME}}` replaced by the real path. Objects merge deeply; `hooks` lists are appended per event, so
`local.json` can add machine-only hooks without restating the shared ones. `settings/local.json` is gitignored and per
machine; copy `settings/local.json.example` to start. Edits made through `/config` land only in the generated file: copy what you
want shared into `settings/*.json` and re-run the installer. `doctor.sh` reports drift.

## FIGMA_TOKEN (for `figma-pull`)
Create a personal access token in Figma (Settings > Security) with read access to files. Keep it out of the repo,
`.env` files and shell history.
- macOS keychain: `security add-generic-password -a "$USER" -s figma-token -w` (prompts for the value), then in
  `~/.zshrc`: `export FIGMA_TOKEN="$(security find-generic-password -a "$USER" -s figma-token -w)"`.
- Any OS: export it from your shell profile (`~/.zshrc`, `~/.bashrc`, or the Windows Environment Variables dialog; `setx FIGMA_TOKEN <value>` also works but leaves the value in console history).
  Never print it; `ui-check` never logs it. Without a token use the MCP fallback in `docs/figma-pixel-perfect.md`.

## Plugins
`plugins/plugins.json` lists marketplaces and enabled/disabled plugins; the installer runs `claude plugin marketplace
add` and `claude plugin install`. If the CLI lacks those subcommands, use `/plugin` in Claude Code and add what the
file lists. `gitkraken` is installed by the GitKraken app.

## Updating
`git pull`. Linked content (skills, agents, rules, standards, hooks, tools, modes) is live on disk. Re-run `scripts/install.sh`
when `settings/`, `plugins/` or a tool's `package.json` changed.

A running Claude Code session reads settings, hooks config, CLAUDE.md, agents and plugins only at start: after any change,
restart open sessions (`/exit`, then `claude -c` to continue). Hook scripts run fresh on every call, so edits to a hook's
code apply at once.

## Reading .env files and lockfiles
Nothing blocks reading them: there are no `.env` or lockfile read rules in `settings/base.json` and `pre-bash-guard` does not inspect readers. Printing or committing a secret is still against the rules in `CLAUDE.md`; a literal secret typed into a Bash command is denied.

## Outward actions and production hosts
`pre-bash-guard` asks for confirmation, even in bypass-permissions mode, before `git push` (not `--dry-run`), `gh release *` (except list, view, download), `gh pr merge`, `npm`/`pnpm`/`yarn` publish, and `ssh`/`scp`/`rsync`/`psql`/`mysql` that write to a production host; `artifact-ask` does the same for Artifact publish and delete. Read-only ssh (cat, ls, tail, grep, systemctl status, docker ps/logs, SELECT) is allowed.
Production hosts: any name containing `prod`, plus the private list `~/.claude/private/prod-hosts` (one name or `*` glob per line; never committed). Copy `settings/prod-hosts.example` to start; `doctor.sh` reports whether the list exists.

