// STATUS.md helper: the mechanical edits of the work table and the two lists, so the lead stops hand-editing them with sed.
// Usage (in the folder that holds STATUS.md, or --file <path>; --now <instant> replaces the clock, for tests):
//   status.mjs add <id> <item> <size>      new row in `## Work items`, size S|M|L, started = now
//   status.mjs done <id> <evidence>        done = now (started too when it is empty); a done cell that is set is never changed
//   status.mjs rule "<text>"               bullet under `## Standing rules` (the owner's words, short)
//   status.mjs decision "<text>"           bullet under `## Owner decisions`, dated
// Exports: runStatus(argv, { cwd, now }) -> { code, message }; the CLI prints message (stdout for 0, stderr otherwise) and exits with code.
// Invariants: touches only the one line it adds or changes; rows are found by their cells (header `id | item | size | started | done | evidence`),
// with or without outer pipes, anywhere in the file; times are UTC to the minute, the format the estimate tool reads; exit 1 = refused, 2 = usage.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseInstant } from '../estimate/lib/items.mjs';

const COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
const SIZES = ['S', 'M', 'L'];
const USAGE = 'usage: status.mjs [--file STATUS.md] add <id> <item> <size S|M|L> | done <id> <evidence> | rule "<text>" | decision "<text>"';
const SECTION_FOR = { rule: 'Standing rules', decision: 'Owner decisions' };
const WORK_ITEMS = 'Work items';
const HEADING = /^#{1,6}\s/;
const SPLIT_CELLS = /(?<!\\)\|/;

/** The clock as the estimate tool wants it: UTC, minute precision. */
const stamp = (date) => date.toISOString().slice(0, 16) + 'Z';

// Outer pipes are cut only when the line opens with one: in a table without them the last pipe separates the last two cells.
const cellsOf = (line) => {
  const text = line.trim();
  const body = text.startsWith('|') ? text.replace(/^\|/, '').replace(/(?<!\\)\|$/, '') : text;
  const cells = body.split(SPLIT_CELLS).map((cell) => cell.trim());
  // A table without outer pipes may still end its last cell with one (`... | | |`): that empty cell is not a column.
  return cells.length === COLUMNS.length + 1 && cells.at(-1) === '' && !text.startsWith('|') ? cells.slice(0, -1) : cells;
};
const isRow = (line) => !/^\s*(#|-\s)/.test(line) && cellsOf(line).length === COLUMNS.length && line.includes('|');
const isHeader = (line) => isRow(line) && cellsOf(line).join('|').toLowerCase() === COLUMNS.join('|');
const isEmpty = (cell) => cell === '' || cell === '-';
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/** Index of `## <name>`, or -1. */
const headingIndex = (lines, name) => lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(line));

/** Index just after the last non-blank line of the section that opens at `start`. */
function sectionEnd(lines, start) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (HEADING.test(lines[i])) { end = i; break; }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return end;
}

/** Writes one row back in the style of the table's header: outer pipes and `-` for empty cells, or neither. */
function formatRow(header, cells) {
  const piped = header.trim().startsWith('|');
  const shown = cells.map((cell) => (cell === '' && piped ? '-' : cell.replace(/(?<!\\)\|/g, '\\|')));
  return piped ? `| ${shown.join(' | ')} |` : shown.join(' | ').replace(/ {2,}/g, ' ').trimEnd();
}

function addRow(lines, [id, item, size], now) {
  if (!id || !item || !SIZES.includes(size)) return { error: `add needs <id> <item> <size ${SIZES.join('|')}>` };
  if (lines.some((line) => isRow(line) && cellsOf(line)[0].toLowerCase() === id.toLowerCase())) return { error: `id ${id} already exists` };
  let header = lines.findIndex(isHeader);
  if (header === -1) {
    if (headingIndex(lines, WORK_ITEMS) !== -1) return { error: 'the `## Work items` section has no table header: id | item | size | started | done | evidence' };
    lines.push('', `## ${WORK_ITEMS}`, '', `| ${COLUMNS.join(' | ')} |`, `| ${COLUMNS.map(() => '--').join(' | ')} |`);
    header = lines.length - 2;
  }
  let last = header + 1; // the separator line
  for (let i = header + 2; i < lines.length; i += 1) if (isRow(lines[i])) last = i;
  lines.splice(last + 1, 0, formatRow(lines[header], [id, oneLine(item), size, stamp(now), '', '']));
  return {};
}

