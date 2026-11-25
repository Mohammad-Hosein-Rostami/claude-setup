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
    scripts/install.sh --no-tools       # skip tool dependency install (ui-check, env-names)

    scripts/install.sh --update --to <tag>        # rollback to a git tag (`git tag` lists them): links on a worktree of that tag; plain --update goes back
    scripts/install.sh --uninstall      # remove what the installer made, restore the backed-up files

Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Update [-To <tag>]] [-Uninstall] [-DryRun] [-NoPlugins] [-NoTools]`.
Both call `scripts/install.mjs`, the one installer (Node 22+, jq); `scripts/install/README.md` explains the install record, the backups and the first settings layer.
Symlinks need Developer Mode on Windows; otherwise items are copied (a warning is printed) and do not follow later
edits. `install.ps1` runs on Windows PowerShell 5.1 and 7 (not verified on Windows yet). On Windows the installer stops without Git Bash; `settings/windows.json` turns the PowerShell tool off (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`). `install.ps1 -ClaudeVersion <x.y.z>` installs that Claude Code, runs `claude --version` right after, and puts the old binary back when the version is not the one asked for.

The installer links `home/*` (rules, skills, agents, standards, hooks, tools, statusline.mjs, and `commands` when it has files) into
`~/.claude`, makes `personal/` from `personal.example/` when it is missing (git-ignored, its own git repo with a first commit),
links `~/.claude/project-notes` to `personal/project-notes`, and writes `~/.claude/CLAUDE.md` as a marker line plus
`@<repo>/home/CLAUDE.md` and `@<repo>/personal/CLAUDE.md`, builds `~/.claude/settings.json`, installs `home/tools/ui-check` dependencies (lockfile if present,
otherwise a plain install), unsets `core.hooksPath` when an earlier install set it to `.githooks`, writes `docs/catalog.md` (git-ignored; a problem in it is only a warning, and `node scripts/catalog.mjs write` rebuilds it), then installs plugins. Anything replaced is moved
to `~/.claude-backup-<stamp>/`, never deleted. One install runs at a time: a second one started meanwhile stops with a message. To check the result, ask `tess` for a setup check.
To check free disk space, run `node ~/.claude/tools/disk-free/disk-free.mjs check` (FAIL below 5 GB, WARN below 15 GB; `DISK_FAIL_FREE_GB` and `DISK_WARN_FREE_GB` move the limits); it names the caches to clear.

After the first install, fill your deny list: `personal/share-deny.txt` (git-ignored, in your own `personal/`) starts as an empty
template. Put one private word or phrase per line in it (your name, your employer, clients, project and machine names). Before each
commit, run `node scripts/share-check.mjs --staged` on the staged files and `node scripts/share-check.mjs --commit-msg <file>`
on the message (`CLAUDE.md` has the steps); a hit stops the commit. While the list is empty or holds only comments,
share-check prints `not run`. A list missing beside an existing `personal/` is an error that prints the `cp` line that
restores it from `personal.example/share-deny.txt`. Each person keeps their own list;
`node scripts/share-check.mjs` checks the tracked files against it.

## settings and local.json
`settings.json` = deep merge of `settings/base.json` + `settings/<macos|linux|windows>.json` + `settings/local.json`,
with `{{CLAUDE_HOME}}` replaced by the real path. Objects merge deeply; `hooks` lists are appended per event, so
`local.json` can add machine-only hooks without restating the shared ones. `settings/local.json` is gitignored and per
machine; copy `settings/local.json.example` to start. Its `claudeSetup` key is for the installer and the sync, never part of
`settings.json`: `machine` (this machine's name), `cliVersion` (the phase's pinned Claude Code; set with `DISABLE_UPDATES=1` in
`env`), `syncTargets` (`[{name, ssh}]`: the machines `scripts/sync-machines.mjs` brings along; none listed means `pc` over `ssh pc`) and `shared`
(the top-level keys of `local.json` the sync copies to every target; `env` and `claudeSetup` are never copied). Edits made through `/config` land only in the generated file: copy what you
want shared into `settings/*.json` and re-run the installer.
`env.BASH_DEFAULT_TIMEOUT_MS` is `"300000"` (milliseconds, 5 minutes; the CLI default is 120000): a Bash call that runs longer is moved to the background, and the longest test suite takes about 4 minutes. A call can ask for more with its own `timeout` (at most `BASH_MAX_TIMEOUT_MS`, 600000 by default).

