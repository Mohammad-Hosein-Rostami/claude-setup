// Purpose: the `check` logic of ui-coverage: validate the matrix, merge ui-check results, and list every reason it is not done.
// Exports: checkMatrix(matrix, records, options).
// Invariants: pure apart from the injected `fileExists` and `readText`; never throws on bad input (a malformed matrix
//   yields `shape` problems and stops). Done means `problems` is empty. Problem codes: shape, surface-controls,
//   control-component, control-states, control-reference, unproven-reference, unproven-reuse, unproven-mount,
//   default-state, state-widths, no-search, deliverable, duplicate-cell, bad-result, unmatched-result, missing-cell,
//   unknown-cell, cell-status, todo, fail, no-reason, no-evidence, evidence-missing, na-locale, no-rtl-pass. A problem
//   about a cell carries `cell` (its label) and `cause` (what `report` groups by). A cell with status fail in the
//   matrix and no result record is `handSet` (found by eye, listed on its own).
import { isAbsolute, resolve } from 'node:path';
import { cellKey, expectedCells, mergeResults, normalizeWidth } from './cells.mjs';
import { failCause } from './group.mjs';
import { reuseProblems } from './reuse.mjs';
import { MIN_REASON_CHARS, STATUSES, isPlaceholder, isReason, isText, problem, validateRules, validateStructure } from './shape.mjs';

const URL_EVIDENCE = /^(https?|file):\/\//i;

const label = (cell) => `${cell.surface} ${cell.state} ${cell.locale}${normalizeWidth(cell.width) === null ? '' : ` @${cell.width}`}`;

function cellProblem(cell) {
  const at = (code, message, cause) => problem(code, message, { cell: label(cell), cause });
  if (!STATUSES.includes(cell.status)) return at('cell-status', `status "${cell.status}" is not one of ${STATUSES.join('|')}: ${label(cell)}`, `status "${cell.status}" is not valid`);
  if (cell.status === 'todo') return at('todo', `todo: ${label(cell)}`, 'cell is still todo');
  if (cell.status === 'fail') {
    const declared = cell.declared ? ` (declared ${cell.declared}, but a result failed)` : '';
    return at('fail', `fail: ${label(cell)}${declared}${isText(cell.evidence) ? ` [${cell.evidence}]` : ''}`, failCause(cell));
  }
  if ((cell.status === 'na' || cell.status === 'deferred') && !isReason(cell.reason)) {
    return at('no-reason', `${cell.status} needs a reason of at least ${MIN_REASON_CHARS} characters: ${label(cell)}`, `${cell.status} without a reason of ${MIN_REASON_CHARS}+ characters`);
  }
  if (cell.status === 'pass' && !isText(cell.evidence)) return at('no-evidence', `pass without evidence: ${label(cell)}`, 'pass without evidence');
  return null;
}

function coverageProblems(matrix, cells) {
  const byKey = new Map(cells.map((cell) => [cellKey(cell), cell]));
  const expected = expectedCells(matrix);
  const wanted = new Set(expected.map(cellKey));
  const missing = expected.filter((cell) => !byKey.has(cellKey(cell))).map((cell) => problem('missing-cell', `missing cell: ${label(cell)}`, { cell: label(cell), cause: 'cell missing from the matrix' }));
  const unknown = cells.filter((cell) => !wanted.has(cellKey(cell))).map((cell) => problem('unknown-cell', `cell matches no surface, state, locale or width: ${label(cell)}`, { cell: label(cell), cause: 'cell matches no surface, state, locale or width' }));
  const judged = expected.map((cell) => byKey.get(cellKey(cell))).filter(Boolean).map(cellProblem).filter(Boolean);
  return [...missing, ...unknown, ...judged];
}

// A locale other than the base (first) one may be `na` only where the base locale is `na` for the same surface, state and width.
function naLocaleProblems(matrix, cells) {
  const base = matrix.locales[0].tag;
  const baseNa = new Set(cells.filter((cell) => cell.locale === base && cell.status === 'na').map((cell) => cellKey({ ...cell, locale: '' })));
  return cells
    .filter((cell) => cell.locale !== base && cell.status === 'na' && !baseNa.has(cellKey({ ...cell, locale: '' })))
    .map((cell) => problem('na-locale', `na in ${cell.locale} but not in base locale ${base}: make it pass, or deferred with a reason: ${label(cell)}`, { cell: label(cell), cause: 'na in a non-base locale only' }));
}

