# readable/lib

One file per job. The checks are pure functions of file paths or file text; only `git-changes.mjs`, `walk.mjs` and
`run-check.mjs` touch the disk or git.

| File | Job |
| ---- | --- |
| `walk.mjs`, `ignore.mjs` | list the project files, skipping what `.gitignore` and vendored folders hide |
| `structure-checks.mjs` | folder with no README, dumping-ground names, nesting too deep |
| `exemptions.mjs` | lock and generated files, locale files, and the framework paths and names the checks leave alone |
| `added-only.mjs` | for `--changed`: drop findings about files and folders that already existed |
| `header-check.mjs` | source file with no header comment |
| `config-comments.mjs` | yaml, toml, ini and example-env keys with no comment |
| `allow.mjs` | read `.claude/readable.local.json` and `.readable.json` (allowed names, each with a reason) |
| `errors.mjs` | `UsageError` (exit 2) and `GitError` |
| `git-changes.mjs` | what changed against a base: changed lines, added files, files that existed (for `--changed`) |
| `run-check.mjs` | runs every check and narrows to the changed files |
| `report.mjs` | prints the findings and the summary line |

Run the tests: `node --test tests/readable*.test.mjs` from the repo root.
