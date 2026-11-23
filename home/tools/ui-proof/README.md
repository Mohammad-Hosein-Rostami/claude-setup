# ui-proof

This folder holds the UI proof record tool: `node ~/.claude/tools/ui-proof/ui-proof.mjs <command> [flags]`. Node 22, no dependencies.

## Records (F7, P8)

`hooks/ui-proof-gate.mjs` (PostToolUse Bash) writes one record per `ui-check run`, whatever its verdict, into
`~/.claude/state/ui-proof/<repo>-<hash>.json` (`UI_PROOF_STATE_DIR` overrides the folder; worktrees of one clone share the file;
the newest 200 records are kept): the hash of the UI files of the working tree, HEAD, the verdict, the rule, the viewing conditions,
the matrix hash, the `--step` label, the widths and frames, and the batch reference from the run's `ledger.json` (per state the
capture sha256, pixels, colour-metric pixels, rows and pixel ratio; the comparator and renderer). The agent type is taken from the
hook input (`agent_type`), never from the command line; a record without one is nobody's. Only a PASS made by visual-qa on the tree
that lands is the final gate.

UI files (`lib/ui-files.mjs`, the one definition): the skill router's `isUiFile` plus `.ts`/`.js` style scripts under a
styles/theme/sx folder or named `*.styles.ts`, `*.theme.ts`, `*.sx.ts`, minus folders named `test`, `tests`, `__tests__` or
`fixtures`; in a repo that has such a file at either sha, also every `package.json`, its lockfile and the files under a
`locales`, `locale`, `i18n` or `lang` folder.

| Command | Exit |
| ------- | ---- |
| `check --tip <sha> [--against <sha> \| --against-step <road>.s<N>] [--repo DIR]` | 0: a visual-qa PASS for the tip's UI tree and, with `--against`, no state worse than the record taken at that sha (with `--against-step`: than the record labelled `<road>.s<N>`); a state with no reference row prints `new` (INFO). 1: no such PASS, a state worse, another comparator or renderer (fail closed), or no record with that sha or label. 2: usage. `git-tidy land` calls it with `--against`, the road gate with `--against-step` (phase 3). |
| `has --step <road>.s<N> [--repo DIR]` | 0 a record with that label exists, 1 none, 2 usage (`road.mjs next` uses it, not `check`). |
| `changed --from <sha> --to <sha> [--repo DIR]` | Lists the UI files that differ: 0 none, 1 some, 2 usage. |

The stop gate (`hooks/ui-proof-gate.mjs`, Stop and SubagentStop): when the working tree's UI files differ from the merge base with
the default branch and no PASS matches the tree, it blocks once per state (the lead needs visual-qa's PASS; a ui-implementer or
visual-qa stop takes its own); a newer run on the same tree that is worse than the PASS's reference blocks too; an unreadable record
blocks (fail closed). Claude Code overrides a Stop gate after 8 blocks in a row and lets a crashed one through, so no proof rests
on it alone: `git-tidy land` and the road gate are the hard checks. `MATRIX: none:` skips the Figma compare, never the proof:
visual-qa runs `run` on a matrix without a Figma source.

## Owner waiver of the UI proof

Why: on 2026-11-23 the owner decided that web API-integration lanes, which change no screen on purpose, land without the visual-qa
PASS while every other check stays. `lib/owner-waiver.mjs` is the one rule, read by `git-tidy land --owner-waive-ui`, `land-lane
--owner-waive-ui` and the road gate's line 4:

- Only visible lines of the STATUS.md section `## Owner decisions` count (up to the next heading; a line in a code fence and text inside
  an HTML comment `<!-- ... -->`, also one over several lines, are not read). Of those, the last line that names
  `ui-proof waiver for road <id>` (any case; the id not followed by another id character, so `ice` is not `iceweb`) decides:
  - It grants the waiver only in the form `- <YYYY-MM-DD> ui-proof waiver for road <id>` followed by nothing, or by the owner's words
    (e.g. `: web API lanes land without the screen check (owner, 2026-11-23)`): the bullet, the optional date and then the phrase, exactly
    as `status.mjs decision "ui-proof waiver for road <id>: <what the owner said> (owner, <date>)"` writes it. The line must not contain
    `UNCONFIRMED` (a decision taken by a timeout default is no owner decision), and the words after the phrase must not contain a
    negation word: `no`, `not`, `never`, `revoke`, `revoked`, `denied`, `declined`, `refused`, `withdrawn`, `canceled`, `cancelled`.
  - Any other line that names it revokes: `- <date> ui-proof waiver for road <id> revoked (owner, <date>)` and
    `- <date> no ui-proof waiver for road <id>` are the two forms to record a revoke with (`status.mjs decision`). A later granting line
    grants it again.
- For a landing (`git-tidy land`, `land-lane`) the STATUS.md must also hold the close row (`--close-row`, a road row
  `<road>.s<N>.<name>` whose road is `<id>`) in `## Work items`, and lie outside every folder of the repository being landed (the base
  folder and each of its worktrees, real paths with symlinks resolved, case folded on macOS and Windows). So a STATUS.md written for the
  occasion, or kept in the repo itself, cannot waive the proof. Otherwise it is exit 2 before anything runs, naming what is missing.
- A landing under it prints `ui-proof: waived by owner decision (<reason>)`, and land-lane ends the row evidence with
  ` (ui-proof waived: owner decision)`. Gate line 4 passes a step as `waived by owner decision` when a landing of the step carries that
  evidence, every landing that changed a UI file carries it, and the owner's line is there; otherwise the step takes the web or terminal
  path as before.
- Without the line, or without the flag, nothing changes: the UI proof is on. The stop gate (`hooks/ui-proof-gate.mjs`) is not changed.

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
