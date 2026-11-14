// Purpose: the cell set a matrix demands, expansion into `todo` cells, and merging of ui-check result records.
// Exports: normalizeWidth, cellKey, expectedCells(matrix), expandMatrix(matrix), mergeResults(matrix, records).
// Invariants: pure (inputs are never mutated). A cell is identified by surface + state + locale + width. State ids are
//   `rest` and `<controlId>:<state>`; EVERY state is demanded at every width of `widths` for every locale (control
//   states only at `stateWidths` when the matrix narrows them). A result record fills exactly its own key; there is no
//   width fallback. Merge per key: a `fail` from any source (matrix cell or any record) wins over everything, and a
//   declared na/deferred that meets a fail record becomes a `fail` carrying `declared`; a `pass` record turns a
//   todo/na/deferred cell into pass but never clears a fail.
import { REST_STATE, controlsOf, isText, isValidWidth, problem } from './shape.mjs';

/** Width as stored in a key: undefined means "no width" (null); a valid width is kept as is. */
export const normalizeWidth = (width) => (width === undefined ? null : width);

/** Stable identity of a cell or result record. */
export const cellKey = (cell) => JSON.stringify([cell.surface, cell.state, cell.locale, normalizeWidth(cell.width)]);

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
    return { ...base, ...declared, status: 'fail', evidence: failRecord?.evidence ?? base.evidence ?? '' };
  }
  const passRecord = group.find((record) => record.status === 'pass');
  return passRecord ? { ...base, status: 'pass', evidence: passRecord.evidence ?? '' } : base;
}

/**
 * Applies result records to the matrix cells.
 * @param {object} matrix a structurally sound matrix
 * @param {unknown[]} records ui-check result records
 * @returns {{cells: object[], problems: {code:string,message:string}[]}} merged cells (duplicates reported, first kept)
 *   plus `bad-result`, `unmatched-result` and `duplicate-cell` problems
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
      problems.push(problem('unmatched-result', `result matches no cell: ${record.surface} ${record.state} ${record.locale} ${normalizeWidth(record.width)}`));
    }
  }
  for (const [key, group] of grouped) byKey.set(key, resolveCell(byKey.get(key) ?? { ...wanted.get(key), status: 'todo', evidence: '', reason: '' }, group));
  return { cells: [...byKey.values()], problems };
}
