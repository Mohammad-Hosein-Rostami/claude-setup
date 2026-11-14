// Purpose: the cell set a matrix demands, expansion into `todo` cells, and merging of ui-check result records.
// Exports: normalizeWidth, cellKey, expectedCells(matrix), expandMatrix(matrix), mergeResults(matrix, records).
// Invariants: pure (inputs are never mutated). A cell is identified by surface + state + locale + width; the locale tag is
//   compared exactly but ignoring letter case (`FA` is `fa`; `fa-IR` is not `fa`). State ids are
//   `rest` and `<controlId>:<state>`; EVERY state is demanded at every width of `widths` for every locale (control
//   states only at `stateWidths` when the matrix narrows them). A result record fills exactly its own key; there is no
//   width fallback. Merge per key: a `fail` from any source (matrix cell or any record) wins over everything, and a
//   declared na/deferred that meets a fail record becomes a `fail` carrying `declared`; a `pass` record turns a
//   todo/na/deferred cell into pass but never clears a fail.
import { REST_STATE, controlsOf, isText, isValidWidth, problem } from './shape.mjs';

/** Width as stored in a key: undefined means "no width" (null); a valid width is kept as is. */
export const normalizeWidth = (width) => (width === undefined ? null : width);

/** Locale tag as compared: letter case is ignored, nothing else (no region fallback). */
export const normalizeLocale = (locale) => (typeof locale === 'string' ? locale.toLowerCase() : locale);

/** Stable identity of a cell or result record. */
export const cellKey = (cell) => JSON.stringify([cell.surface, cell.state, normalizeLocale(cell.locale), normalizeWidth(cell.width)]);

/** Returns every {surface,state,locale,width} a structurally sound matrix demands, in a stable order. */
export function expectedCells(matrix) {
  const stateWidths = matrix.stateWidths ?? matrix.widths;
  return matrix.surfaces.flatMap((surface) =>
    matrix.locales.flatMap(({ tag: locale }) => [
      ...matrix.widths.map((width) => ({ surface: surface.id, state: REST_STATE, locale, width })),
      ...controlsOf(surface).flatMap((control) =>
        (Array.isArray(control.states) ? control.states : []).flatMap((state) =>
          stateWidths.map((width) => ({ surface: surface.id, state: `${control.id}:${state}`, locale, width })),
        ),
      ),
    ]),
  );
}

/**
 * Adds a `todo` cell for every demanded cell that is missing; existing cells are kept as they are.
 * @param {object} matrix a structurally sound matrix
 * @returns {object} a new matrix; expanding it again returns an equal matrix
 */
export function expandMatrix(matrix) {
  const cells = matrix.cells ?? [];
  const have = new Set(cells.map(cellKey));
  const added = expectedCells(matrix)
    .filter((cell) => !have.has(cellKey(cell)))
    .map((cell) => ({ ...cell, status: 'todo', evidence: '', reason: '' }));
  return { ...matrix, cells: [...cells, ...added] };
}

const list = (values) => [...new Set(values)].join(', ');

