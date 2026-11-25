# scripts/install: the installer's parts

`scripts/install.mjs` is the one installer (macOS, Linux, Windows); `scripts/install.sh` and `scripts/install.ps1` only
find Node and call it. Its flags are in the header of `install.mjs`.

| file | what it does |
|---|---|
| `context.mjs` | flags, paths, the dry-run switch (`act`), the run log |
| `record.mjs` | the install record `~/.claude/.claude-setup-install.json`, backups into `~/.claude-backup-<stamp>/`, the install lock |
| `links.mjs` | `home/*` into `~/.claude` (Windows: folders as junctions, and a file link that is not allowed becomes a copy); removal of the links the install record names for the retired session modes (the launcher in `~/.local/bin` or `~/.claude/bin`, the `modes` link, the lead rule files `lead.md` and `lead-rules.md`) and the `workflows` link; a recorded copy, or the owner's own file or folder, at those paths goes to the backup folder (never deleted; the owner's with a WARNING) |
| `retired-state.mjs` | the one-time move, on every platform, of the stores the removed parts left in `~/.claude` (recall, ask queue, estimate, done-check, commit-gate, call windows, modes, last-seen, ui-proof-gate, stop-blocks, budget-denied, MCP discovery verdicts) into the backup folder, never a delete: only a real folder or file of the installing user at a known path, each move named in the install record (`backups` and `retiredState`), so `--uninstall` puts it back; a link is never followed, only named; `~/.claude/jobs` is Claude Code's and never listed |
| `personal.mjs` | the personal layer: runs the `personal/` steps, the `~/.claude/project-notes` link, the generated `~/.claude/CLAUDE.md` (and its removal on `--uninstall`) |
| `personal-folder.mjs` | `<repo>/personal/`: made from `personal.example/` as its own git repo, the owner's notes moved in from `home/project-notes` (and restored from git history when a pull deleted them), moved back on `--uninstall` |
| `startup.mjs` | the one `claude-as` start-up line: zsh (`~/.zshrc`) and bash (`~/.bashrc`) source `home/shell/claude-as.sh`, the PowerShell profile dot-sources `home/shell/claude-as.ps1`; an existing marked line is taken over and a second is never added |
| `rm-waiver.mjs` | `export CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1` under a why-comment line: zsh `~/.zshenv` (`$ZDOTDIR/.zshenv` when ZDOTDIR comes from the environment zsh starts in, not from `~/.zshenv`), bash `~/.bashrc` (Git Bash too), and `$env:...= '1'` in the PowerShell profile, so bypass mode runs a dangerous `rm` without a prompt. Claude Code reads the variable only at launch (not from settings `env`), so a running session needs a restart from a new terminal. A file that holds the two lines already gets no copy; a variable line of your own gets none either and is left out of the record, so `--uninstall` takes out only the installer's two lines and leaves the file byte for byte as it was |
| `settings.mjs` | `settings.json` from the layers, through `scripts/merge-settings.jq`: the machine's own earlier settings (first layer, new machine only), then `settings/base.json`, `<os>.json` and `local.json` |
| `tools.mjs` | the plugins the merged settings turn on, and the dependencies of `ui-check`, `env-names` and `long-run`; a tool is installed again only when its lockfile or the Node ABI changed: the stamp `node_modules/.lock-sha256` is `<sha256>:<ABI>` |
| `pin.mjs` | `--update --to <tag>`: a detached worktree of the tag at `~/.claude-setup-at/<tag>` |
| `uninstall.mjs` | `--uninstall`: undo what the record names and restore the backups from `~/.claude-backup-<stamp>/`, then list what it left in place (a backup whose path exists again, a link or written file you changed, a folder that is not empty) |
| `windows.mjs` | Windows only: Git Bash must be there (the install stops without it), the user PATH |
| `cli.mjs` | `--claude-version`: install the pinned Claude Code (2.1.326 or newer), run `claude --version` right after, and restore the old binary when it is not that version |
| `local-settings.mjs` | `claudeSetup` of `settings/local.json` for the sync: targets, CLI pin, shared values |

