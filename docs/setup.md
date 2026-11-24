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
edits. `install.ps1` runs on Windows PowerShell 5.1 and 7 (not verified on Windows yet). On Windows the installer stops without Git Bash; `settings/windows.json` turns the PowerShell tool off (`CLAUDE_CODE_USE_POWERSHELL_TOOL=0`) and every Bash hook matches `Bash|PowerShell`, so a PowerShell command is off or guarded; doctor checks both. `install.ps1 -ClaudeVersion <x.y.z>` installs that Claude Code, runs `claude --version` right after, and puts the old binary back when the version is not the one asked for.

The installer links `home/*` (rules, skills, agents, standards, hooks, tools, statusline.mjs, and `commands` when it has files) into
`~/.claude`, makes `personal/` from `personal.example/` when it is missing (git-ignored, its own git repo with a first commit),
links `~/.claude/project-notes` to `personal/project-notes`, and writes `~/.claude/CLAUDE.md` as a marker line plus
`@<repo>/home/CLAUDE.md` and `@<repo>/personal/CLAUDE.md`, builds `~/.claude/settings.json`, installs `home/tools/ui-check` dependencies (lockfile if present,
otherwise a plain install), sets `core.hooksPath` to `.githooks`, then installs plugins. Anything replaced is moved
to `~/.claude-backup-<stamp>/`, never deleted. One install runs at a time: a second one started meanwhile stops with a message. Check the result with `scripts/doctor.sh`
(`DOCTOR_PROJECT=/path/to/app scripts/doctor.sh` also checks Playwright and Chromium from that project). It also reports free disk space (FAIL below 5 GB, WARN below 15 GB; `DISK_FAIL_FREE_GB` and `DISK_WARN_FREE_GB` move the limits) and names the caches to clear. It never runs the repo's tests (an old `--quick` or `--full` is ignored).

After the first install, fill your deny list: `personal/share-deny.txt` (git-ignored, in your own `personal/`) starts as an empty
template. Put one private word or phrase per line in it (your name, your employer, clients, project and machine names). At each
commit `scripts/share-check.mjs` checks the staged files (pre-commit) and the message (commit-msg); a hit blocks the commit.
While the list is empty or holds only comments, share-check prints `not run` and `doctor.sh` gives one WARN. A list missing
beside an existing `personal/` blocks every commit and prints the `cp` line that restores it from
`personal.example/share-deny.txt`; `doctor.sh` FAILs with the same `cp`. Each person keeps their own list;
`node scripts/share-check.mjs` checks the tracked files against it.

## settings and local.json
`settings.json` = deep merge of `settings/base.json` + `settings/<macos|linux|windows>.json` + `settings/local.json`,
with `{{CLAUDE_HOME}}` replaced by the real path. Objects merge deeply; `hooks` lists are appended per event, so
`local.json` can add machine-only hooks without restating the shared ones. `settings/local.json` is gitignored and per
machine; copy `settings/local.json.example` to start. Its `claudeSetup` key is for the installer and the sync, never part of
`settings.json`: `machine` (this machine's name), `cliVersion` (the phase's pinned Claude Code; set with `DISABLE_UPDATES=1` in
`env`), `syncTargets` (`[{name, ssh}]`: the machines `scripts/sync-machines.mjs` brings along; none listed means `pc` over `ssh pc`) and `shared`
(the top-level keys of `local.json` the sync copies to every target; `env` and `claudeSetup` are never copied). Edits made through `/config` land only in the generated file: copy what you
want shared into `settings/*.json` and re-run the installer. `doctor.sh` reports drift.
`env.BASH_DEFAULT_TIMEOUT_MS` is `"300000"` (milliseconds, 5 minutes; the CLI default is 120000): a Bash call that runs longer is moved to the background, and the longest test suite takes about 4 minutes. A call can ask for more with its own `timeout` (at most `BASH_MAX_TIMEOUT_MS`, 600000 by default).

## Sync the machines
Run on the machine you landed on, in the repo folder, once after the last land (the targets come from the script default and `claudeSetup.syncTargets`):
`node scripts/sync-machines.mjs --repo "$PWD"`. Add `--tag <tag>` to move the targets to a phase tag, `--targets <name,...>` to sync only
some, `--json` for one JSON row per machine (the old `--checks` is refused with exit 2).
- First it checks the base branch is checked out, no tracked file changed and `git-tidy check` is clean (exit 3 with `verify: <check> failed: <why>`).
- Then every machine must run one Claude Code version and channel, at or above the floor in `scripts/doctor.sh`, on the `cliVersion` pin of
  `settings/local.json`. A machine that does not is skipped and its row says why (a target still on an old checkout is checked again after its install).
- Each target gets a git bundle (`scp`), a fast-forward pull, the shared local values and `scripts/install.sh`; then `scripts/doctor.sh` runs on each machine.
  Nothing is pushed and no project repo on a target is touched. Every ssh line is printed before it runs.
- Exit 0: every machine synced and doctor passed; 1: a machine failed (rows printed); 2: bad arguments or a leftover `/tmp/<row>-sync-*.bundle`; 3: verify failed.

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
Nothing blocks reading them: there are no `.env` or lockfile read rules in `settings/base.json` and `pre-bash-guard` does not inspect readers. Printing or committing a secret is still against the rules in `CLAUDE.md`; a literal secret typed into a Bash command asks nothing (owner decision R22-G1: the guard log names its kind, never the value), and gitleaks still checks every commit.