// Why a well-formed record fills no cell, and what to change; one sentence per wrong part (surface, state, locale, width).
function unmatchedAdvice(matrix, record, wanted) {
  const cells = [...wanted.values()];
  const ofSurface = cells.filter((cell) => cell.surface === record.surface);
  if (ofSurface.length === 0) return [`unknown surface "${record.surface}": use a matrix surface id (${list(cells.map((cell) => cell.surface))})`];
  const advice = [];
  const locale = normalizeLocale(record.locale);
  if (!ofSurface.some((cell) => cell.state === record.state)) advice.push(`unknown state "${record.state}": use rest or <control>:<state>; run \`ui-coverage states\``);
  if (!matrix.locales.some((entry) => normalizeLocale(entry.tag) === locale)) {
    const near = matrix.locales.find((entry) => locale.startsWith(`${normalizeLocale(entry.tag)}-`) || normalizeLocale(entry.tag).startsWith(`${locale}-`));
    advice.push(near
      ? `locale "${record.locale}" does not match "${near.tag}": tags match exactly (letter case aside); use "${near.tag}" in the record, or add "${record.locale}" to locales`
      : `unknown locale "${record.locale}": add it to locales, or use one of ${list(matrix.locales.map((entry) => entry.tag))}`);
  }
  if (record.width === null || record.width === undefined) advice.push('no width: a record needs the viewport width it was measured at, as an integer (ui-check batch writes it)');
  else if (!matrix.widths.includes(record.width)) advice.push(`width ${record.width} is not in widths: add the design frame width ${record.width} to widths, or measure at one of ${list(matrix.widths)}`);
  if (advice.length > 0) return advice;
  const stateWidths = ofSurface.filter((cell) => cell.state === record.state).map((cell) => cell.width);
  return [`state "${record.state}" is demanded only at width ${list(stateWidths)} (stateWidths): measure it there, or remove stateWidths`];
}

function recordProblem(record) {
  if (typeof record !== 'object' || record === null) return `not an object: ${JSON.stringify(record)}`;
  if (![record.surface, record.state, record.locale].every(isText)) return `needs surface, state and locale: ${JSON.stringify(record)}`;
  if (record.status !== 'pass' && record.status !== 'fail') return `status must be pass or fail: ${JSON.stringify(record)}`;
  if (!isValidWidth(record.width)) return `width must be a positive integer or null: ${JSON.stringify(record)}`;
  return null;
}

// One cell from its declared form plus the records that hit its key (see the invariants above).
function resolveCell(base, group) {
  const failRecord = group.find((record) => record.status === 'fail');
  if (failRecord || base.status === 'fail') {
    const declared = failRecord && (base.status === 'na' || base.status === 'deferred') ? { declared: base.status } : {};
    return { ...base, ...declared, status: 'fail', evidence: failRecord?.evidence ?? base.evidence ?? '', findings: failRecord?.findings ?? base.findings };
  }
  const passRecord = group.find((record) => record.status === 'pass');
  return passRecord ? { ...base, status: 'pass', evidence: passRecord.evidence ?? '' } : base;
}

/**
 * Applies result records to the matrix cells.
 * @param {object} matrix a structurally sound matrix
 * @param {unknown[]} records ui-check result records
 * @returns {{cells: object[], recorded: Set<string>, problems: {code:string,message:string}[]}} merged cells (duplicates
 *   reported, first kept; a failing cell carries the `findings` of its fail record), the keys that at least one record
 *   filled, plus `bad-result`, `unmatched-result` and `duplicate-cell` problems
 */
export function mergeResults(matrix, records) {
  const problems = [];
  const byKey = new Map();
  for (const cell of matrix.cells ?? []) {
    if (byKey.has(cellKey(cell))) problems.push(problem('duplicate-cell', `duplicate cell: ${cell.surface} ${cell.state} ${cell.locale} ${normalizeWidth(cell.width)}`));
    else byKey.set(cellKey(cell), cell);
  }
  const wanted = new Map(expectedCells(matrix).map((cell) => [cellKey(cell), cell]));
  const grouped = new Map();
  for (const record of records) {
    const bad = recordProblem(record);
    if (bad) {
      problems.push(problem('bad-result', `bad result record, ${bad}`));
    } else if (wanted.has(cellKey(record))) {
      grouped.set(cellKey(record), [...(grouped.get(cellKey(record)) ?? []), record]);
    } else {
      problems.push(problem('unmatched-result', `result matches no cell: ${record.surface} ${record.state} ${record.locale} ${normalizeWidth(record.width)} - ${unmatchedAdvice(matrix, record, wanted).join('; ')}`));
    }
  }
  for (const [key, group] of grouped) byKey.set(key, resolveCell(byKey.get(key) ?? { ...wanted.get(key), status: 'todo', evidence: '', reason: '' }, group));
  return { cells: [...byKey.values()], recorded: new Set(grouped.keys()), problems };
}