function finishRow(lines, [id, ...evidenceWords], now) {
  const evidence = oneLine(evidenceWords.join(' '));
  if (!id || !evidence) return { error: 'done needs <id> <evidence>' };
  const header = lines.findIndex(isHeader);
  const at = lines.findIndex((line, i) => i > header && isRow(line) && cellsOf(line)[0].toLowerCase() === id.toLowerCase());
  if (header === -1 || at === -1) return { error: `no row with id ${id}` };
  const cells = cellsOf(lines[at]);
  if (!isEmpty(cells[4])) return { error: `${id} is already done (${cells[4]}); a done cell is never changed, add a new row for the correction` };
  if (isEmpty(cells[3])) cells[3] = stamp(now);
  cells[4] = stamp(now);
  cells[5] = isEmpty(cells[5]) ? evidence : `${cells[5]}; ${evidence}`;
  lines[at] = formatRow(lines[header], cells.map((cell) => (isEmpty(cell) ? '' : cell)));
  return {};
}

function addBullet(lines, kind, text, now) {
  const body = oneLine(text);
  if (!body) return { error: `${kind} needs the text` };
  const bullet = kind === 'decision' ? `- ${stamp(now).slice(0, 10)} ${body}` : `- ${body}`;
  if (lines.includes(bullet)) return {};
  const start = headingIndex(lines, SECTION_FOR[kind]);
  if (start === -1) {
    const before = headingIndex(lines, WORK_ITEMS);
    lines.splice(before === -1 ? lines.length : before, 0, `## ${SECTION_FOR[kind]}`, bullet, '');
  } else {
    lines.splice(sectionEnd(lines, start), 0, bullet);
  }
  return {};
}

/**
 * Runs one status command on a STATUS.md file.
 * @param {string[]} argv - arguments after the script name.
 * @param {{cwd?: string, now?: Date}} [options] - the folder that holds STATUS.md and the clock.
 * @returns {{code: number, message: string}} 0 on success; 1 when the edit is refused; 2 for a usage error.
 */
export function runStatus(argv, { cwd = process.cwd(), now = new Date() } = {}) {
  const args = [...argv];
  const take = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args.splice(at, 2)[1]; };
  const file = resolve(cwd, take('--file') ?? 'STATUS.md');
  const nowFlag = take('--now');
  if (nowFlag !== undefined && parseInstant(nowFlag) === null) return { code: 2, message: `--now ${nowFlag} is not an ISO 8601 instant` };
  const clock = nowFlag === undefined ? now : new Date(parseInstant(nowFlag));
  const [command, ...rest] = args;
  const edits = { add: addRow, done: finishRow, rule: (lines, [text], at) => addBullet(lines, 'rule', text ?? '', at), decision: (lines, [text], at) => addBullet(lines, 'decision', text ?? '', at) };
  if (!Object.hasOwn(edits, command)) return { code: 2, message: USAGE };
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch (error) {
    return { code: 1, message: `cannot read ${file}: ${error.code ?? error.message}` };
  }
  const lines = original.split('\n');
  const { error } = edits[command](lines, rest, clock);
  if (error) return { code: error.startsWith('add needs') || error.startsWith('done needs') || error.endsWith('needs the text') ? 2 : 1, message: error };
  const next = lines.join('\n');
  if (next !== original) {
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, next);
    renameSync(temp, file);
  }
  return { code: 0, message: `${command}: ok (${file})` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, message } = runStatus(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}
