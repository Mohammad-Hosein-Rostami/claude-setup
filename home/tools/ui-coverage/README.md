# ui-coverage

Checks the coverage matrix of a UI task: every surface x state x locale x width must be `pass`, or `na` / `deferred`
with a reason. Done = `check` exits 0. Node 22, no dependencies. Skill: `skills/ui-coverage/SKILL.md`.

Run: `node ~/.claude/tools/ui-coverage/ui-coverage.mjs <command>`

| Command | What it does |
| ------- | ------------ |
| `init <matrix> --locales en:ltr,fa:rtl --widths 320,768,1280 --surfaces login,signup [--frames frames.json]` | With `--frames` (a file from `ui-check figma-frames`; exit 2 if unreadable) adds the `figma` section and every frame with `cells: []`; without it prints `no Figma source: frame inventory off`. Writes a valid skeleton: the surfaces (kind `screen`, `controls: []`, source `TODO`), `TODO` placeholders in `searched` and `deliverable`, and a `todo` cell per surface x locale x width. `check` rejects it with `todo` problems only. Refuses to overwrite an existing file (exit 2). |
| `expand <matrix> [--out F]` | Adds a `todo` cell for every surface x state x locale that is missing (`rest` also per width). Also appends the frames of `figma.framesFile` that the matrix lacks (as `cells: []`, never editing or removing a frame; exit 1 with `[frame-source]` when the file cannot be read). Idempotent; writes the matrix in place. Exit 1 (file untouched) when the matrix structure is broken. |
| `scaffold <matrix> [--out states.json]` | Writes a `ui-check batch --states` skeleton: one entry `{surface, state, locale, widths, url:"", steps:[]}` per surface x state x locale that still has a cell that is not `pass`, `na` or `deferred` (its open widths grouped in `widths`), and `defaults: {}` for you to fill. When the matrix maps a frame to the entry (same surface, state, locale, at one of its open widths) the entry gets `figma: {file, node}` (the first such frame). The names come from the matrix, so batch records match the cells by construction. An existing `--out` keeps all its entries and `defaults` (matched on surface + state + locale) and only gets the missing entries. Default `--out`: `states.json` in the current directory. Exit 1 (nothing written) for a broken matrix, 2 for a bad flag or an unreadable states file. Flow: expand, scaffold, fill `url` and `steps`, `ui-check batch`, check. |
| `states` | Prints the default states per control class (the single list, `lib/states.mjs`). |
| `check <matrix> [--results F]... [--verbose]` | Validates, merges result records, prints the summary, exits 0 (complete) or 1 (problems). Never writes. Exit 2: bad flag, unreadable or invalid JSON. `--verbose` lists every problem instead of the groups. |

## matrix.json
```
{ locales:[{tag,dir:"ltr|rtl"}],      // the first locale is the base locale
  widths:[n], stateWidths?:[n], stateWidthsReason?,   // stateWidths: subset of widths, narrows control states only
  root?:"<dir relative to the matrix file>",     // where mountedAt paths resolve from (default: the matrix file's directory)
  searched:{backend:[str], siblings:[str], reference:[str]}, deliverable:{reviewUrl, mockExcluded},
  surfaces:[{ id, kind:"screen|email|server-page|pdf|notification|other", source,
    controls:[{ id, class, component:"<path>"|{new:"<reason>"}, mountedAt:"<file>:<line>", componentMarker?:str, states:[str], reference:"<path>|none: <reason>",
                dropped?:{ "<state>":"<reason>" } }] | "none: <reason>" }],
  cells:[{ surface, state:"<control>:<state>"|"rest", locale, width, status:"pass|fail|na|deferred|todo", evidence, reason }] }
```
- State ids: `rest` and `<controlId>:<state>`. EVERY state is demanded at every width of `widths` for every locale, so each
  cell has a positive-integer `width`. `stateWidths` narrows control states only (`rest` keeps every width) and needs
  `stateWidthsReason`; the reason is printed in the summary.
- `class` is required: a known class or `other` (then `states` must be listed). Run `ui-coverage.mjs states` for the
  classes and their default states; a default state must be in `states` or in `dropped` with a reason. A misspelled class is a
  schema error naming the control.