// A surface whose rtl cells are still todo is already reported as todo; this rule is for surfaces that are otherwise settled.
function rtlProblems(matrix, cells) {
  const rtl = new Set(matrix.locales.filter((locale) => locale.dir === 'rtl').map((locale) => locale.tag));
  if (rtl.size === 0) return [];
  const covered = new Set(cells.filter((cell) => (cell.status === 'pass' || cell.status === 'todo') && rtl.has(cell.locale)).map((cell) => cell.surface));
  return matrix.surfaces
    .filter((surface) => !covered.has(surface.id))
    .map((surface) => problem('no-rtl-pass', `surface ${surface.id} has no passing cell in an rtl locale (${[...rtl].join(', ')})`));
}

// Non-URL evidence of a passing cell, and a non-URL reviewUrl, must be existing files (relative: from the matrix directory).
function fileProblems(matrix, cells, { baseDir, fileExists }) {
  const exists = (value) => URL_EVIDENCE.test(value.trim()) || fileExists(isAbsolute(value) ? value : resolve(baseDir, value.trim()));
  const evidence = cells
    .filter((cell) => cell.status === 'pass' && isText(cell.evidence) && !exists(cell.evidence))
    .map((cell) => problem('evidence-missing', `evidence file does not exist (${cell.evidence}): ${label(cell)}`, { cell: label(cell), cause: 'evidence file does not exist' }));
  const url = matrix.deliverable?.reviewUrl;
  const review = isText(url) && !isPlaceholder(url) && !exists(url) ? [problem('deliverable', `deliverable.reviewUrl is neither a URL nor an existing path: ${url}`)] : [];
  return [...evidence, ...review];
}

const countBy = (cells, status) => cells.filter((cell) => cell.status === status).length;

/**
 * Checks a matrix against its cells and result records.
 * @param {unknown} matrix the parsed matrix.json
 * @param {unknown[]} [records] ui-check result records `{surface,state,locale,width,status,evidence}`
 * @param {{baseDir?: string, fileExists?: (path: string) => boolean, readText?: (path: string) => string|null}} [options]
 *   where relative paths resolve from (the matrix file's directory), how to test a file and how to read one (null = no
 *   such file); the default accepts every evidence path and skips the mount-site file tests (the CLI passes the real ones)
 * @returns {{problems: {code:string,message:string}[], cells: object[], counts: object, notes: object[], handSet: object[], stateWidths: object|null}}
 *   `problems` empty means done; `counts` has pass/fail/na/deferred/todo/missing; `notes` are the na and deferred cells
 *   (reported to the owner); `handSet` are the fail cells nobody measured; `stateWidths` is `{widths, reason}` when control states are narrowed, else null
 */
export function checkMatrix(matrix, records = [], options = {}) {
  const structure = validateStructure(matrix);
  if (structure.length > 0) return { problems: structure, cells: [], counts: {}, notes: [], handSet: [], stateWidths: null };
  const merged = mergeResults(matrix, records);
  const coverage = coverageProblems(matrix, merged.cells);
  const files = { baseDir: options.baseDir ?? '.', fileExists: options.fileExists ?? (() => true) };
  const counts = Object.fromEntries(STATUSES.map((status) => [status, countBy(merged.cells, status)]));
  counts.missing = coverage.filter((p) => p.code === 'missing-cell').length;
  return {
    problems: [...validateRules(matrix), ...reuseProblems(matrix, { baseDir: files.baseDir, readText: options.readText }), ...merged.problems, ...coverage, ...naLocaleProblems(matrix, merged.cells), ...rtlProblems(matrix, merged.cells), ...fileProblems(matrix, merged.cells, files)],
    cells: merged.cells,
    counts,
    notes: merged.cells.filter((cell) => cell.status === 'na' || cell.status === 'deferred'),
    handSet: merged.cells.filter((cell) => cell.status === 'fail' && !merged.recorded.has(cellKey(cell))),
    stateWidths: matrix.stateWidths ? { widths: matrix.stateWidths, reason: String(matrix.stateWidthsReason ?? '').trim() } : null,
  };
}
