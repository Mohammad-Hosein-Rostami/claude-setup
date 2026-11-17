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
session folders (`/private/tmp/claude-<uid>` on macOS, `/tmp/claude-<uid>` elsewhere). A folder too big to measure within 30 seconds is still
named, with "size not measured in time". The Docker builder cache has no folder, so it is always named last (`docker builder prune`).

## Where it runs

- `scripts/doctor.sh` (`check_disk_free`): `FAIL` makes doctor exit 1, `WARN` is a warning.
- The first step of the `land` and `build` workflows (`home/workflows`): below the fail threshold they stop before any git or agent work and
  return the line above as the reason. A check that could not run (exit 2) refuses too, so a broken check never lets a build start unseen.

## Test hooks

`DISK_FREE_DF_OUTPUT` replaces the `df -Pk` text, `DISK_FREE_CLAUDE_TMP` the session-folder root and `DISK_FREE_DU_TIMEOUT_MS` the 30 s
measuring limit. Tests: `tests/disk-free.test.mjs`, `tests/doctor-disk.test.mjs`.