## Guard prompts and production hosts
`pre-bash-guard` and `artifact-ask` never block for good (the guard only sends a command back once when part of it can be rewritten, see `docs/daily-use.md`). A rule hit shows a native dialog (macOS `osascript`, Windows PowerShell popup with Yes = Allow / No = Deny, Linux `zenity`) with Allow as the default; with no answer in 2 min (`CLAUDE_ASK_TIMEOUT_S`, clamped to 190) it goes ahead, and only a click on Deny denies. Allow and a timeout return no decision (exit 0, logged): the CLI's normal permission flow then still runs, so `permissions.deny` rules apply and the rest of a compound command is not pre-approved (checked on CLI 2.1.323). A timeout only counts when the full time passed; a dialog that was killed, crashed or gave up early, no GUI (ssh, CI, no display) or a failing dialog tool falls back to the CLI's own prompt, which also appears in bypass-permissions mode. The hooks carry `timeout: 200` (seconds) in `settings/base.json`, above the dialog time. Separately, `askUserQuestionTimeout` (`"10m"` in `settings/base.json`; CLI 2.1.323 accepts only `60s`, `5m`, `10m`, `never`) auto-continues an unanswered terminal question after 10 minutes (long enough for four question dialogs of 2 minutes each, which `lib/question-reply.mjs` keeps inside that time).
What asks: `git push` (not `--dry-run`), `gh release *` (except list, view, download), `gh pr merge`, `npm`/`pnpm`/`yarn` publish, Artifact publish and delete, `ssh`/`scp`/`rsync`/`psql`/`mysql` writes to a production host, `git --no-verify`, `gh repo edit --visibility`, `gh secret set`, `gh workflow run`, a `gh api graphql` mutation, and a `$(...)`/backtick/heredoc/`eval`/`trap` command that also names a dangerous word ("risky word inside shell expansion"). Destructive ones say `DESTRUCTIVE: ...` (force push, remote branch delete, `rm -r` outside the project, disk wipes). Read-only ssh (cat, ls, tail, grep, systemctl status, docker ps/logs) is allowed. psql/mysql on a production host is allowed only for a statement that starts as a read (SELECT, SHOW, EXPLAIN, WITH ... SELECT, `\d`) and has no write-like word (INTO, COPY, DO, CALL, DROP, INSERT, UPDATE, DELETE, `pg_terminate_backend`, `lo_*`, `dblink*`, `setval`, `\!`, ...); the host is found in `-h`, `--host`, URLs, conninfo strings (`-d`, `--dbname`) and `PGHOST`.
The guard looks at every word of a command, not only the first: `ionice -c3 rm -rf /x`, `caffeinate -i git push`, `$'\x72m' -rf /x` (ANSI-C quoting is decoded), `X=rm; $X -rf /x` and `eval "$cmd"` all ask, with no wrapper list to maintain. Words after `echo`, `grep`, `man`, `git`, `docker run`, `ssh` and package managers are not scanned, so `echo rm -rf /` and `docker run img rm -rf /data` stay silent. Variables are tracked in order, the last assignment wins; `rm -r` of an unknown variable asks, `rm -f "$FILE"` does not.
A second, character-level parser runs behind the first (a reason only it found ends with "matched in raw text"), so quoting, comments, `$((1<<X))` and `<<EOF` inside quotes cannot hide `git push` or `rm -rf` (also inside `"$(...)"`). Commands that hide what runs always ask: `| bash`, `bash <<EOF`, `sh -s`, a variable or `$(...)` as the command word (`$EDITOR`, `$PAGER` and a variable assigned earlier to one word are fine), `env -S`, `su -c`; `pnpm exec`/`pnpm dlx`/`yarn exec`/`npx` are scanned for what they run, `npm run` is not. Brace expansion in `rm` paths is expanded (`rm -rf {/,x}`); one that cannot be listed asks. Prod SQL: any function call outside a list of plain read functions (`count`, `now`, `current_*` ...) counts as a write, and `PGSERVICE=prod` counts as a host.
Every ask and its outcome (allow, deny, timeout, no-gui, dialog-failed) is appended without secrets to `~/.claude/logs/guard.jsonl` (`CLAUDE_GUARD_LOG` overrides the path); the file is set to mode 0600 and its directory to 0700 on every write (a shared directory such as `$HOME` or the temp dir is left alone). Masked before logging: `-u user:pass` (curl-like commands), URL passwords (up to the last `@`), `Authorization:`/`X-*-Key:`/`X-*-Token:`/`Cookie:` header values, `--token`/`--api-key`/`--password`/`--secret`/`--client-secret` values, `NAME_TOKEN=`/`*_KEY=`/`*PASS=`/`*SECRET=` assignments, `?api_key=`/`?token=` query values, `redis-cli -a`, `PRIVATE-TOKEN:` headers and `_authToken=`.
Production hosts: any name containing `prod`, plus the private list `~/.claude/private/prod-hosts` (one name or `*` glob per line; never committed). Copy `settings/prod-hosts.example` to start; `doctor.sh` reports whether the list exists.

Doctor accepted list: `~/.claude/private/doctor-accepted` (or the file `CLAUDE_DOCTOR_ACCEPTED_FILE` names; one id per line, `#` starts a comment; never committed) lists machine facts you have seen and accept, so `doctor.sh` prints them as INFO, which its summary does not count, instead of WARN. Doctor knows the id `apple-terminal-notes` (Apple Terminal shows no desktop notes). Copy `settings/doctor-accepted.example` to start; delete a line you do not accept. Doctor only reads the file; without it every WARN stays a WARN. A list that is a link or not a plain file accepts nothing, and it or an id doctor does not know gives one WARN. The missing production-host list WARN can never be accepted.

