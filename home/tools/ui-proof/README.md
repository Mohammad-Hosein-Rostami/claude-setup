# ui-proof

Records each UI check run as proof and checks that a change's UI files have the proof their check plan needs.

This folder holds the UI proof record tool: `node ~/.claude/tools/ui-proof/ui-proof.mjs <command> [flags]`. Node 22, no dependencies.

## Records (F7, P8)

`ui-proof record --as <dev-run|pixel-qa> -- <ui-check run arguments>` runs `ui-check run` itself, passes its output through
and writes one record per run, whatever its verdict (`lib/record-run.mjs`; the `ui-proof-gate` hook did this until 2026-11-24).
dev-run and pixel-qa start their runs this way, so their PASS can be checked. The records are kept by `lib/records.mjs`. A record lives in
`~/.claude/state/ui-proof/<repo>-<hash>.json` (`UI_PROOF_STATE_DIR` overrides the folder; worktrees of one clone share the file;
the newest 200 records are kept): the hash of the UI files of the working tree, HEAD, the verdict, the rule, the viewing conditions,
the matrix hash, the `--step` label, the widths and frames, and the batch reference from the run's `ledger.json` (per state the
capture sha256, pixels, colour-metric pixels, rows and pixel ratio; the comparator and renderer). It also keeps the sha256 of the
ledger (`ledgerSha256`, how a later `--same` run names this run as its base), the ledger's `same` section and its captures (key,
sha256, finding ids, page errors). The working tree is the one of the ledger's `root` (the folder `ui-check run` started in) when
that is a worktree of the same repository as the folder `record` ran in, else that folder. The verdict and the results folder
come from the run's own `result:` line, never from a flag; the agent type is the `--as` kind (no hook names the agent any more:
it is the caller's word); a record without one (an older record) is nobody's. A run file that is a FIFO, device or folder is
refused and nothing is written. Only a PASS made by pixel-qa on the tree
that lands is the final gate of a visual or pixel plan; a same or render plan is proved by dev-run or pixel-qa runs (below).

UI files (`lib/ui-files.mjs`, the one definition): markup and style files plus `.ts`/`.js` style scripts under a
styles/theme/sx folder or named `*.styles.ts`, `*.theme.ts`, `*.sx.ts`, minus folders named `test`, `tests`, `__tests__` or
`fixtures`; in a repo that has such a file at either sha, also every `package.json`, its lockfile and the files under a
`locales`, `locale`, `i18n` or `lang` folder.

