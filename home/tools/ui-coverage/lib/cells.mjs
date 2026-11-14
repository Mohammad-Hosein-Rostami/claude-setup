// Purpose: the cell set a matrix demands, expansion into `todo` cells, and merging of ui-check result records.
// Exports: normalizeWidth, cellKey, expectedCells(matrix), expandMatrix(matrix), mergeResults(matrix, records).
// Invariants: pure (inputs are never mutated). A cell is identified by surface + state + locale + width. State ids are
//   `rest` (per width) and `<controlId>:<state>` (width null). A result record `{surface,state,locale,width,status,evidence}`
//   whose width has no cell falls back to the same state's width-null cell (ui-check records the viewport width).
//   A cell declared `na` or `deferred` is never overridden by a result; a `fail` record beats a `pass` record.
import { REST_STATE, controlsOf, isText, problem } from './shape.mjs';

/** Width as stored in a key: undefined, null and "" mean "no width" (null); anything else becomes a number. */
export const normalizeWidth = (width) => (width === undefined || width === null || width === '' ? null : Number(width));

/** Stable identity of a cell or result record. */
export const cellKey = (cell) => JSON.stringify([cell.surface, cell.state, cell.locale, normalizeWidth(cell.width)]);

/** Returns every {surface,state,locale,width} a structurally sound matrix demands, in a stable order. */
export function expectedCells(matrix) {
  return matrix.surfaces.flatMap((surface) =>
    matrix.locales.flatMap(({ tag: locale }) => [
      ...matrix.widths.map((width) => ({ surface: surface.id, state: REST_STATE, locale, width })),
      ...controlsOf(surface).flatMap((control) =>
        (Array.isArray(control.states) ? control.states : []).map((state) => ({ surface: surface.id, state: `${control.id}:${state}`, locale, width: null })),
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
  return null;
}

// The demanded key a record fills: its own key, else the same state's width-null key.
function targetKey(record, wanted) {
  const own = cellKey(record);
  if (wanted.has(own)) return own;
  const widthless = cellKey({ ...record, width: null });
  return wanted.has(widthless) ? widthless : null;
}

// fail beats pass; among equals the first record wins (its evidence is quoted).
const strongest = (records) => records.find((r) => r.status === 'fail') ?? records[0];

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
    const key = bad ? null : targetKey(record, wanted);
    if (bad) problems.push(problem('bad-result', `bad result record, ${bad}`));
    else if (key === null) problems.push(problem('unmatched-result', `result matches no cell: ${record.surface} ${record.state} ${record.locale} ${normalizeWidth(record.width)}`));
    else grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  for (const [key, group] of grouped) {
    const existing = byKey.get(key);
    if (existing && (existing.status === 'na' || existing.status === 'deferred')) continue;
    const winner = strongest(group);
    const base = existing ?? { ...wanted.get(key), reason: '' };
    byKey.set(key, { ...base, status: winner.status, evidence: winner.evidence ?? '' });
  }
  return { cells: [...byKey.values()], problems };
}
