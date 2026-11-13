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

## Guard prompts and production hosts
`pre-bash-guard` and `artifact-ask` never hard-block. A rule hit shows a native dialog (macOS `osascript`, Windows PowerShell popup with Yes = Allow / No = Deny, Linux `zenity`) with Allow as the default; with no answer in 180 s (`CLAUDE_ASK_TIMEOUT_S`, clamped to 190) it goes ahead, and only a click on Deny denies. Allow and a timeout return no decision (exit 0, logged): the CLI's normal permission flow then still runs, so `permissions.deny` rules apply and the rest of a compound command is not pre-approved (checked on CLI 2.1.323). A timeout only counts when the full time passed; a dialog that was killed, crashed or gave up early, no GUI (ssh, CI, no display) or a failing dialog tool falls back to the CLI's own prompt, which also appears in bypass-permissions mode. The hooks carry `timeout: 200` (seconds) in `settings/base.json`, above the dialog time. Separately, `askUserQuestionTimeout` (`"5m"` in `settings/base.json`; CLI 2.1.323 accepts only `60s`, `5m`, `10m`, `never`) auto-continues an unanswered terminal question after 5 minutes.
What asks: `git push` (not `--dry-run`), `gh release *` (except list, view, download), `gh pr merge`, `npm`/`pnpm`/`yarn` publish, Artifact publish and delete, `ssh`/`scp`/`rsync`/`psql`/`mysql` writes to a production host, `git --no-verify`, hand-edited lockfiles, and a literal secret in a command ("contains a literal password/token"; the dialog shows it masked), `gh repo edit --visibility`, `gh secret set`, `gh workflow run`, a `gh api graphql` mutation, and a `$(...)`/backtick/heredoc/`eval`/`trap` command that also names a dangerous word ("risky word inside shell expansion"). Destructive ones say `DESTRUCTIVE: ...` (force push, remote branch delete, `rm -r` outside the project, disk wipes). Read-only ssh (cat, ls, tail, grep, systemctl status, docker ps/logs) is allowed. psql/mysql on a production host is allowed only for a statement that starts as a read (SELECT, SHOW, EXPLAIN, WITH ... SELECT, `\d`) and has no write-like word (INTO, COPY, DO, CALL, DROP, INSERT, UPDATE, DELETE, `pg_terminate_backend`, `lo_*`, `dblink*`, `setval`, `\!`, ...); the host is found in `-h`, `--host`, URLs, conninfo strings (`-d`, `--dbname`) and `PGHOST`.
The guard looks at every word of a command, not only the first: `ionice -c3 rm -rf /x`, `caffeinate -i git push`, `$'\x72m' -rf /x` (ANSI-C quoting is decoded), `X=rm; $X -rf /x` and `eval "$cmd"` all ask, with no wrapper list to maintain. Words after `echo`, `grep`, `man`, `git`, `docker run`, `ssh` and package managers are not scanned, so `echo rm -rf /` and `docker run img rm -rf /data` stay silent. Variables are tracked in order, the last assignment wins; `rm -r` of an unknown variable asks, `rm -f "$FILE"` does not.
A second, character-level parser runs behind the first (a reason only it found ends with "matched in raw text"), so quoting, comments, `$((1<<X))` and `<<EOF` inside quotes cannot hide `git push` or `rm -rf` (also inside `"$(...)"`). Commands that hide what runs always ask: `| bash`, `bash <<EOF`, `sh -s`, a variable or `$(...)` as the command word (`$EDITOR`, `$PAGER` and a variable assigned earlier to one word are fine), `env -S`, `su -c`; `pnpm exec`/`pnpm dlx`/`yarn exec`/`npx` are scanned for what they run, `npm run` is not. Brace expansion in `rm` paths is expanded (`rm -rf {/,x}`); one that cannot be listed asks. Prod SQL: any function call outside a list of plain read functions (`count`, `now`, `current_*` ...) counts as a write, and `PGSERVICE=prod` counts as a host.
Every ask and its outcome (allow, deny, timeout, no-gui, dialog-failed) is appended without secrets to `~/.claude/logs/guard.jsonl` (`CLAUDE_GUARD_LOG` overrides the path); the file is set to mode 0600 and its directory to 0700 on every write (a shared directory such as `$HOME` or the temp dir is left alone). Masked before logging: `-u user:pass` (curl-like commands), URL passwords (up to the last `@`), `Authorization:`/`X-*-Key:`/`X-*-Token:`/`Cookie:` header values, `--token`/`--api-key`/`--password`/`--secret`/`--client-secret` values, `NAME_TOKEN=`/`*_KEY=`/`*PASS=`/`*SECRET=` assignments, `?api_key=`/`?token=` query values, `redis-cli -a`, `PRIVATE-TOKEN:` headers and `_authToken=`.
Production hosts: any name containing `prod`, plus the private list `~/.claude/private/prod-hosts` (one name or `*` glob per line; never committed). Copy `settings/prod-hosts.example` to start; `doctor.sh` reports whether the list exists.

