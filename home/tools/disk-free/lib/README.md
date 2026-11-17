# disk-free/lib

Code of `../disk-clean.mjs` (see `../README.md`).

- `clean-scan.mjs`: file-system helpers that never follow a symlink and read folders with `opendir` (`entriesOf`, `treeBytes`, `touchedSince`, `mtimeOf`, `removeInside`).
- `clean-rules.mjs`: the four rules, each an async generator that yields what to remove (`rulesFor`, `AGE`). Change an age limit in `AGE`.
- `test-temp-prefixes.mjs`: the name prefixes the tests used before `tests/temp-dir-helpers.mjs`; a fixed list, it does not grow.

Test: `node --test tests/disk-clean.test.mjs` (fake roots only; the real folders are never touched).
