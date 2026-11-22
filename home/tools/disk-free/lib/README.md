# disk-free/lib

Code of `../disk-clean.mjs` (see `../README.md`).

- `clean-scan.mjs`: read-only helpers that never follow a symlink and read folders with `opendir` (`entriesOf`, `walkTree`, `treeBytes`, `touchedSince`, `mtimeOf`), and `holdsGitWork` (a worktree, changes or local-only commits anywhere in a folder; read-only git calls with the board's `GIT_SAFETY` flags).
- `safe-remove.mjs`: which roots and folders are safe (owner, mode, links) and the removal itself (`inspectRoot`, `ownedFolder`, `removeInside`, `moveAside`, `moveBack`, `isOwnAside`); the header says what it does and does not defend against.
- `lock-file.mjs`: the lock file of the start hook and of `--apply` (`takeLock`, `releaseLock`); a stale lock is broken by one process only.
- `live-sessions.mjs`: ids of the sessions whose process is alive, from `~/.claude/sessions/*.json`.
- `first-seen.mjs`: when disk-clean first saw each scratchpad cs-test or clone folder (`openFirstSeen`, `recordKey`), one JSON file through `hooks/lib/session-store.mjs` under `hooks/lib/session-lock.mjs`; entries of gone folders are dropped.
- `clean-rules.mjs`: the six rules, each an async generator that yields what to remove and how to check it again (`rulesFor`, `AGE`). Change an age limit in `AGE`.
- `test-temp-prefixes.mjs`: the name prefixes the tests used before `tests/temp-dir-helpers.mjs`; a fixed list, it does not grow.

Tests: `tests/disk-clean*.test.mjs`, for example `node --test tests/disk-clean.test.mjs` (fake roots only; the real folders are never touched).
