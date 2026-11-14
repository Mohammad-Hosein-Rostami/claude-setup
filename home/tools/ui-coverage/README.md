# ui-coverage

Checks the coverage matrix of a UI task: every surface x state x locale x width must be `pass`, or `na` / `deferred`
with a reason. Done = `check` exits 0. Node 22, no dependencies. Skill: `skills/ui-coverage/SKILL.md`.

Run: `node ~/.claude/tools/ui-coverage/ui-coverage.mjs <command>`

| Command | What it does |
| ------- | ------------ |
| `expand <matrix> [--out F]` | Adds a `todo` cell for every surface x state x locale that is missing (`rest` also per width). Idempotent; writes the matrix in place. Exit 1 (file untouched) when the matrix structure is broken. |
| `states` | Prints the default states per control class (the single list, `lib/states.mjs`). |
| `check <matrix> [--results F]...` | Validates, merges result records, prints the summary, exits 0 (complete) or 1 (problems). Never writes. Exit 2: bad flag, unreadable or invalid JSON. |

## matrix.json
```
{ locales:[{tag,dir:"ltr|rtl"}],      // the first locale is the base locale
  widths:[n], stateWidths?:[n], stateWidthsReason?,   // stateWidths: subset of widths, narrows control states only
  searched:{backend:[str], siblings:[str]}, deliverable:{reviewUrl, mockExcluded},
  surfaces:[{ id, kind:"screen|email|server-page|pdf|notification|other", source,
    controls:[{ id, class, component:"<path>"|{new:"<reason>"}, states:[str], reference:"<path>|none: <reason>",
                dropped?:{ "<state>":"<reason>" } }] | "none: <reason>" }],
  cells:[{ surface, state:"<control>:<state>"|"rest", locale, width, status:"pass|fail|na|deferred|todo", evidence, reason }] }
```
- State ids: `rest` and `<controlId>:<state>`. EVERY state is demanded at every width of `widths` for every locale, so each
  cell has a positive-integer `width`. `stateWidths` narrows control states only (`rest` keeps every width) and needs
  `stateWidthsReason`; the reason is printed in the summary.
- `class` is required: a known class or `other` (then `states` must be listed). Run `ui-coverage.mjs states` for the
  classes and their default states; a default state must be in `states` or in `dropped` with a reason. A misspelled class is a
  schema error naming the control.
- Reasons (`na`, `deferred`, `{new:}`, `none:`, `dropped`, `stateWidthsReason`) and `deliverable.mockExcluded` need 15+
  non-space characters. Widths are positive integers; anything else is a schema error (a bad record width is `bad-result`).
- Evidence of a `pass` cell is a http(s) or file URL, or an existing file (a relative path resolves from the matrix file's
  directory). `deliverable.reviewUrl` is a URL or an existing path.
- A `na` cell in a non-base locale is allowed only when the same surface, state and width is `na` in the base locale;
  otherwise it must be `pass` or `deferred` with a reason.

## Results
`--results F` (repeatable): a JSON array (or `{"results":[...]}`) of `{surface,state,locale,width,status:"pass|fail",evidence}`,
the format `ui-check batch` writes to results.json. A record fills exactly the cell with the same surface, state, locale
and width (no fallback: a width-less record fills nothing and is `unmatched-result`). Per cell, a `fail` from any source
(the matrix cell or any record) wins; a declared `na` / `deferred` that meets a fail record is a `fail` and the message
says so; a `pass` record turns `todo`, `na` and `deferred` into `pass` but never clears a `fail`. A stale fail in an old
results file therefore keeps failing: delete or re-run it. A record that matches no cell is a problem (usually a misspelled id).

## check problems (exit 1)
`shape` (broken structure), `surface-controls`, `control-component`, `control-states`, `control-reference`,
`default-state`, `no-search` (`searched.backend` empty), `deliverable` (reviewUrl or mockExcluded empty),
`missing-cell`, `todo`, `fail`, `no-reason` (na/deferred), `no-evidence` (pass), `cell-status`, `unknown-cell`,
`duplicate-cell`, `bad-result`, `unmatched-result`, `evidence-missing`, `state-widths`, `na-locale`, `no-rtl-pass` (an rtl locale exists but a surface has no rtl `pass`).

Output: a counts line, every `na` / `deferred` cell with its reason (paste both into the owner report), the problems, then
`result: PASS|FAIL`.

## Layout
`ui-coverage.mjs` (CLI: arguments, files, printing), `lib/shape.mjs` (schema rules), `lib/states.mjs` (default states),
`lib/cells.mjs` (cell set, expand, merge), `lib/check.mjs` (the check), `lib/report.mjs` (text). Tests: `tests/ui-coverage*.test.mjs`.
