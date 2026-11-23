// The one `## Work items` table of a STATUS.md: finding it (code fences skipped as the estimator skips them), making it when the
// section is missing, and reading and writing one row in the style of its header. status.mjs runs the commands on top of it.
// Exports: WORK_ITEMS, stamp, isEmpty, oneLine, sectionEnd, hiddenEndReason, tableToEdit, rowIndex, insertRow, rowToChange, writeRow, DEFECT_TABLE (the row helpers of `defect`),
// HOLD_KINDS, holdText, startsWithHold, withHold, withoutHold, rowsToHold (the `park` and `wait` holds).
// Invariants: rows are only the contiguous table rows below the header `id | item | size | started | done | evidence` and its
// separator; a done cell is never changed (rowToChange refuses it); a section is never made below a code fence left open.
// A hold (estimate-spec R3, R4) is `parked: <why>` or `waiting: <question>` at the head of an open row's evidence cell, any older
// `waiting:` question and other evidence kept after `; `: no new column, so a reader that knows no holds still reads the row as
// an open row with evidence.
import { findSection, isTableRow, rowCells } from '../estimate/lib/items.mjs';
import { roadStepOf } from '../estimate/lib/road-steps.mjs';

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

/** The two holds, as the evidence prefix names them: `park` writes `parked:`, `wait` writes `waiting:`. */
export const HOLD_KINDS = ['parked', 'waiting'];
// The hold at the head of an evidence cell: its kind, its text up to the evidence separator `;`, then the separator.
const HOLD_AT_HEAD = new RegExp(`^(${HOLD_KINDS.join('|')}):[^;]*(?:;\\s*|$)`, 'i');
const CONTROL_CHARS = /\p{Cc}/gu; // a bell or escape in a cell would reach every terminal that prints the row
const EVIDENCE_SEPARATOR = /;/g; // `;` ends the hold text, so one inside it would cut the hold short

/** The hold's text: one line, no control character, `;` written `,` (see EVIDENCE_SEPARATOR); '' when nothing is left. */
export const holdText = (text) => oneLine(text.replace(CONTROL_CHARS, ' ')).replace(EVIDENCE_SEPARATOR, ',');

/** @returns {boolean} true when the text starts with a hold mark (`parked:` or `waiting:`, any case) */
export const startsWithHold = (text) => HOLD_AT_HEAD.test(text);

/** The holds at the head of an evidence cell, in order ({ kind, text }), and the evidence after them. */
function splitHolds(evidence) {
  const holds = [];
  let rest = evidence;
  for (let match = HOLD_AT_HEAD.exec(rest); match !== null; match = HOLD_AT_HEAD.exec(rest)) {
    holds.push({ kind: match[1].toLowerCase(), text: match[0].replace(/;\s*$/, '').trimEnd() });
    rest = rest.slice(match[0].length);
  }
  return { holds, rest };
}

/**
 * @param {string} evidence an evidence cell as rowCells gives it
 * @returns {{ evidence: string, held: string | null }} the cell without any hold at its head, and the kinds that were there
 *   (`parked`, `waiting`, or `parked and waiting`), or null when it had none
 */
export function withoutHold(evidence) {
  const { holds, rest } = splitHolds(evidence);
  const kinds = [...new Set(holds.map((hold) => hold.kind))];
  return { evidence: holds.length === 0 ? evidence : rest, held: kinds.length === 0 ? null : kinds.join(' and ') };
}

/**
 * The evidence cell with `hold` at its head. An older `parked:` reason is replaced; every older `waiting:` question stays after
 * the new hold (the owner's open question is never dropped), then the other evidence, all joined with `; `.
 */
export function withHold(evidence, hold) {
  const { holds, rest } = splitHolds(evidence);
  const questions = holds.filter((old) => old.kind === 'waiting' && old.text !== hold).map((old) => old.text);
  return [hold, ...questions, ...(isEmpty(rest) ? [] : [rest])].join('; ');
}

const isHandOver = (cells) => /^deliver:/i.test(cells[0]) || /^\s*deliver:/i.test(cells[1]);

/**
 * The open rows a `park` or `wait` changes: the row whose id is `target`, or, with `byRoad`, every open row of the road `target`
 * (ids `<road>.s<N>.<rest>`, the estimator's roadStepOf).
 * @param {string[]} lines the file's lines
 * @param {string} target a row id, or a road id when `byRoad`
 * @param {{ byRoad: boolean }} options whether a road may be named
 * @returns {{ rows: { at: number, cells: string[], header: string }[] } | { usage: string }} usage (exit 2, nothing changed) for
 *   no table, an unknown target, a hand-over row, a done row, a road with every row done, or a name that is a row id and a road
 */
export function rowsToHold(lines, target, { byRoad }) {
  const table = workTable(lines);
  if (table === null || table.header === -1) return { usage: `no row ${target}: there is no \`## ${WORK_ITEMS}\` table with its header` };
  const at = rowIndex(lines, table, target);
  const road = target.toLowerCase();
  const roadRows = byRoad ? table.rows.filter((i) => roadStepOf(rowCells(lines[i])[0])?.road === road) : [];
  if (at !== -1 && roadRows.length > 0) return { usage: `${target} is a row id and also a road (${roadRows.length} rows): it would be read two ways, so nothing is parked` };
  const found = at === -1 ? roadRows : [at];
  if (found.length === 0) return { usage: `no row${byRoad ? ' or road' : ''} ${target} in the \`## ${WORK_ITEMS}\` table` };
  if (found.some((i) => isHandOver(rowCells(lines[i])))) return { usage: `${target} is a hand-over row: it cannot be parked or wait` };
  const open = found.filter((i) => isEmpty(rowCells(lines[i])[4]));
  if (open.length === 0) return { usage: at === -1 ? `every row of road ${target} is done: nothing to hold` : `${target} is already done (${rowCells(lines[at])[4]}): a done row is never held` };
  return { rows: open.map((i) => ({ at: i, cells: rowCells(lines[i]), header: lines[table.header] })) };
}

