# disk-free/lib

Code of `../disk-clean.mjs` (see `../README.md`).

- `clean-scan.mjs`: read-only helpers that never follow a symlink and read folders with `opendir` (`entriesOf`, `walkTree`, `treeBytes`, `touchedSince`, `mtimeOf`).
- `safe-remove.mjs`: which roots and folders are safe (owner, mode, links) and the removal itself (`inspectRoot`, `ownedFolder`, `removeInside`); the header says what it does and does not defend against.
- `live-sessions.mjs`: ids of the sessions whose process is alive, from `~/.claude/sessions/*.json`.
- `clean-rules.mjs`: the four rules, each an async generator that yields what to remove and how to check it again (`rulesFor`, `AGE`). Change an age limit in `AGE`.
- `test-temp-prefixes.mjs`: the name prefixes the tests used before `tests/temp-dir-helpers.mjs`; a fixed list, it does not grow.

Test: `node --test tests/disk-clean.test.mjs` (fake roots only; the real folders are never touched).
