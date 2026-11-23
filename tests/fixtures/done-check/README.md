# done-check output samples

Output of the tools the done-check reads (typescript, eslint, vitest, node:test, jest), kept as files so
`tests/done-check-formats.test.mjs` can check that `home/tools/done-check/lib/parse.mjs` reads what the real tools print.
The fake tools in `tests/done-check-fixture.mjs` can replay these files too.

## Where they come from

Every sample was captured from the installed tool, in a throw-away folder outside any project, with the tool run from the
`node_modules` of a work project's checkout, shown as `<tools-checkout>` (read only: the folder had no new or changed file afterwards). The throw-away folder held
a few small source files with known mistakes, one of them in a folder whose name has a space (`src/two words/`). Machine paths were
replaced by `/work/proj` (the project) and `/work/tools` (the tool's own files), so no sample holds a user or machine name.

| Sample | Tool and version | Command (run in the throw-away project folder) |
|---|---|---|
| `tsc-5.8.3-errors.txt` | typescript 5.8.3 | `node <tools-checkout>/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false` (exit 2, stdout) |
| `eslint-9.39.5-errors.json` | eslint 9.39.5 | `node <tools-checkout>/node_modules/eslint/bin/eslint.js --format json src` (exit 1, stdout) |
| `vitest-4.1.9-fail.json` | vitest 4.1.9 | `node <tools-checkout>/node_modules/vitest/vitest.mjs related --run --reporter=json --outputFile out.json --passWithNoTests src/math.ts "src/two words/note.ts"` (exit 1, the `out.json` file) |
| `vitest-4.1.9-none-related.json` | vitest 4.1.9 | the same command with `src/orphan.ts`, which no test imports (exit 0, 0 tests) |
| `node-tap-26.5.0-fail.txt` | node 26.5.0 (this Mac) | `node --test --test-reporter=tap test/slug.test.mjs "test/two words/sum.test.mjs" test/load.test.mjs` (exit 1, stdout) |
| `node-tap-26.5.0-pass.txt` | node 26.5.0 | `node --test --test-reporter=tap test/pass.test.mjs` (exit 0) |
| `jest-30-docs-fail.json` | jest 30, **not captured** | written by hand from the documented `jest --json` result shape (`testResults[].assertionResults[]`, `status`, `fullName`, `failureMessages`), because no jest is installed in the owner's projects (design U5). Same project shape as the vitest sample. |

The throw-away projects: `tsconfig.json` (strict) with a `Line` type that gained a field so its caller breaks, a wrong type, a
missing property, an implicit `any`; an eslint flat config with `no-unused-vars`, `no-undef` as errors, `eqeqeq` and `no-console` as
warnings, plus a file that does not parse; vitest and node:test files with passing, failing, skipped and todo tests, and a test file
that fails to load (a missing import). The PC runs Node 22, whose TAP output may differ in small details (the `# Subtest:` lines and the
extra fields of the `---` blocks); a sample from Node 22 is still owed (design U-list, proof step).

## Windows variants

Made by rewriting the real sample, not captured on Windows (there is no Windows machine in this setup's reach): the project paths
become `C:\work\proj\...` (inside the JSON strings as `C:\\work\\proj\\...`), and every line ends with CRLF. The JSON files are
re-printed with two-space indentation so the CRLF lands between lines. The tsc paths are relative with `\`, as tsc prints on Windows.
The parser test expects the same failure ids from a sample and its Windows variant (spec A12).

| Variant | Of |
|---|---|
| `tsc-5.8.3-errors-windows.txt` | `tsc-5.8.3-errors.txt` |
| `eslint-9.39.5-errors-windows.json` | `eslint-9.39.5-errors.json` |
| `vitest-4.1.9-fail-windows.json` | `vitest-4.1.9-fail.json` |
| `node-tap-26.5.0-fail-windows.txt` | `node-tap-26.5.0-fail.txt` (also `test\load.test.mjs` in the file-level test name) |
| `jest-30-docs-fail-windows.json` | `jest-30-docs-fail.json` |

`.gitattributes` in this folder turns line-ending conversion off, so the CRLF files stay CRLF on a Windows checkout.

## Ledger rows

`ledger-rows-2026-11-22.json` holds the changed files of the first 82 done-check runs in this repo (2026-11-22, the day the
done-check was switched on), so `tests/done-check-risk.test.mjs` can replay them through the risk classes. The ledger keeps only
counts, so the lists were rebuilt from git: for a row with a base, every commit made in the 3 hours before the run (or up to 2 minutes
after it) that has the base as an ancestor was compared with the base, and the one whose file count is nearest the row's count, then
nearest in time, was kept (`git-exact`: same count, 59 rows; `git-near`: nearest count, 7 rows). Its list is the whole
`git diff --name-only`, docs included. The 16 lead runs with no base (`edit-log-superset`) list every file the session's edit log holds
for the worktrees where the lead edited (20 files), more than any one run saw. `riskThen` is the classes the run recorded. A `git-near`
list can differ from its run by one to three files (six of the seven hold more files than the run, one holds one fewer); the
`edit-log-superset` lists can only over-count a class.

## Making a new sample

Run the tool in a scratch folder (never inside an owner project: no cache, no `node_modules/.vite`), replace machine paths as above,
add the file to the table, and add a case to the parser test. `tests/done-check-formats.test.mjs` fails when a file here is not named
in this README.