How it behaves:
- A second run changes nothing: a link that is right stays, an unchanged `settings.json` is not written, the record is
  rewritten only when it changes.
- One install at a time: `~/.claude/.claude-setup-install.lock` (O_EXCL, with the pid) is held from loading the record to
  saving it, and by `--uninstall` until its record is removed; a second run exits 1. A lock whose process ended is taken over
  at once; one with no pid in it only after 30 minutes. A lock whose process still runs is never taken over, however old:
  past 30 minutes the refusal names the pid and the lock path (the install may be hung: end that process, or delete the
  lock file by hand when the pid is not an install).
- Nothing is deleted that the installer did not make. A file in the way is moved to the backup folder and named in the
  record; `--uninstall` puts it back and removes the rest, so the file list is as before the first install.
- `~/.claude/CLAUDE.md` is a file the installer writes, not a link: a marker line, then `@<repo>/home/CLAUDE.md` (the shared
  core) and, while it exists, `@<repo>/personal/CLAUDE.md` (yours); paths use forward slashes on every OS. A later run or
  `--uninstall` treats it as the installer's own only while its whole text is what the installer last wrote (the sha256 in
  the record's `written` list; a file that keeps the marker line but has your own lines added is yours: backed up before a
  re-install replaces it, left in place by `--uninstall`). It is listed apart from `made` because an older uninstaller
  deletes every `made` entry of a kind it does not know. An older install's link into
  `home/` is replaced without a backup, anything else there is backed up first. A repo path an import line cannot carry (a
  space, `@`, `#`, a quote, a non-ASCII letter) stops the install with exit 1 before anything changes.
- `personal/` (git-ignored by the core repo) is made from `personal.example/` when missing and made its own git repo with a
  first commit, so `git clean -fdx` in the clone skips it and it has a history to sync; an existing one is never overwritten
  (only `git init` with a first commit, when it is no repo yet, and a missing `project-notes/` folder are added). The
  installer's commits use your git name and email, else `claude-setup install`. `~/.claude/project-notes` links to
  `personal/project-notes`. On the layer's first install on a machine (`~/.claude/project-notes` not yet linked there), the
  owner's notes are moved there and committed: those in `home/project-notes` that git does not track, and those a pull
  deleted there before this install ran (restored first from the newest commit this checkout's HEAD was at that held them:
  its reflog and `ORIG_HEAD`, so a fresh clone recovers nothing). A name already taken sends the core copy to the backup
  folder. Later installs move nothing, so a shared note not yet committed in `home/project-notes` stays in core.
  `--uninstall` moves the moved notes back and keeps `personal/`. A `.personal-*` copy of the template that a stopped
  install left is removed by the next install once it is older than 30 minutes (a running install's copy is seconds old).
  An install from a linked git worktree (a lane, or a test there with a temp HOME) skips all of this and the
  `~/.claude/project-notes` link, and writes `~/.claude/CLAUDE.md` with the core import only: `personal/` belongs to the
  main checkout, and one in a lane would keep `land` from removing its worktree.
- New machine (no record, its own `settings.json`, `~/.claude/CLAUDE.md` neither the installer's marker file nor linked into
  this repo): that `settings.json` is kept as the first, lowest layer under `settings/base.json`, `settings/<os>.json` and
  `settings/local.json`.
- Rollback: `--update --to <tag>` moves only the links (to the tag's worktree); the checkout and main stay as they are,
  and every running session reads the tag's `home/` from its next file read. A plain `--update` points them back.
- `settings/local.json` (git-ignored; `settings/local.json.example`) holds the machine's own values; its `claudeSetup`
  key is for the installer and the sync, and `merge-settings.jq` drops it from `settings.json`.
