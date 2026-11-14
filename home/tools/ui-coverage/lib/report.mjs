// Purpose: the text `ui-coverage check` prints: counts per status, every na/deferred line with its reason, then problems.
// Exports: formatReport(result).
// Invariants: pure; the first line is always the counts line (the owner report pastes it); na/deferred lines are printed
//   whenever they exist, also when the check passes.

const COUNT_ORDER = ['pass', 'fail', 'na', 'deferred', 'todo', 'missing'];

const noteLine = (cell) => `${cell.status}: ${cell.surface} ${cell.state} ${cell.locale}${cell.width === null || cell.width === undefined ? '' : ` @${cell.width}`} - ${String(cell.reason ?? '').trim()}`;

/**
 * Formats a checkMatrix result for the terminal and the owner report.
 * @param {{problems: {code:string,message:string}[], cells: object[], counts: object, notes: object[]}} result
 * @returns {string} multi-line text ending with `result: PASS` or `result: FAIL`
 */
export function formatReport(result) {
  const { problems, cells, counts, notes } = result;
  const lines = [`cells: ${cells.length} | ${COUNT_ORDER.map((status) => `${status} ${counts[status] ?? 0}`).join(' | ')}`];
  if (notes.length > 0) lines.push(`not covered (${notes.length}):`, ...notes.map((cell) => `  ${noteLine(cell)}`));
  if (problems.length > 0) lines.push(`problems (${problems.length}):`, ...problems.map((p) => `  [${p.code}] ${p.message}`));
  lines.push(`result: ${problems.length === 0 ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}
