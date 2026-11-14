// Purpose: the `check` logic of ui-coverage: validate the matrix, merge ui-check results, and list every reason it is not done.
// Exports: checkMatrix(matrix, records).
// Invariants: pure; never throws on bad input (a malformed matrix yields `shape` problems and stops). Done means
//   `problems` is empty. Problem codes: shape, surface-controls, control-component, control-states, control-reference,
//   default-state, no-search, deliverable, duplicate-cell, bad-result, unmatched-result, missing-cell, unknown-cell,
//   cell-status, todo, fail, no-reason, no-evidence, no-rtl-pass.
import { cellKey, expectedCells, mergeResults, normalizeWidth } from './cells.mjs';
import { STATUSES, isText, problem, validateRules, validateStructure } from './shape.mjs';

const label = (cell) => `${cell.surface} ${cell.state} ${cell.locale}${normalizeWidth(cell.width) === null ? '' : ` @${cell.width}`}`;

function cellProblem(cell) {
  if (!STATUSES.includes(cell.status)) return problem('cell-status', `status "${cell.status}" is not one of ${STATUSES.join('|')}: ${label(cell)}`);
  if (cell.status === 'todo') return problem('todo', `todo: ${label(cell)}`);
  if (cell.status === 'fail') return problem('fail', `fail: ${label(cell)}${isText(cell.evidence) ? ` (${cell.evidence})` : ''}`);
  if ((cell.status === 'na' || cell.status === 'deferred') && !isText(cell.reason)) return problem('no-reason', `${cell.status} without a reason: ${label(cell)}`);
  if (cell.status === 'pass' && !isText(cell.evidence)) return problem('no-evidence', `pass without evidence: ${label(cell)}`);
  return null;
}

function coverageProblems(matrix, cells) {
  const byKey = new Map(cells.map((cell) => [cellKey(cell), cell]));
  const expected = expectedCells(matrix);
  const wanted = new Set(expected.map(cellKey));
  const missing = expected.filter((cell) => !byKey.has(cellKey(cell))).map((cell) => problem('missing-cell', `missing cell: ${label(cell)}`));
  const unknown = cells.filter((cell) => !wanted.has(cellKey(cell))).map((cell) => problem('unknown-cell', `cell matches no surface, state, locale or width: ${label(cell)}`));
  const judged = expected.map((cell) => byKey.get(cellKey(cell))).filter(Boolean).map(cellProblem).filter(Boolean);
  return [...missing, ...unknown, ...judged];
}

function rtlProblems(matrix, cells) {
  const rtl = new Set(matrix.locales.filter((locale) => locale.dir === 'rtl').map((locale) => locale.tag));
  if (rtl.size === 0) return [];
  const covered = new Set(cells.filter((cell) => cell.status === 'pass' && rtl.has(cell.locale)).map((cell) => cell.surface));
  return matrix.surfaces
    .filter((surface) => !covered.has(surface.id))
    .map((surface) => problem('no-rtl-pass', `surface ${surface.id} has no passing cell in an rtl locale (${[...rtl].join(', ')})`));
}

const countBy = (cells, status) => cells.filter((cell) => cell.status === status).length;

/**
 * Checks a matrix against its cells and result records.
 * @param {unknown} matrix the parsed matrix.json
 * @param {unknown[]} [records] ui-check result records `{surface,state,locale,width,status,evidence}`
 * @returns {{problems: {code:string,message:string}[], cells: object[], counts: object, notes: object[]}} `problems` empty means
 *   done; `counts` has pass/fail/na/deferred/todo/missing; `notes` are the na and deferred cells (reported to the owner)
 */
export function checkMatrix(matrix, records = []) {
  const structure = validateStructure(matrix);
  if (structure.length > 0) return { problems: structure, cells: [], counts: {}, notes: [] };
  const merged = mergeResults(matrix, records);
  const coverage = coverageProblems(matrix, merged.cells);
  const counts = Object.fromEntries(STATUSES.map((status) => [status, countBy(merged.cells, status)]));
  counts.missing = coverage.filter((p) => p.code === 'missing-cell').length;
  return {
    problems: [...validateRules(matrix), ...merged.problems, ...coverage, ...rtlProblems(matrix, merged.cells)],
    cells: merged.cells,
    counts,
    notes: merged.cells.filter((cell) => cell.status === 'na' || cell.status === 'deferred'),
  };
}
