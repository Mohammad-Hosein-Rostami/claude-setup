# readable/lib

One file per job. The checks are pure functions of file paths or file text; only `git-changes.mjs`, `walk.mjs` and
`run-check.mjs` touch the disk or git.

| File | Job |
| ---- | --- |
| `walk.mjs`, `ignore.mjs` | list the project files, skipping what `.gitignore` and vendored folders hide |
| `structure-checks.mjs` | folder with no README, dumping-ground names, nesting too deep |
| `header-check.mjs` | source file with no header comment |
| `config-comments.mjs` | yaml, toml, ini and example-env keys with no comment |
| `allow.mjs` | read `.readable.json` (allowed names, each with a reason) |
| `git-changes.mjs` | which files and lines changed against a base (for `--changed`) |
| `run-check.mjs` | runs every check and narrows to the changed files |
| `report.mjs` | prints the findings and the summary line |

Run the tests: `node --test tests/readable*.test.mjs` from the repo root.
