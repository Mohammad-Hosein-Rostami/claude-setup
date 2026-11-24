// Purpose: the Figma frame inventory of `check`: every frame of the design must be mapped to matrix cells (or marked not built),
// and every mapped cell needs a ui-check compare record. Also reads a frames file and builds the `frames:` summary line.
// Exports: readFramesFile(text), frameChecks(matrix, merged, records, options), framesLine(summary).
// Invariants: pure apart from the injected `readText`; never throws. The inventory is on only when the matrix has a `figma`
//   section; without one `frameChecks` reports `figma-section-missing` when compare records exist, and nothing else.
//   Node ids are compared in their API form (`12-40` is `12:40`). Problem codes: frame-source (unreadable, empty or another file), frame-missing, frame-unmapped, frame-cell, no-compare, figma-section-missing. A record counts
//   as a compare record only when it carries `part: "compare"` (ui-check batch writes it); a pass from another probe, or a
//   record without `part`, does not. A frame is "passing" when it has cells and every cell passes with a passing compare record.
import { resolve } from 'node:path';
import { cellKey, cellLabel, expectedCells, unmatchedAdvice } from './cells.mjs';
import { isReason, isText, normalizeNode, problem } from './shape.mjs';

const COMPARE = 'compare';
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the text of a frames file.
 * @param {string|null} text file text (null: no such file)
 * @returns {{file: string, frames: {node: string, name?: string, width?: number|null}[]}|null} null when it is not a frames file
 */
export function readFramesFile(text) {
  if (text === null) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null; // not JSON: the caller reports it as an unreadable frames file
  }
  const sound = isObject(data) && isText(data.file) && Array.isArray(data.frames) && data.frames.every((frame) => isObject(frame) && isText(frame.node));
  return sound ? data : null;
}

// Per cell key, the statuses of its compare records.
function compareStatuses(records) {
  const found = new Map();
  for (const record of records.filter((r) => isObject(r) && r.part === COMPARE && (r.status === 'pass' || r.status === 'fail'))) {
    found.set(cellKey(record), new Set([...(found.get(cellKey(record)) ?? []), record.status]));
  }
  return found;
}

const frameCells = (frame) => (Array.isArray(frame.cells) ? frame.cells : []).map((cell) => ({ surface: cell.surface, state: cell.state, locale: cell.locale, width: frame.width }));
const frameName = (frame) => `"${frame.name ?? ''}"`;

function cellProblems(matrix, frame, wanted, compared) {
  return frameCells(frame).flatMap((cell) => {
    const key = cellKey(cell);
    if (!wanted.has(key)) {
      const advice = unmatchedAdvice(matrix, cell, wanted).join('; ');
      return [problem('frame-cell', `frame ${frame.node} maps to ${cellLabel(cell)}, which is not a matrix cell: ${advice}`, { cell: cellLabel(cell), cause: `frame cell is not a matrix cell: ${advice}` })];
    }
    if (compared.has(key)) return [];
    return [problem('no-compare', `${cellLabel(cell)} has Figma frame ${frame.node} but no compare record; a pass from another probe does not count: run ui-check batch`, { cell: cellLabel(cell), cause: 'cell has a Figma frame but no compare record' })];
  });
}

function frameProblems(matrix, frame, wanted, compared) {
  if (frameCells(frame).length > 0) return cellProblems(matrix, frame, wanted, compared);
  if (isReason(frame.notBuilt)) return [];
  return [problem('frame-unmapped', `frame ${frame.node} ${frameName(frame)} maps to no cell: add cells [{surface,state,locale}] or notBuilt with a 15+ character reason`)];
}

function sourceProblems(matrix, source) {
  const { framesFile, file } = matrix.figma;
  if (source === null) return [problem('frame-source', `figma.framesFile ${framesFile} cannot be read or is not a frames file: write it with ui-check figma-frames`)];
  if (source.frames.length === 0) return [problem('frame-source', `figma.framesFile ${framesFile} lists no frame: write it with ui-check figma-frames`)];
  if (source.file !== file) return [problem('frame-source', `figma.file ${file} does not match file ${source.file} in ${framesFile}: use one Figma file`)];
  const listed = new Set((matrix.frames ?? []).map((frame) => normalizeNode(frame.node)));
  const missing = new Map(source.frames.filter((frame) => !listed.has(normalizeNode(frame.node))).map((frame) => [normalizeNode(frame.node), frame]));
  return [...missing.values()].map((frame) => problem('frame-missing', `frame ${frame.node} ${frameName(frame)} is in ${framesFile} but not in matrix frames: run expand, then map it or mark it notBuilt`));
}

// Counts for the `frames:` line; `accepted` holds the keys of cells with a difference accepted with a reason.
function summarize(matrix, source, merged, compared, accepted) {
  const frames = matrix.frames ?? [];
  const status = new Map(merged.cells.map((cell) => [cellKey(cell), cell.status]));
  const passes = (cell) => status.get(cellKey(cell)) === 'pass' && compared.get(cellKey(cell))?.has('pass');
  const settled = (frame) => frameCells(frame).length > 0 && frameCells(frame).every((cell) => passes(cell) || accepted.has(cellKey(cell)));
  const hasAccepted = (frame) => frameCells(frame).some((cell) => accepted.has(cellKey(cell)));
  return {
    inventory: true,
    total: new Set([...frames, ...(source?.frames ?? [])].map((frame) => normalizeNode(frame.node))).size,
    passing: frames.filter((frame) => settled(frame) && !hasAccepted(frame)).length,
    accepted: frames.filter((frame) => settled(frame) && hasAccepted(frame)).length,
    notBuilt: frames.filter((frame) => frameCells(frame).length === 0 && isReason(frame.notBuilt)).length,
  };
}

/**
 * The frame problems and the frames summary of one check.
 * @param {object} matrix a structurally sound matrix
 * @param {{cells: object[]}} merged the result of mergeResults
 * @param {unknown[]} records ui-check result records
 * @param {{baseDir: string, readText: (path: string) => string|null, accepted?: Set<string>}} options `accepted`: cell keys accepted with a reason (accepted.mjs)
 * @returns {{problems: object[], summary: {inventory: boolean, total?: number, passing?: number, accepted?: number, notBuilt?: number}}}
 */
export function frameChecks(matrix, merged, records, { baseDir, readText, accepted = new Set() }) {
  const compared = compareStatuses(records);
  if (!isObject(matrix.figma)) {
    const count = records.filter((record) => isObject(record) && record.part === COMPARE).length;
    const problems = count > 0 ? [problem('figma-section-missing', `results hold ${count} compare records but the matrix has no figma section: add figma.file and figma.framesFile`)] : [];
    return { problems, summary: { inventory: false } };
  }
  const source = readFramesFile(readText ? readText(resolve(baseDir, matrix.figma.framesFile)) : null);
  const wanted = new Map(expectedCells(matrix).map((cell) => [cellKey(cell), cell]));
  const problems = [...sourceProblems(matrix, source), ...(matrix.frames ?? []).flatMap((frame) => frameProblems(matrix, frame, wanted, compared))];
  return { problems, summary: summarize(matrix, source, merged, compared, accepted) };
}

/** The `frames:` line of the report. */
export function framesLine(summary) {
  if (!summary.inventory) return 'frames: inventory off (no figma section; add figma.file and figma.framesFile, then run expand)';
  return `frames: ${summary.passing}/${summary.total} compared and passing, ${summary.accepted} accepted, ${summary.notBuilt} not built`;
}
