# ui-coverage

Checks the coverage matrix of a UI task: every surface x state x locale (x width) must be `pass`, or `na` / `deferred`
with a reason. Done = `check` exits 0. Node 22, no dependencies. Skill: `skills/ui-coverage/SKILL.md`.

Run: `node ~/.claude/tools/ui-coverage/ui-coverage.mjs <command>`

| Command | What it does |
| ------- | ------------ |
| `expand <matrix> [--out F]` | Adds a `todo` cell for every surface x state x locale that is missing (`rest` also per width). Idempotent; writes the matrix in place. Exit 1 (file untouched) when the matrix structure is broken. |
| `check <matrix> [--results F]...` | Validates, merges result records, prints the summary, exits 0 (complete) or 1 (problems). Never writes. Exit 2: bad flag, unreadable or invalid JSON. |

## matrix.json
```
{ locales:[{tag,dir:"ltr|rtl"}], widths:[n], searched:{backend:[str], siblings:[str]},
  deliverable:{reviewUrl, mockExcluded},
  surfaces:[{ id, kind:"screen|email|server-page|pdf|notification|other", source,
    controls:[{ id, class, component:"<path>"|{new:"<reason>"}, states:[str], reference:"<path>|none: <reason>",
                dropped?:{ "<state>":"<reason>" } }] | "none: <reason>" }],
  cells:[{ surface, state:"<control>:<state>"|"rest", locale, width|null, status:"pass|fail|na|deferred|todo", evidence, reason }] }
```
- State ids: `rest` (one cell per width) and `<controlId>:<state>` (width `null`).
- `dropped` (extension to the spec'd schema, optional): the default states of a control class (select: rest, focus, open,
  option-hover, selected, disabled, error; checkbox/radio/switch: unchecked, checked, indeterminate, focus, disabled,
  error; text field: empty, focus, filled, error, success, disabled; button: rest, hover, focus, active, disabled,
  loading; dialog/toast/tooltip/popover: shown; async: loading, empty, error) must be in `states` or in `dropped` with a
  reason. An unknown class has no defaults. Aliases are in `lib/states.mjs`.

## Results
`--results F` (repeatable): a JSON array (or `{"results":[...]}`) of `{surface,state,locale,width,status:"pass|fail",evidence}`,
the format `ui-check batch` writes to results.json. A record fills the cell with the same surface, state, locale and
width; a record with a viewport width fills the same state's width-less cell. `fail` beats `pass`; a cell declared `na` or
`deferred` is not overridden. A record that matches no cell is a problem (usually a misspelled id).

## check problems (exit 1)
`shape` (broken structure), `surface-controls`, `control-component`, `control-states`, `control-reference`,
`default-state`, `no-search` (`searched.backend` empty), `deliverable` (reviewUrl or mockExcluded empty),
`missing-cell`, `todo`, `fail`, `no-reason` (na/deferred), `no-evidence` (pass), `cell-status`, `unknown-cell`,
`duplicate-cell`, `bad-result`, `unmatched-result`, `no-rtl-pass` (an rtl locale exists but a surface has no rtl `pass`).

Output: a counts line, every `na` / `deferred` cell with its reason (paste both into the owner report), the problems, then
`result: PASS|FAIL`.

## Layout
`ui-coverage.mjs` (CLI: arguments, files, printing), `lib/shape.mjs` (schema rules), `lib/states.mjs` (default states),
`lib/cells.mjs` (cell set, expand, merge), `lib/check.mjs` (the check), `lib/report.mjs` (text). Tests: `tests/ui-coverage*.test.mjs`.