- Reuse is proven, not declared: every control with a `component` path needs `mountedAt` (`<file>:<line>`: the line that
  instantiates or places this control). `check` reads that file and fails with `unproven-reuse` when the file or line does
  not exist or the component (the component file's name without extension, or `componentMarker`: a tag or class it
  exports) is not mentioned within 5 lines of that line (line-5 .. line+5; a correct use elsewhere in the file proves
  nothing). A `{new}` control needs `mountedAt` too (`unproven-mount`) but skips the mention test. Two controls may not
  share one `file:line` (`duplicate-mount`). Paths resolve from the matrix file's directory, or from `root`.
- Reference is proven: `reference: "none: <reason>"` is accepted only when `searched.reference` lists at least one search
  command with its hit count; otherwise `unproven-reference`.
- Reasons (`na`, `deferred`, `{new:}`, `none:`, `dropped`, `stateWidthsReason`) and `deliverable.mockExcluded` need 15+
  non-space characters (the `none:` prefix does not count). Widths are positive integers; anything else is a schema error (a bad record width is `bad-result`).
- Evidence of a `pass` cell is a http(s) or file URL, or an existing file (a relative path resolves from the matrix file's
  directory). `deliverable.reviewUrl` is a URL or an existing path.
- A `na` cell in a non-base locale is allowed only when the same surface, state and width is `na` in the base locale;
  otherwise it must be `pass` or `deferred` with a reason.

## Figma frames (optional)
Without these keys nothing changes. With them, every frame of the design must be accounted for:
```
  figma:{file:"<Figma file key>", framesFile:"<path relative to the matrix>"},   // file written by `ui-check figma-frames`; present = inventory rules on
  frames:[{node:"12:40", name, width, cells:[{surface,state,locale}]} | {node, name, width, notBuilt:"<15+ characters>"}]
```
Node ids are compared in the API form: `12-40` (URL form) and `12:40` are one frame. A frame's cell has the frame's `width`, so the matrix `widths` must contain it. `frames` is the only place a cell gets a Figma node. Problems: `frame-source` (framesFile unreadable, not a frames file, listing no frame, or naming a different Figma file than `figma.file`), `frame-missing` (a frame in the framesFile that `frames` lacks: run `expand`, then map it or mark it `notBuilt`), `frame-unmapped` (no cells and no `notBuilt` of 15+ characters), `frame-cell` (the frame maps to a cell the matrix does not demand; the message says what to change), `no-compare` (a mapped cell has no `ui-check batch` record with `part: "compare"`: a pass from another probe does not count), `figma-section-missing` (compare records in the results but no `figma` section). A frame listed twice, or with both non-empty `cells` and `notBuilt`, is a `shape` problem.

### Accepting a difference from Figma
A failing compare is closed only by the owner's decision, never by the session's own ledger:
```
  accepted:[{ node:"12:40", surface, state, locale,
              findings:[{check:"element", element:"a.extra-link"} | {check:"pixel", maxPercent:0.8}],
              owner:{ask:"<queue path>#q2", answer:"<exact answer text>"} | {status:"STATUS.md", line:"<exact line>"} }]
```
A cell is accepted when every failing record of it has `part: "compare"` (a hand-set fail or a responsive fail is never accepted) and every finding is covered by one entry for the same frame node and cell: an `element` finding by the same `element`, a `pixel` finding by a `percent` not above `maxPercent` (a pixel finding without a number, such as a size mismatch, is never covered; an `error` finding cannot be accepted). The entry's `owner` must be a decision the owner made: `ask` = a queue file made by `ask.mjs init` and lying directly in the ask queue folder (`~/.claude/ask`; the real path is judged, a link out of it or a file kept elsewhere is refused) whose last answer to that question equals `answer` exactly, carries no `by` mark at all (an answer written with `--default`, or marked any other way, is not the owner's), and whose question text names the frame node as a whole id; `status` = the notes file (path relative to the matrix) holding that exact line under `## Standing rules` or `## Owner decisions` (until the next `## `), and the line names the node id as a whole token (`12:4` is not named by `12:40`, `112:4` or `12:4;5:6`). Otherwise `owner-ref`: `accepted difference on <cell> (frame <node>) has no owner decision: <why>; ask the owner or match Figma` (why: no owner field, queue missing (copy the decision into STATUS.md Standing rules), queue file is outside the ask queue folder, q2 unanswered, q2 was taken by timeout or marked another way, answer differs, q2 does not name frame <node>, line not under those headings, line does not name the node) and the cell keeps failing. An entry naming a frame or cell that `frames` do not map is an `accepted-node` problem.
An accepted cell drops its `fail` problem; the counts line gains `accepted <n>` (and `fail` leaves it out), the report lists `accepted by the owner (<n>):` with each cell and its ref, and the `frames:` line counts the frame under `accepted`. Queue files are deleted after 14 days, so copy a decision into the notes file before it expires.
Line 3 of the report, always: `frames: <p>/<total> compared and passing, <a> accepted by the owner, <n> not built` (`total` = matrix frames plus framesFile frames; `p` = frames with cells whose every cell passes with a passing compare record), or `frames: inventory off (...)` without a `figma` section. Paste it into the owner report.

