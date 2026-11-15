// Purpose: the text `ui-coverage check` prints: the verdict, counts per status, every na/deferred line with its reason, the
//   hand-set fails, then the problems grouped by kind and root cause (or every one with `verbose`).
// Exports: formatReport(result, options).
// Invariants: pure; the first line is always the verdict (`result: PASS` or `result: FAIL, <n> cells, <m> causes`; the
//   cells part is left out when no problem belongs to a cell); the counts line is second (the owner report pastes it); the
//   `frames:` line is third whenever the result has a frames summary (the owner report pastes it too); an `accepted by the
//   owner (<n>):` section lists each accepted cell with its owner ref; the state-widths narrowing, the na/deferred lines and the hand-set fails are printed whenever they exist, also when the
//   check passes. A group of one problem prints as a plain line; a larger group prints a header with its count and the
//   first EXAMPLES_PER_GROUP problems, each as its own plain line.
import { framesLine } from './frames.mjs';
import { EXAMPLES_PER_GROUP, groupProblems } from './group.mjs';

const COUNT_ORDER = ['pass', 'fail', 'accepted', 'na', 'deferred', 'todo', 'missing'];

// The `accepted` count is shown only when the owner accepted something, so a report without Figma frames reads as before.
const shownCounts = (counts) => COUNT_ORDER.filter((status) => status !== 'accepted' || counts.accepted > 0).map((status) => `${status} ${counts[status] ?? 0}`);
const cellText = (cell) => `${cell.surface} ${cell.state} ${cell.locale}${cell.width === null || cell.width === undefined ? '' : ` @${cell.width}`}`;
const noteLine = (cell) => `${cell.status}: ${cellText(cell)} - ${String(cell.reason ?? '').trim() || `evidence ${cell.evidence ?? 'none'}`}`;
const problemLine = (p, indent) => `${indent}[${p.code}] ${p.message}`;

function verdict(problems, groups) {
  if (problems.length === 0) return 'result: PASS';
  const cells = new Set(problems.map((p) => p.cell).filter(Boolean)).size;
  return `result: FAIL, ${cells > 0 ? `${cells} cell${cells === 1 ? '' : 's'}, ` : ''}${groups.length} cause${groups.length === 1 ? '' : 's'}`;
}

function groupLines(group) {
  if (group.problems.length === 1) return [problemLine(group.problems[0], '  ')];
  const unit = group.problems.every((p) => p.cell) ? 'cells' : 'problems';
  const shown = group.problems.slice(0, EXAMPLES_PER_GROUP);
  const more = group.problems.length - shown.length;
  return [
    `  [${group.code}] ${group.problems.length} ${unit}: ${group.cause}`,
    ...shown.map((p) => problemLine(p, '    ')),
    ...(more > 0 ? [`    ... and ${more} more (--verbose lists every one)`] : []),
  ];
}

/**
 * Formats a checkMatrix result for the terminal and the owner report.
 * @param {{problems: {code:string,message:string,cell?:string,cause?:string}[], cells: object[], counts: object, notes: object[], handSet?: object[], stateWidths: object|null, frames?: object, accepted?: object[]}} result
 * @param {{verbose?: boolean}} [options] `verbose` lists every problem instead of the groups
 * @returns {string} multi-line text whose first line is the verdict
 */
export function formatReport(result, { verbose = false } = {}) {
  const { problems, cells, counts, notes, stateWidths } = result;
  const handSet = result.handSet ?? [];
  const groups = groupProblems(problems);
  const lines = [verdict(problems, groups), `cells: ${cells.length} | ${shownCounts(counts).join(' | ')}`];
  if (result.frames) lines.push(framesLine(result.frames));
  if (stateWidths) lines.push(`control states checked only at ${stateWidths.widths.join(', ')} px: ${stateWidths.reason}`);
  const accepted = result.accepted ?? [];
  if (accepted.length > 0) lines.push(`accepted by the owner (${accepted.length}):`, ...accepted.map((item) => `  ${item.cell} (frame ${item.node}) - ${item.ref}`));
  if (notes.length > 0) lines.push(`not covered (${notes.length}):`, ...notes.map((cell) => `  ${noteLine(cell)}`));
  if (handSet.length > 0) lines.push(`hand-set fails, found by eye, no tool result (${handSet.length}):`, ...handSet.map((cell) => `  ${noteLine(cell)}`));
  if (problems.length > 0 && verbose) lines.push(`problems (${problems.length}):`, ...problems.map((p) => problemLine(p, '  ')));
  else if (problems.length > 0) lines.push(`problems (${problems.length} in ${groups.length} group${groups.length === 1 ? '' : 's'}):`, ...groups.flatMap(groupLines));
  return lines.join('\n');
}
