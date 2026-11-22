# scripts/install: the installer's parts

`scripts/install.mjs` is the one installer (macOS, Linux, Windows); `scripts/install.sh` and `scripts/install.ps1` only
find Node and call it. Its flags are in the header of `install.mjs`.

| file | what it does |
|---|---|
| `context.mjs` | flags, paths, the dry-run switch (`act`), the run log |
| `record.mjs` | the install record `~/.claude/.claude-setup-install.json`, backups into `~/.claude-backup-<stamp>/`, the install lock |
| `links.mjs` | `home/*` into `~/.claude`, removal of the retired mode launcher, `modes` and `workflows` links (a copy or the owner's own file there goes to the backup folder) |
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
- New machine (no record, its own `settings.json`, `~/.claude/CLAUDE.md` not linked into this repo): that `settings.json`
  is kept as the first, lowest layer under `settings/base.json`, `settings/<os>.json` and `settings/local.json`.
- Rollback: `--update --to <tag>` moves only the links (to the tag's worktree); the checkout and main stay as they are,
  and every running session reads the tag's `home/` from its next file read. A plain `--update` points them back.
- `settings/local.json` (git-ignored; `settings/local.json.example`) holds the machine's own values; its `claudeSetup`
  key is for the installer and the sync, and `merge-settings.jq` drops it from `settings.json`.