| Command | Exit |
| ------- | ---- |
| `record --as <dev-run\|pixel-qa> [--repo DIR] -- <ui-check run arguments>` | Runs `ui-check run` with those arguments in DIR (default: the current folder), passes its output through and writes its record as that kind. The run's own exit code; 2: usage, or the run ended but its record could not be written (an unreadable or non-plain run file: no record). A run that ends before its `result:` line (a setup problem) leaves no record and says so. |
| `check --tip <sha> [--against <sha>] [--repo DIR]` | 0: a pixel-qa PASS for the tip's UI tree and, with `--against`, no state worse than the record taken at that sha; a state with no reference row prints `new` (INFO). 1: no such PASS, a state worse, another comparator or renderer (fail closed), or no record with that sha. 2: usage. `git-tidy land` calls it with `--against`. |
| `changed --from <sha> --to <sha> [--repo DIR]` | Lists the UI files that differ: 0 none, 1 some, 2 usage. |
| `plan --base <sha> --tip <sha> \| --files <path>... [--request <file>]... [--matrix <path>] [--json] [--write-run <dir>] [--repo DIR]` | The check plan (`lib/ui-plan.mjs`, rules in `home/standards/ui-checks.md`): `plan: <depth>`, a `tests:` line when logic changed, `surface <id>: <needs> (<why>)` (the need of a reached surface is none, same, render, visual or pixel, or a set such as `same + pixel`: `same` stays beside any raised need), a `map:` line (the widths, locales and states a same or render proof covers, where they came from, and the run matrix's sha256), `exempt <file> (<why>)` and one line per safe path taken. `--files` judges the expected files of a brief by path at HEAD. `--request` files are the request itself (the brief): a STATUS.md is not read, and the `## Standing rules` and `## Owner decisions` sections of any other file are cut, each with a reason line. The map takes the lane matrix's widths and locales, else 360, 768, 1280 and the repository's locale folder names (`locales/fa/`, `i18n/fa.json`), else `en`. `--write-run <dir>` writes `matrix.json` (the map's run matrix, byte for byte, so a run of it carries the plan's matrix hash) and `states.json` of the surfaces that need same or render under `~/.claude/state/ui-plan-runs/` (`UI_PLAN_STATE_DIR` overrides; a folder inside the repository is refused). Exit 0, 2 usage. |
| `check --tip <sha> --plan --base <sha> [--request <file>]... [--matrix <path>] [--repo DIR]` | The plan of base..tip and its proof. none: PASS. visual, pixel: exactly `check --tip <sha>` when no surface also needs same. same, render: the newest dev-run or pixel-qa run at the tip (head and UI tree) of the plan's run matrix (its `matrixHash`) with `--same`, whose base ledger (by `ledgerSha256`) is a dev-run or pixel-qa run at the base (head and UI tree), with a row for every width, locale and state of the map on every planned surface; same needs identical or equal states, render no new finding, no more page errors and no missing state; a state with no base render needs a pixel-qa PASS; a pixel-qa PASS on the tip also proves render, never same. 0 PASS with `follow-up:` lines for findings on both sides, 1 FAIL (zero rows, a missing row, a run of another matrix, a missing record, any other agent's run, `unexpected visual change: <states>`, an unreadable store), 2 usage. |

`MATRIX: none:` skips the Figma compare, never the proof: pixel-qa runs `run` on a matrix without a Figma source.

## No waiver of the UI proof

The owner's per-road waiver of the UI proof was removed on 2026-11-23 (owner: no kinds, no waivers; the checks are detected from the
work). `git-tidy land` refuses its old flag (exit 2) and proves the check plan of the rebased diff instead (`check --plan`);
a docs page, tests or dev config need no UI proof at all.

## review-page

`ui-proof review-page --results <dir> --out <dir> [--matrix <matrix.json>]` writes `<out>/index.html`, the page the owner
reviews before a UI fix is reported as done (pixel-qa's final gate runs it and gives the page path in its report).

- Input: `<results>/results.json` as `ui-check batch` or `run` writes it (records `{surface, state, locale, width, status,
  evidence, findings, part, url?, images?: {baseline, actual, diff}}`). Without `images` the actual capture and the diff are
  taken from `actual.png` and `diff.png` beside `evidence` (the compare `report.md`), and the Figma image shows "baseline not
  recorded". A relative path is read from the current folder, else from the results folder.
- One row per surface, state and locale: a live link to the state's `url` (opens the real page, so "View source" or DevTools
  shows the exact HTML; only http, https and file URLs become links), the Figma, actual and diff images of each compare record,
  and the verdict (status, width, findings and evidence of every compare and responsive record). A state with only responsive
  records gets the live link and its verdict, no images.
- `--matrix` (a `ui-coverage` matrix) adds two lists: `accepted` (each entry's frame node, cell, covered findings, `reason`
  when present) and the optional `settled` list, "settled, do not report again": an array of
  `{surface, state, locale?, what, owner}`.
- Output: the images are copied into `<out>/images/` and linked relatively, so the folder opens from disk and can be zipped.
  Use a fresh `--out` for a clean zip: images of an earlier run with more rows stay in `images/`. Every text is HTML-escaped,
  the CSS is inline (light and dark themes, rows stack into cards below 48rem).
- Prints the page path on stdout. Exit `0` written, `2` on a bad flag, a missing `--results`/`--out`, or a `results.json` or
  matrix that cannot be read or has the wrong shape.
- Code: `review-page.mjs` (`run`, `buildModel`: reading and image copies) and `lib/review-html.mjs` (`renderPage`, the pure
  page builder). Ported and cut down from an earlier web app project's parity job, `review/build-review.mjs`.
