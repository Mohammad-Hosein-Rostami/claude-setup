// The `defect` command of status.mjs: marks a work row as reported broken by the owner and, on the second report of the same
// row, routes it to root-cause work before any fix.
// Exports: markDefect(lines, words, table), DEFECT_TAG.
// Why: 8 recurring defects made 26 of 66 owner reports (one came back 6 times); a second report fixed again by guess is the pattern
// this stops. The mark lives in the row's item cell (`[defect <n>]`), so it needs no new column and the estimator reads the row as before.
// Invariants: changes only the marked row and, from the second report on, adds one `rootcause:<id>` row (once); a done row may be
// marked (a defect is usually reported after delivery) and its done cell is never changed.

export const DEFECT_TAG = /\s*\[defect (\d+)\]$/;
const ROOT_CAUSE_PREFIX = 'rootcause:';
const ROOT_CAUSE_SIZE = 'M';
const MAX_ID_LENGTH = 40; // the status ID pattern's limit

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/** The note for the n-th report of a row. */
function routeNote(id, count, rootCauseId) {
  if (count < 2) return `defect 1 on ${id}: reproduce it under the owner's conditions, fix the root cause, and add a regression test that fails without the fix`;
  return `defect ${count} on ${id}: a second report: root-cause first (row ${rootCauseId}): reproduce it under the owner's conditions (zoom, pixel ratio, OS, theme, data), `
    + 'then a root-cause agent (deep-debugger, root-cause-debug skill) before any fix; the condition joins the UI matrix for good and the defect gets a regression test';
}

/**
 * Marks row `id` as an owner-reported defect: `[defect <n>]` at the end of its item, n one above the last mark.
 * @param {string[]} lines the file's lines, edited in place
 * @param {string[]} words `<id> <the owner's conditions...>`
 * @param {{find: (lines: string[], id: string) => {at: number, cells: string[], header: string} | {error: string},
 *   write: (lines: string[], row: {at: number, cells: string[], header: string}) => void,
 *   add: (lines: string[], cells: string[]) => {error?: string}}} table the row helpers of status.mjs
 * @returns {{note?: string, usage?: string, error?: string}} the routing note, or why nothing changed
 */
export function markDefect(lines, [id, ...conditionWords], table) {
  const conditions = oneLine(conditionWords.join(' '));
  if (!id || !conditions) return { usage: 'defect needs <id> "<the owner\'s conditions: zoom, pixel ratio, OS, theme, data, what he saw>"' };
  const row = table.find(lines, id);
  if (row.error) return row;
  const count = Number(DEFECT_TAG.exec(row.cells[1])?.[1] ?? 0) + 1;
  row.cells[1] = `${row.cells[1].replace(DEFECT_TAG, '')} [defect ${count}]`;
  table.write(lines, row);
  const rootCauseId = `${ROOT_CAUSE_PREFIX}${id}`.slice(0, MAX_ID_LENGTH);
  if (count < 2) return { note: routeNote(id, count, rootCauseId) };
  if (table.find(lines, rootCauseId).error) {
    const added = table.add(lines, [rootCauseId, `root-cause first for ${id}: reproduce under ${conditions}; deep-debugger before any fix; regression test`, ROOT_CAUSE_SIZE, '', '', '']);
    if (added.error) return added;
  }
  return { note: routeNote(id, count, rootCauseId) };
}