## Results
`--results F` (repeatable): a JSON array (or `{"results":[...]}`) of `{surface,state,locale,width,status:"pass|fail",evidence}`,
the format `ui-check batch` writes to results.json. A record fills exactly the cell with the same surface, state, locale
and width (no fallback: a width-less record fills nothing and is `unmatched-result`). Per cell, a `fail` from any source
(the matrix cell or any record) wins; a declared `na` / `deferred` that meets a fail record is a `fail` and the message
says so; a `pass` record turns `todo`, `na` and `deferred` into `pass` but never clears a `fail`. A stale fail in an old
results file therefore keeps failing: delete or re-run it. A `fail` record from `ui-check batch` carries `part` (`compare` or `responsive`) and its pixel finding a `percent`; a failing compare is judged by the accepted rules below. A record that matches no cell is an `unmatched-result` problem whose message says what to change: a width outside `widths` (`add the design frame width 1440 to widths`; a Figma compare record carries the frame width), an unknown state (`use rest or <control>:<state>; run ui-coverage states`), an unknown surface, or an unknown locale. Locale tags match exactly, ignoring letter case only: record `FA` fills matrix `fa`, record `fa-IR` does not (add `fa-IR` to `locales`, or record `fa`); two matrix tags that differ only in case are a duplicate.

## check problems (exit 1)
`shape` (broken structure), `surface-controls`, `control-component`, `control-states`, `control-reference`,
`unproven-reuse`, `unproven-mount`, `duplicate-mount`, `unproven-reference`, `default-state`, `no-search` (`searched.backend` empty), `deliverable` (reviewUrl or mockExcluded empty),
`missing-cell`, `todo`, `fail`, `no-reason` (na/deferred), `no-evidence` (pass), `cell-status`, `unknown-cell`,
`duplicate-cell`, `bad-result`, `unmatched-result`, `evidence-missing`, `state-widths`, `todo` (also a `TODO` placeholder or an empty `controls: []`), `na-locale`, `no-rtl-pass` (an rtl locale exists but a surface has no rtl `pass`), the frame problems above, and `owner-ref` / `accepted-node`.

Output: the verdict first (`result: PASS`, or `result: FAIL, 268 cells, 8 causes`), the counts line, every `na` /
`deferred` cell with its reason (paste both into the owner report), the hand-set fails (cells with status `fail` in the
matrix and no result record: faults found by eye), then the problems grouped by code and root cause (same check and same
reason text or same finding): a group of one prints as a line, a larger group prints its count and its first three cells.
`--verbose` lists every problem. A failing cell's cause is the findings of its result record, else its `reason`.

## Layout
`ui-coverage.mjs` (CLI: arguments, files, printing), `lib/shape.mjs` (schema rules), `lib/states.mjs` (default states),
`lib/frames.mjs` (Figma frame inventory), `lib/accepted.mjs` (owner-accepted compare differences), `lib/cells.mjs` (cell set, expand, merge, unmatched-record advice), `lib/scaffold.mjs` (states skeleton), `lib/init.mjs` (matrix skeleton), `lib/reuse.mjs` (mount-site proof), `lib/group.mjs` (root-cause grouping), `lib/check.mjs` (the check), `lib/report.mjs` (text). Tests: `tests/ui-coverage*.test.mjs`.
