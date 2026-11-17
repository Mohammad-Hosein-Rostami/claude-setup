# disk-free

An early, plain signal before the disk fills up. A full disk makes every agent and build fail with `ENOSPC` and no clear cause.
Node 22, no dependencies (it uses `df` and `du`). It only reads: it never deletes anything.

Run: `node ~/.claude/tools/disk-free/disk-free.mjs check [--path <dir>]` (default path: `$HOME`)

It prints one line and exits:

| Free space | Line starts with | Exit |
| ---------- | ---------------- | ---- |
| below 5 GB (`DISK_FAIL_FREE_GB`) | `FAIL` | 1 |
| below 15 GB (`DISK_WARN_FREE_GB`) | `WARN` | 0 |
| otherwise | `ok` | 0 |

A bad threshold, text that is not `df` output or a wrong command exits 2 with a message on stderr. The warn value must not be below the fail value.

On `WARN` and `FAIL` the line names up to three of the biggest rebuildable caches that exist on the machine, largest first, each with the
size, the folder and how to clear it: Xcode DerivedData, CoreSimulator, `~/Library/Caches`, the npm cache, the pnpm store, and the old claude
session folders (`/private/tmp/claude-<uid>` on macOS, `/tmp/claude-<uid>` elsewhere). Measuring all folders together is limited to 30 seconds (so a WARN never outlasts the runner's 120 s limit); a folder not measured in time is still
named, with "size not measured in time". The Docker builder cache has no folder, so it is always named last (`docker builder prune`).

## Where it runs

- `scripts/doctor.sh` (`check_disk_free`): `FAIL` makes doctor exit 1, `WARN` is a warning.
- The first step of the `land` and `build` workflows (`home/workflows`): below the fail threshold they stop before any git or agent work and
  return the line above as the reason. A check that could not run (exit 2) refuses too, so a broken check never lets a build start unseen.

## Test hooks

`DISK_FREE_DF_OUTPUT` replaces the `df -Pk` text, `DISK_FREE_CLAUDE_TMP` the session-folder root and `DISK_FREE_DU_TIMEOUT_MS` the 30 s
total measuring limit. Tests: `tests/disk-free.test.mjs`, `tests/doctor-disk.test.mjs`.

## disk-clean: removing what piles up

`disk-free` only reads. `disk-clean.mjs` removes (dry run unless `--apply`):

`node ~/.claude/tools/disk-free/disk-clean.mjs [--apply] [--json] [--session <id>] [--scan-ms <n>]`

| Rule | What goes | When |
| ---- | --------- | ---- |
| session folders | `/private/tmp/claude-<uid>/<project>/<session-id>/` (scratchpads of agent runs, copies of repos) | the session is not running, its transcript (`~/.claude/projects/*/<session-id>.jsonl`) was not modified for 3 days or there is none, and nothing inside the folder was modified for 3 days |
| test temp | folders in `os.tmpdir()` named `cs-test-*` (label plus 6 random characters), `cs-run-*` (6 characters), or an old test prefix plus 6 random characters (`lib/test-temp-prefixes.mjs`, only specific two-word-or-longer prefixes; in a shared `/tmp` only the `cs-` names) | older than 1 day |
| temp projects | `~/.claude/projects/<slug>` where the slug starts with a temp path (`-private-var-folders-`, `-private-tmp-`, `-tmp-`) | no running session in it and nothing in it modified for 3 days |
| hook state | files in `os.tmpdir()/claude-post-edit/*` and `claude-skill-router/*` (agent call counters, edit logs, tsbuildinfo, router markers) | older than 3 days |

Never removed: the current session (`--session`, `$CLAUDE_CODE_SESSION_ID`, else `$CLAUDE_SESSION_ID`), the session with the newest transcript, a running
session (a `~/.claude/sessions/<pid>.json` whose process is alive; `--sessions` replaces that folder), anything that is a symlink (and a symlink's target),
anything outside the root of its rule. Everything is looked at again right before it is removed, so a session resumed while the run is going keeps its folder.

Safety rules (`lib/safe-remove.mjs`): a root must be an absolute path, not a symlink, not the home folder, under the temp folder, `/tmp` or `~/.claude`, and owned
by this user and closed to group and others (a shared sticky folder like `/tmp` is allowed, then only items owned by this user and only `cs-` names are touched);
otherwise the rule is skipped and the run says `SKIPPED`. Every folder from the root down to the item, and every folder inside the item, must be owned by this
user, not a symlink and not writable by group or others, or the item is kept and listed as `NOT removed` (a umask of 002 makes group-writable folders, so
such items stay: clean them by hand). Folders are removed by an own loop that unlinks entries one by one (links are unlinked, never entered), compares each folder's
device and inode before every unlink, and stops when one changed; it never calls `rm -r`. Node has no `unlinkat`, so the instant between that comparison and the
unlink is open to a process of the same user only; other users cannot swap anything because they cannot write in those folders. An error on one item is listed and the run goes on.
On Windows there is no uid: the owner and mode checks are skipped and a root must be under the temp or home folder, so the shared `C:\tmp\claude-user` scratchpad folder is not cleaned there.

Folders are read with `opendir`, one entry at a time, and walks keep one open folder per level (caps: 2 million entries, 64 levels, then the folder counts as busy and is kept),
so a temp folder with a million entries does not fill the memory. A dry run stops looking after `--scan-ms` (default 30 s, checked inside every rule loop) and
sizes stop at `--budget-ms` (default 20 s); either makes the totals "partial" (doctor prints "or more"); `--apply` has no scan limit. The flags `--claude-tmp`,
`--projects`, `--tmp` and `--sessions` replace the roots (tests use fake ones); `DISK_FREE_CLAUDE_TMP` replaces the first. Exit 0 ok, 1 something could not be removed, 2 usage.

Where it runs: the SessionStart(startup) hook `home/hooks/disk-clean-start.mjs` starts `--apply` in the background at most once per 24 h (the check and the stamp write hold a lock file made with `O_EXCL`; the stamp, lock and log are opened with `O_NOFOLLOW` and never block on a FIFO; the child gets only `HOME`, `TMPDIR` and a few other names, no tokens), and `doctor.sh`
prints the dry-run total as INFO (WARN above 2 GB).

## with-run-tmp: a suite run that leaves nothing behind

`node ~/.claude/tools/disk-free/with-run-tmp.mjs [--shell] -- <command>` runs the command with `TMPDIR`, `TMP` and `TEMP` set to a fresh `cs-run-*` folder
(children and grandchildren inherit it) and removes the folder when the command passes, fails or gets SIGINT/SIGTERM/SIGHUP. `test-pass run`, `scripts/affected-tests.mjs --run`,
`.githooks/pre-commit` and doctor's repo-test run all use it. Tests make their own folders with `makeTempDir` from `tests/temp-dir-helpers.mjs` (prefix `cs-test-`,
removed when the test process ends); a guard test fails when a test file calls `mkdtemp` itself. Hard kills (SIGKILL) leave one `cs-run-*` folder that `disk-clean` removes after a day.
Tests: `tests/disk-clean.test.mjs`, `tests/disk-clean-safety.test.mjs`, `tests/disk-clean-start.test.mjs`, `tests/with-run-tmp.test.mjs`, `tests/temp-dir-helpers.test.mjs`.
