// STATUS.md helper: the mechanical edits of the work table and the two lists, so the lead stops hand-editing them with sed.
// Usage (in the folder that holds STATUS.md, or --file <path> before the command; the clock is always the system's, tests pass `now`):
//   status.mjs add <id> <item> <size>      new row in `## Work items`, size S|M|L, started = now
//   status.mjs done <id> <evidence>        done = now (started too when it is empty); a done cell that is set is never changed
//   status.mjs rule "<text>"               bullet under `## Standing rules` (the owner's words, short)
//   status.mjs decision "<text>"           bullet under `## Owner decisions`, dated
// Exports: runStatus(argv, { cwd, now }) -> { code, message }; the CLI prints message (stdout for 0, stderr otherwise) and exits with code.
// Invariants: touches only the one line it adds or changes; rows are found by their cells (header `id | item | size | started | done | evidence`),
// with or without outer pipes, anywhere in the file; times are UTC to the minute, the format the estimate tool reads; exit 1 = refused, 2 = usage.
// Safety: edits run one at a time (the lead runs Bash calls in parallel): an O_EXCL lock file `<name>.lock` next to the file
// (hooks/lib/session-store.mjs withSessionLock: a lock older than 0.5 s was left by a killed run and is removed; after 1 s of waiting the
// edit is refused). The new text goes to a new temp file (random name, O_EXCL, never through a link) renamed over the file. A STATUS.md
// that is a link, FIFO or anything but a regular file is refused. An id is one plain word (ID), so no heading or bullet rides in on it.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSessionLock } from '../../hooks/lib/session-store.mjs';

const COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
const SIZES = ['S', 'M', 'L'];
const USAGE = 'usage: status.mjs [--file STATUS.md] add <id> <item> <size S|M|L> | done <id> <evidence> | rule "<text>" | decision "<text>"';
const SECTION_FOR = { rule: 'Standing rules', decision: 'Owner decisions' };
const WORK_ITEMS = 'Work items';
const HEADING = /^#{1,6}\s/;
const SPLIT_CELLS = /(?<!\\)\|/;
const ID = /^[\w.:-]{1,40}$/; // `7`, `17a`, `close:5`, `rework:12`, `deliver:`
const TEMP_NAME_BYTES = 8;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const LOCK_NAME_PARTS = /[^A-Za-z0-9_-]/g; // the lock is `<file name without .md>.lock`, in the characters the lock helper takes

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
  if (!ID.test(id ?? '') || !item || !SIZES.includes(size)) return { error: `add needs <id> <item> <size ${SIZES.join('|')}> (id: letters, digits, _ . : -)` };
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

/** Writes text to a new temp file next to `file` (never an existing file or link) and renames it over `file`. */
function replaceFile(file, text) {
  const temp = `${file}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.tmp`;
  const fd = openSync(temp, NEW_FILE, lstatSync(file).mode & 0o777);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true }); // after the rename nothing is left at that name
  }
}

/** Reads, edits and writes the file; runs under the file's lock. */
function editFile(file, edit) {
  let original;
  try {
    if (!lstatSync(file).isFile()) return { code: 1, message: `${file} is not a regular file (a link or special file): refused` };
    original = readFileSync(file, 'utf8');
  } catch (error) {
    return { code: 1, message: `cannot read ${file}: ${error.code ?? error.message}` };
  }
  const lines = original.split('\n');
  const { error } = edit(lines);
  if (error) return { code: error.startsWith('add needs') || error.startsWith('done needs') || error.endsWith('needs the text') ? 2 : 1, message: error };
  const next = lines.join('\n');
  if (next !== original) replaceFile(file, next);
  return { code: 0 };
}

/**
 * Runs one status command on a STATUS.md file.
 * @param {string[]} argv - arguments after the script name: `--file <path>` may come before the command, nothing else is a flag.
 * @param {{cwd?: string, now?: Date}} [options] - the folder that holds STATUS.md and the clock (tests pass a fixed one).
 * @returns {{code: number, message: string}} 0 on success; 1 when the edit is refused (also when another edit holds the lock for over
 *   a second); 2 for a usage error.
 */
export function runStatus(argv, { cwd = process.cwd(), now = new Date() } = {}) {
  const args = [...argv];
  const fileFlag = args[0] === '--file' ? args.splice(0, 2)[1] : undefined;
  const [command, ...rest] = args;
  const edits = { add: addRow, done: finishRow, rule: (lines, [text], at) => addBullet(lines, 'rule', text ?? '', at), decision: (lines, [text], at) => addBullet(lines, 'decision', text ?? '', at) };
  if (!Object.hasOwn(edits, command)) return { code: 2, message: USAGE };
  const given = resolve(cwd, fileFlag ?? 'STATUS.md');
  let folder;
  try {
    folder = realpathSync(dirname(given));
  } catch (error) {
    return { code: 1, message: `cannot read ${given}: ${error.code ?? error.message}` };
  }
  const file = join(folder, basename(given));
  const lockName = basename(file).replace(/\.md$/i, '').replace(LOCK_NAME_PARTS, '_').slice(0, 100) || 'STATUS';
  const result = withSessionLock(folder, lockName, () => editFile(file, (lines) => edits[command](lines, rest, now)));
  if (result === undefined) return { code: 1, message: `${file} is busy (another status edit holds ${lockName}.lock) or its folder is not usable: run it again` };
  return result.code === 0 ? { code: 0, message: `${command}: ok (${file})` } : result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { code, message } = runStatus(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}
