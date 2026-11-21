// The one `## Work items` table of a STATUS.md: finding it (code fences skipped as the estimator skips them), making it when the
// section is missing, and reading and writing one row in the style of its header. status.mjs runs the commands on top of it.
// Exports: WORK_ITEMS, stamp, isEmpty, oneLine, sectionEnd, hiddenEndReason, tableToEdit, rowIndex, insertRow, rowToChange, writeRow, DEFECT_TABLE (the row helpers of `defect`).
// Invariants: rows are only the contiguous table rows below the header `id | item | size | started | done | evidence` and its
// separator; a done cell is never changed (rowToChange refuses it); a section is never made below a code fence left open.
import { findSection, isTableRow, rowCells } from '../estimate/lib/items.mjs';

const COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
export const WORK_ITEMS = 'Work items';

/** The clock as the estimate tool wants it: UTC, minute precision. */
export const stamp = (date) => date.toISOString().slice(0, 16) + 'Z';

const isHeader = (line) => isTableRow(line) && rowCells(line).join('|').toLowerCase() === COLUMNS.join('|');
export const isEmpty = (cell) => cell === '' || cell === '-';
export const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const sameId = (line, id) => rowCells(line)[0].toLowerCase() === id.toLowerCase();

/** Index just after the last non-blank line of a section (from findSection). */
export function sectionEnd(lines, { start, end }) {
  let last = end;
  while (last > start + 1 && lines[last - 1].trim() === '') last -= 1;
  return last;
}

/**
 * The one work table: the header's index (-1 when the section has none) and the indexes of its rows, the contiguous table rows
 * under the separator. null when there is no `## Work items` section. Code fences are skipped as the estimator skips them.
 */
function workTable(lines) {
  const { start, end, visible } = findSection(lines, WORK_ITEMS);
  if (start === -1) return null;
  const header = lines.findIndex((line, i) => i > start && i < end && visible[i] && isHeader(line));
  const rows = [];
  for (let i = header + 2; header !== -1 && i < end && visible[i] && isTableRow(lines[i]); i += 1) rows.push(i);
  return { header, rows };
}

/** Why a section made at the end of the file would be hidden (a code fence left open above it), or null. */
export function hiddenEndReason(lines) {
  const { openFence } = findSection(lines, WORK_ITEMS);
  if (openFence === -1) return null;
  return `unclosed code fence at line ${openFence + 1}: everything below it is hidden from the estimate tool, so a section made at the end would be too; close the fence first`;
}

/**
 * The work table, made at the end of the file when there is no section; `{ error }` when the section has no header or a new one
 * would be hidden in an unclosed code fence.
 */
export function tableToEdit(lines) {
  const table = workTable(lines);
  if (table === null) {
    const hidden = hiddenEndReason(lines);
    if (hidden !== null) return { error: hidden };
    while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop(); // one blank line before the new heading, not two
    if (lines.length > 0) lines.push('');
    lines.push(`## ${WORK_ITEMS}`, '', `| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map(() => '--').join(' | ')} |`, '');
    return { header: lines.length - 3, rows: [] };
  }
  if (table.header === -1) return { error: 'the `## Work items` section has no table header: id | item | size | started | done | evidence' };
  return table;
}

/** Index of the table row with this id (any case), or -1. */
export const rowIndex = (lines, table, id) => table.rows.find((i) => sameId(lines[i], id)) ?? -1;

/** Writes one row back in the style of the table's header: outer pipes and `-` for empty cells, or neither. */
function formatRow(header, cells) {
  const piped = header.trim().startsWith('|');
  const shown = cells.map((cell) => (cell === '' && piped ? '-' : cell.replace(/(?<!\\)\|/g, '\\|')));
  return piped ? `| ${shown.join(' | ')} |` : shown.join(' | ').replace(/ {2,}/g, ' ').trimEnd();
}

/** Puts a new row after the table's last row (after the separator in an empty table). */
export function insertRow(lines, table, cells) {
  lines.splice((table.rows.at(-1) ?? table.header + 1) + 1, 0, formatRow(lines[table.header], cells));
}

/** The row with this id in the work table that is not done yet ({ at, cells, header }), or `{ error }`. */
export function rowToChange(lines, id) {
  const table = workTable(lines);
  const at = table === null || table.header === -1 ? -1 : rowIndex(lines, table, id);
  if (at === -1) return { error: `no row with id ${id} in the \`## ${WORK_ITEMS}\` table` };
  const cells = rowCells(lines[at]);
  if (!isEmpty(cells[4])) return { error: `${id} is already done (${cells[4]}); a done cell is never changed, add a new row for the correction` };
  return { at, cells, header: lines[table.header] };
}

export function writeRow(lines, { at, cells, header }) {
  lines[at] = formatRow(header, cells.map((cell) => (isEmpty(cell) ? '' : cell)));
}

/** The row helpers defect.mjs uses: any row of the table (a done row too: a defect is reported after delivery). */
export const DEFECT_TABLE = {
  find: (lines, id) => {
    const table = workTable(lines);
    const at = table === null || table.header === -1 ? -1 : rowIndex(lines, table, id);
    return at === -1 ? { error: `no row with id ${id} in the \`## ${WORK_ITEMS}\` table` } : { at, cells: rowCells(lines[at]), header: lines[table.header] };
  },
  write: writeRow,
  add: (lines, cells) => {
    const table = tableToEdit(lines);
    if (table.error) return table;
    insertRow(lines, table, cells);
    return {};
  },
};

