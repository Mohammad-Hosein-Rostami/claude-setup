# disk-free

Prints `ok`, `WARN` or `FAIL` for free disk space and names the biggest caches to clear; `disk-clean` removes old scratch folders.

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
session folders (`/private/tmp/claude-<uid>` on macOS, `/tmp/claude-<uid>` elsewhere). Measuring all folders together is limited to 30 seconds (so a WARN never outlasts the Bash tool's 120 s default timeout); a folder not measured in time is still
named, with "size not measured in time". The Docker builder cache has no folder, so it is always named last (`docker builder prune`).

## Where it runs

- By hand before a big build (`node ~/.claude/tools/disk-free/disk-free.mjs`): below the fail threshold, stop before any git or agent
  work. A check that could not run (exit 2) counts as a refusal too, so a broken check never lets a build start unseen.

## Test hooks

`DISK_FREE_DF_OUTPUT` replaces the `df -Pk` text, `DISK_FREE_CLAUDE_TMP` the session-folder root and `DISK_FREE_DU_TIMEOUT_MS` the 30 s
total measuring limit. Tests: `tests/disk-free.test.mjs`.

## disk-clean: removing what piles up

`disk-free` only reads. `disk-clean.mjs` removes (dry run unless `--apply`):

`node ~/.claude/tools/disk-free/disk-clean.mjs [--apply] [--json] [--all-lines] [--session <id>] [--scan-ms <n>]`

| Rule | What goes | When |
| ---- | --------- | ---- |
| session folders | `/private/tmp/claude-<uid>/<project>/<session-id>/` (scratchpads of agent runs, copies of repos) | the session is not running, its transcript (`~/.claude/projects/*/<session-id>.jsonl`) is found and was not modified for 3 days, and nothing inside the folder was modified for 3 days; a folder whose session has no transcript there goes only when nothing anywhere inside it was modified for 30 days (see below) |
| session scratch | in each session folder the rule above keeps (the current session, a running one, one not idle long enough): the entries of `<session-id>/scratchpad/` that are a real folder named `cs-test-*` or a git clone (a folder holding a `.git` folder; a linked worktree, whose `.git` is a file, is not one) | nothing anywhere in the folder was modified for 2 days (owner, 2026-11-22: a session that runs for days keeps only its newest 2 days), disk-clean first saw it over 2 days ago (`~/.claude/state/disk-clean/first-seen.json`, keyed by real path, device and inode; a dry run records too, and the report counts the folders seen for the first time as "first seen, kept"; so a `cp -a` copy made today with old times stays), and it holds no git work at any depth (a linked worktree or submodule, changes, untracked files that are not ignored, a stash, commits no remote-tracking branch holds; git that fails keeps it); any other name, a file and a link are never touched, and a session folder the rule above lists or removes in the same run is not looked into |
| test temp | folders in `os.tmpdir()` named `cs-test-*` (label plus 6 random characters), `cs-run-*` (6 characters), or an old test prefix plus 6 random characters (`lib/test-temp-prefixes.mjs`, only specific two-word-or-longer prefixes; in a shared `/tmp` only the `cs-` names) | older than 1 day |
| temp projects | `~/.claude/projects/<slug>` where the slug starts with a temp path (`-private-var-folders-`, `-private-tmp-`, `-tmp-`) | no running session in it and nothing in it modified for 3 days |
| hook state | files in `os.tmpdir()/claude-post-edit/*` and `claude-skill-router/*` (agent call counters, edit logs, tsbuildinfo; the removed skill router's old markers age out here) | older than 3 days |
| figma pulls | `~/.cache/figma/<file>/<node>` folders that figma-pull (ui-check) fills; `--figma-cache` replaces the root | nothing in the folder modified for 30 days (a pull is reused for one UI job; after a month the design is pulled again) |

The bound of each store this setup or Claude Code fills (2026-11-21):

| Store | Bound | Kept by |
| ----- | ----- | ------- |
| scratchpads `/private/tmp/claude-<uid>/...` | 3 days idle (30 for an unknown session; an empty folder 3) | disk-clean `session-folders` |
| `cs-test-*` and clone folders in a kept (running or recent) session's scratchpad | 2 days idle | disk-clean `session-scratch` |
| test temp folders | 1 day | disk-clean `test-temp` |
| hook counters in the temp folder | 3 days | disk-clean `hook-state` |
| `~/.cache/figma` | 30 days idle | disk-clean `figma-pulls` |
| stores of removed parts (recall index, estimate, done-check, commit-gate, ask queue, checkpoint and job files, 2026-11-24; Bash-check, agent-start and suite-queue state and the decision log, 2026-11-25) | removed once | `scripts/install.sh` (its one-time cleanup of known old paths, `scripts/install/retired-state.mjs`) |
| transcripts, tool results, file history | `cleanupPeriodDays` (default 30; `claude purge --all --dry-run` prints the size) | Claude Code itself: disk-clean adds no rule there |
| lane worktrees | until landed | `git-tidy prune` only (Claude Code's own cleanup keeps unpushed worktrees) |

Never removed: the folder of the current session (`--session`, `$CLAUDE_CODE_SESSION_ID`, else `$CLAUDE_SESSION_ID`), the session with the newest transcript, a running
session (a `~/.claude/sessions/<pid>.json` whose process is alive; `--sessions` replaces that folder; only the session-scratch rule looks inside them), anything that is a symlink (and a symlink's target),
anything outside the root of its rule. Everything is looked at again right before it is removed, so a session resumed while the run is going keeps its folder.
A folder is also renamed aside, in its own parent, to `.removing-<pid>-<name>` (one atomic step) and looked at once more under that name (running sessions, transcript, idle time) before
it is emptied: a session that resumes during the removal writes to a new folder at the old name and the old one is renamed back if the session turns out to be live (if the name is taken
by then, the folder stays aside and the run says so). When the look or the removal fails after the rename (a folder inside is writable by others, a mount point), the folder is renamed back to its own
name, possibly partly emptied, and the `NOT removed` line names the path it has: its own, or the `.removing-*` one when its name was taken meanwhile. A run handles each path once, so a folder
that was renamed back is not tried again in the same run, and a run skips the `.removing-<own pid>-*` folders it made itself. A `.removing-*` folder left by a killed run is finished by the next run only when the same checks pass for its original name; it is never renamed back.
The session-folders rule is skipped (and says `SKIPPED`) unless the transcripts folder (`~/.claude/projects`) and the sessions registry (`~/.claude/sessions`) are absolute, readable folders;
with `CLAUDE_CONFIG_DIR` set the default ones are not where Claude Code keeps them, so that rule and the temp-projects rule are skipped (give the folders with `--projects` and `--sessions`).
Sessions of another config dir: the scratchpad root is one per user, shared by every config dir, while a run reads the transcripts and the registry of one config dir only. A session folder with no
transcript in the projects folder that was read may therefore belong to a running session of another config dir. Such a folder is not judged by the 3-day rule: it is kept until nothing anywhere inside it
was modified for 30 days (the same whole-tree walk; found or not is decided again on every look), and the report says how many were kept ("N session folder(s) kept: no transcript in ..."; `keptUnknown` in `--json`).
Also left: a second config dir made by copying `~/.claude` (with `projects/`) where a copied session is resumed: the default dir keeps its
stale transcript while its registry entry is in the other dir, so its folder goes once the scratchpad is idle 3 days (security F2; only a
liveness signal that does not depend on the config dir would close it). With `CLAUDE_CONFIG_DIR` set the report (and so the log) says the two
rules were skipped; that day's stamp is still written, so the default dir's folders wait one more day (security F4).
What is left of the risk: a session of another config dir that writes nothing in its scratchpad folder for 30 days loses the folder, also while it is running (Claude Code makes its temp folders once per process, so a later write there can fail).
An empty or relative `HOME` makes every rule refuse its root, and the hook does not start the run.

Safety rules (`lib/safe-remove.mjs`): a root must be an absolute path, not a symlink, not the home folder, under the temp folder, `/tmp` or `~/.claude`, and owned
by this user and closed to group and others (a shared sticky folder like `/tmp` is allowed only when root owns it, because the owner of a sticky folder can rename everyone's entries;
then only items owned by this user and only `cs-` names are touched, and only the test-temp and hook-state rules accept it); otherwise the rule is skipped and the run says `SKIPPED`. The walk from the root down goes one relative name at a time: the run enters the root, checks it, and for each folder on the way checks it by lstat, enters it and checks its identity again (device and inode), so a folder swapped by a same-user rename between a check and its use is refused, not followed (security N1). Every folder from the root down to the item, and every folder inside the item, must be owned by this
user, not a symlink and not writable by group or others, or the item is kept and listed as `NOT removed` (a umask of 002 makes group-writable folders, so
such items stay: clean them by hand). Folders are removed by an own loop: it changes the working directory into the folder, checks that `.` is the folder that was inspected (device and inode), and unlinks bare names
only (links are unlinked, never entered; a folder inside must pass the same checks and stay on the same file system, so a mount point is kept); then it goes back out, checks the parent's
identity again and removes the empty folder; it never calls `rm -r`. Node has no `unlinkat`, so this is the way to make a swap of any folder on the path harmless; it works on Node 22 and later.
An entry that cannot be looked at stops the removal of that item at once. An error on one item is listed and the run goes on.
On Windows there is no uid: the owner and mode checks are skipped and a root must be under the temp or home folder; Claude Code's scratchpad folder there is `\tmp\claude-0` (the same for every account, no owner checks), which is outside those folders, so it is never cleaned.

Folders are read with `opendir`, one entry at a time, and walks keep one open folder per level (caps: 2 million entries, 64 levels, then the folder counts as busy and is kept),
so a temp folder with a million entries does not fill the memory. A dry run stops looking after `--scan-ms` (default 30 s, checked inside every rule loop) and
sizes stop at `--budget-ms` (default 20 s); either makes the totals "partial" (the report prints "or more"); `--apply` has no scan limit. The flags `--claude-tmp`,
`--projects`, `--tmp`, `--sessions` and `--figma-cache` replace the roots (tests use fake ones); `DISK_FREE_CLAUDE_TMP` replaces the first. `--now` may not be later
than the clock (a future time would shorten every age). The usage error, the home-folder line and an unexpected error are escaped like the report.
Exit 0 ok, 1 something could not be removed, 2 usage.

The text report: folder and file names are anyone's text, so every path, failure message and `SKIPPED` reason is printed escaped (printable ASCII only; a newline shows as `\n`, a quote as `\u0022`, and on Windows a backslash as `\u005c`),
and the `NOT removed` and `SKIPPED` lists stop at 10 lines each, followed by "... and N more". `--all-lines` prints both lists whole (still escaped); the start hook passes it, so the whole list is only in
`~/.claude/logs/disk-clean.log` (mode 0600, the last run only). `--json` carries counts only.

`--apply` takes a run lock (`~/.claude/state/disk-clean.run.lock`, see `lib/lock-file.mjs`; one older than 6 hours is a killed run's): a second run at the same time does nothing and says so.
The session registry files are read with `O_NOFOLLOW` and `O_NONBLOCK`, at most 64 KiB, and only plain files count.

Where it runs: the SessionStart(startup) hook `home/hooks/disk-clean-start.mjs` starts `--apply --all-lines` in the background at most once per 24 h (the check and the stamp write hold a lock file made with `O_EXCL`, a stale one is broken by one process only; the stamp, lock and log are opened with `O_NOFOLLOW` and never block on a FIFO; the child gets only `HOME`, `TMPDIR`, `CLAUDE_CONFIG_DIR` and a few other names, no tokens; with `CLAUDE_CONFIG_DIR` set the child skips the session-folders and temp-projects rules and prints 2 `SKIPPED` lines).

## with-run-tmp: a test run that leaves nothing behind

`node ~/.claude/tools/disk-free/with-run-tmp.mjs [--shell] -- <command>` runs the command with `TMPDIR`, `TMP` and `TEMP` set to a fresh `cs-run-*` folder
(children and grandchildren inherit it) and removes the folder when the command passes, fails or gets SIGINT/SIGTERM/SIGHUP. Nothing calls it automatically any more (the
check parts that did were removed on 2026-11-22); wrap a test run in it by hand when you want one that leaves nothing behind. Tests make their own folders with `makeTempDir` from `tests/temp-dir-helpers.mjs` (prefix `cs-test-`,
removed when the test process ends); a test fails when a test file calls `mkdtemp` itself. Hard kills (SIGKILL) leave one `cs-run-*` folder that `disk-clean` removes after a day.
Tests: `tests/disk-clean.test.mjs`, `tests/disk-clean-live-scratch.test.mjs`, `tests/disk-clean-safety.test.mjs`, `tests/disk-clean-start.test.mjs`, `tests/with-run-tmp.test.mjs`, `tests/temp-dir-helpers.test.mjs`.