## Sync the machines
Run on the machine you landed on, in the repo folder, after every land, also while other lanes are still open (the targets come from the script default and `claudeSetup.syncTargets`):
`node scripts/sync-machines.mjs --repo "$PWD"`. Add `--tag <tag>` to move the targets to a phase tag, `--targets <name,...>` to sync only
some, `--json` for one JSON row per machine (the old `--checks` is refused with exit 2).
- First it checks the base branch is checked out and no tracked file changed (exit 3 with `verify: <check> failed: <why>`). Open lanes do not stop it.
- Then every machine must run one Claude Code version and channel, at or above `CLAUDE_FLOOR` in `scripts/sync/cli-checks.mjs`, on the `cliVersion` pin of
  `settings/local.json`. A machine that does not is skipped and its row says why (a target still on an old checkout is checked again after its install).
- Each target gets a git bundle (`scp`), a fast-forward pull, the shared local values and `scripts/install.sh`. Each machine prints one line,
  `<machine>: synced sha <40-hex> install <exit>`. Nothing is pushed and no project repo on a target is touched. Every ssh line is printed before it runs.
- Exit 0: every machine synced (install exit 0, at the base tip); 1: a machine failed (rows printed); 2: bad arguments or a leftover `/tmp/<row>-sync-*.bundle`; 3: verify failed.

## FIGMA_TOKEN (for `figma-pull`)
Create a personal access token in Figma (Settings > Security) with read access to files. Keep it out of the repo,
`.env` files and shell history.
- macOS keychain: `security add-generic-password -a "$USER" -s figma-token -w` (prompts for the value), then in
  `~/.zshrc`: `export FIGMA_TOKEN="$(security find-generic-password -a "$USER" -s figma-token -w)"`.
- Any OS: export it from your shell profile (`~/.zshrc`, `~/.bashrc`, or the Windows Environment Variables dialog; `setx FIGMA_TOKEN <value>` also works but leaves the value in console history).
  Never print it; `ui-check` never logs it. Without a token use the MCP fallback in `docs/figma-pixel-perfect.md`.

## Plugins
`plugins/plugins.json` lists marketplaces and enabled/disabled plugins. The installer installs only the plugins that
`enabledPlugins` of the merged settings (`settings/base.json` < `<os>.json` < `local.json`) turns on: it runs
`claude plugin marketplace add` for the marketplaces those come from and `claude plugin install <id>` for each. A plugin
that is off is not installed; one installed earlier stays installed and off (nothing is uninstalled). To use an off
plugin in one project, turn it on in that project's settings and run `claude plugin install <id>` once. An unreadable
`plugins.json` or settings file stops the install with the reason; a plugin id that is not `name@marketplace` (letters,
digits, `.`, `_`, `-`) is refused. If the CLI lacks the plugin subcommands, use `/plugin` in Claude Code and install the
plugins the install output names. `gitkraken` is installed by the GitKraken app.

## Updating
`git pull`. Linked content (skills, agents, rules, standards, hooks, tools) is live on disk. Re-run `scripts/install.sh`
when `settings/`, `plugins/` or a tool's `package.json` changed.

A running Claude Code session reads settings, hooks config, CLAUDE.md, agents and plugins only at start: after any change,
restart open sessions (`/exit`, then `claude -c` to continue). Hook scripts run fresh on every call, so edits to a hook's
code apply at once.

## Reading .env files and lockfiles
Nothing blocks reading them: agents have full access, `settings/base.json` has no read rules, and `~/.ssh`, `~/.aws`, `*.pem` and `.npmrc` can be read too. Printing or committing a secret is still against the rules in `CLAUDE.md`, and the check by hand before a commit (gitleaks) looks for one.

## Questions
A question to you (AskUserQuestion) is Claude Code's own terminal question, with no popup. `askUserQuestionTimeout` (`"5m"` in `settings/base.json`; CLI 2.1.330 accepts only `60s`, `5m`, `10m`, `never`) auto-continues an unanswered one after 5 minutes, and Claude then takes the recommended option (`docs/daily-use.md`, "Long or unattended runs").

## No prompt before a dangerous rm
Bypass mode still asks before an `rm` Claude Code cannot rule out as dangerous. The installer adds `export CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1`, with a comment line, to `~/.zshenv` (zsh) or `~/.bashrc` (bash, Git Bash) and the PowerShell profile, which waives that prompt. Claude Code reads the variable only when it starts, so after the install or a sync start each session again from a new terminal. At start-up it then says the variable is set; if it says the variable "has no effect in this session", a PermissionRequest hook or a deny or ask rule on Bash, Edit or Read (from a project or a plugin) is turning the waiver off.
