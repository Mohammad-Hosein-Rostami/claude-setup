# scripts/install: the installer's parts

`scripts/install.mjs` is the one installer (macOS, Linux, Windows); `scripts/install.sh` and `scripts/install.ps1` only
find Node and call it. Its flags are in the header of `install.mjs`.

| file | what it does |
|---|---|
| `context.mjs` | flags, paths, the dry-run switch (`act`), the run log |
| `record.mjs` | the install record `~/.claude/.claude-setup-install.json`, backups into `~/.claude-backup-<stamp>/`, the install lock |
| `links.mjs` | `home/*` into `~/.claude`, removal of the retired mode launcher, `modes`, `workflows`, `lead.md` and `lead-rules.md` links (a copy or the owner's own file there goes to the backup folder) |
| `retired-state.mjs` | the one-time removal of the stores the removed parts left in `~/.claude` (recall, ask queue, estimate, done-check, commit-gate, call windows, modes, last-seen, ui-proof-gate): only a real folder or file of the installing user at a known path, each removal noted in the install record (`retiredState`); a link is never followed, only named |
| `personal.mjs` | the personal layer: runs the `personal/` steps, the `~/.claude/project-notes` link, the generated `~/.claude/CLAUDE.md` (and its removal on `--uninstall`) |
| `personal-folder.mjs` | `<repo>/personal/`: made from `personal.example/` as its own git repo, the owner's notes moved in from `home/project-notes` (and restored from git history when a pull deleted them), moved back on `--uninstall` |
| `startup.mjs` | the one `claude-as` start-up line (zsh, bash, PowerShell profile) |
| `settings.mjs` | `settings.json` from the layers, through `scripts/merge-settings.jq` |
| `tools.mjs` | plugins and tool dependencies |
| `pin.mjs` | `--update --to <tag>`: a detached worktree of the tag at `~/.claude-setup-at/<tag>` |
| `uninstall.mjs` | `--uninstall`: undo what the record names |
| `windows.mjs` | Windows only: Git Bash must be there, the user PATH |
| `cli.mjs` | `--claude-version`: install the pinned Claude Code, prove it answers, else restore the old binary |
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
- New machine (no record, its own `settings.json`, `~/.claude/CLAUDE.md` neither the installer's marker file nor linked into
  this repo): that `settings.json` is kept as the first, lowest layer under `settings/base.json`, `settings/<os>.json` and
  `settings/local.json`.
- Rollback: `--update --to <tag>` moves only the links (to the tag's worktree); the checkout and main stay as they are,
  and every running session reads the tag's `home/` from its next file read. A plain `--update` points them back.
- `settings/local.json` (git-ignored; `settings/local.json.example`) holds the machine's own values; its `claudeSetup`
  key is for the installer and the sync, and `merge-settings.jq` drops it from `settings.json`.
