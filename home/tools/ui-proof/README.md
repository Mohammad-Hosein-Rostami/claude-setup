# ui-proof

This folder holds the UI proof record tool: `node ~/.claude/tools/ui-proof/ui-proof.mjs <command> [flags]`. Node 22, no dependencies.

## review-page

`ui-proof review-page --results <dir> --out <dir> [--matrix <matrix.json>]` writes `<out>/index.html`, the page the owner
reviews before a UI fix is reported as done (visual-qa's final gate runs it and gives the page path in its report).

- Input: `<results>/results.json` as `ui-check batch` or `run` writes it (records `{surface, state, locale, width, status,
  evidence, findings, part, url?, images?: {baseline, actual, diff}}`). Without `images` the actual capture and the diff are
  taken from `actual.png` and `diff.png` beside `evidence` (the compare `report.md`), and the Figma image shows "baseline not
  recorded". A relative path is read from the current folder, else from the results folder.
- One row per surface, state and locale: a live link to the state's `url` (opens the real page, so "View source" or DevTools
  shows the exact HTML; only http, https and file URLs become links), the Figma, actual and diff images of each compare record,
  and the verdict (status, width, findings and evidence of every compare and responsive record). A state with only responsive
  records gets the live link and its verdict, no images.
- `--matrix` (a `ui-coverage` matrix) adds two lists: `accepted` (each entry's frame node, cell, covered findings, `reason`
  when present and owner reference) and the optional `settled` list, "settled, do not report again": an array of
  `{surface, state, locale?, what, owner}`.
- Output: the images are copied into `<out>/images/` and linked relatively, so the folder opens from disk and can be zipped.
  Use a fresh `--out` for a clean zip: images of an earlier run with more rows stay in `images/`. Every text is HTML-escaped,
  the CSS is inline (light and dark themes, rows stack into cards below 48rem).
- Prints the page path on stdout. Exit `0` written, `2` on a bad flag, a missing `--results`/`--out`, or a `results.json` or
  matrix that cannot be read or has the wrong shape.
- Code: `review-page.mjs` (`run`, `buildModel`: reading and image copies) and `lib/review-html.mjs` (`renderPage`, the pure
  page builder). Ported and cut down from the ICE parity job's `review/build-review.mjs`.
