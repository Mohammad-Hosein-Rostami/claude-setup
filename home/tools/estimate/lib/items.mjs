// Parses the `## Work items` table of a STATUS.md into work items plus per-row problems. The one row reader: status.mjs takes
// rowCells and isTableRow from here, so a table it can edit is a table the estimator can read.
// Exports: parseWorkItems(markdown, nowMs?) -> { items, problems } (a problem is {line, reason} plus `id` when it is about one row);
// rowCells(line) -> cells; isTableRow(line) -> boolean; parseInstant(text) -> epoch ms | null; INSTANT_FORMAT.
// Each item has a kind: 'close' when the item cell starts `close:` (review, fixes from a review, recheck, gate, landing),
// 'rework' when it starts `rework:` (an owner correction), 'deliver' when it starts `deliver:` (the job handed over to the
// owner: its done time is a hand-over), else 'build'; case-insensitive; an item cell without a prefix takes the id cell's
// (`close:5`, `deliver:1`). A deliver row is an event: done alone is enough (its started is then its done, evidence may be empty).
// Invariants: pure (no I/O); line numbers are 1-based in the given text (a leading BOM and CRLF do not change them); exactly
// one `## Work items` section and one contiguous table in it, rows with or without outer pipes, else a problem (nothing is
// skipped silently); a work-shaped row anywhere else in the file is a problem; a time must be a real ISO 8601 instant (see
// INSTANT_FORMAT), a bare `10:45` or `2026-02-30T08:00Z` is a problem; a done work row needs a started; given nowMs, no stamp
// may be later than it; `-` or an empty cell means "not set"; fenced code is ignored; ids are unique ignoring case.
export const INSTANT_FORMAT = 'YYYY-MM-DDTHH:MM[:SS[.fff]] with Z or an offset (+HH:MM or -HH:MM), e.g. 2026-11-14T10:45Z';

const HEADING = /^##\s+Work items\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const EXPECTED_COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
const SIZES = ['S', 'M', 'L'];
const SIZE_CELL = EXPECTED_COLUMNS.indexOf('size');
const SEPARATOR_CELL = /^:?-+:?$/;
const UNESCAPED_PIPE = /(?<!\\)\|/;
const NOT_A_ROW = /^\s*(#|-\s)/; // a heading or a bullet is never a table row
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const MAX_OFFSET_HOURS = 14;
const MAX_OFFSET_MINUTES = 59;
const EMPTY_CELL = '-';
const PLACEHOLDER_EVIDENCE = /^(x+|n\/?a|none|tbd|todo|\?+|\.+)$/i;
const KIND_PREFIXES = [['close', /^\s*close:/i], ['rework', /^\s*rework:/i], ['deliver', /^\s*deliver:/i]];

const prefixKind = (text) => KIND_PREFIXES.find(([, prefix]) => prefix.test(text))?.[0];
/** The row's kind from its item cell prefix, else its id cell prefix: 'close', 'rework', 'deliver' or 'build'. */
const kindOf = (item, id) => prefixKind(item) ?? prefixKind(id) ?? 'build';

/**
 * Splits a table line into trimmed cells, with or without outer pipes. A trailing pipe is cut only when the line opens with one:
 * in a table without outer pipes the last pipe separates the last two cells, unless it would leave a seventh, empty cell.
 * @param {string} line one line of a table
 * @returns {string[]} the cells, trimmed; `\|` is left escaped (parseWorkItems unescapes it)
 */
export function rowCells(line) {
  const text = line.trim();
  const piped = text.startsWith('|');
  const body = piped ? text.replace(/^\|/, '').replace(/(?<!\\)\|$/, '') : text;
  const cells = body.split(UNESCAPED_PIPE).map((cell) => cell.trim());
  return cells.length === EXPECTED_COLUMNS.length + 1 && cells.at(-1) === '' && !piped ? cells.slice(0, -1) : cells;
}

/** @returns {boolean} true for a line with a pipe and six cells that is not a heading or a bullet: a row of a work items table */
export const isTableRow = (line) => !NOT_A_ROW.test(line) && line.includes('|') && rowCells(line).length === EXPECTED_COLUMNS.length;

const cellsOf = (line) => rowCells(line).map((cell) => cell.replace(/\\\|/g, '|'));
const isEmptyCell = (text) => text === '' || text === EMPTY_CELL;
const isoText = (ms) => new Date(ms).toISOString().replace(/(:00)?\.000Z$/, 'Z');

/**
 * Epoch ms of a real ISO 8601 instant, or null for anything else. The pattern is strict and the calendar fields must
 * survive a round trip through Date, so `2026-02-30`, `T24:00`, month 13 and bare dates are refused instead of shifted.
 */
export function parseInstant(text) {
  const match = INSTANT.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = Number(match[6] ?? 0);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const survives = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
    && calendar.getUTCHours() === hour && calendar.getUTCMinutes() === minute && calendar.getUTCSeconds() === second;
  const offsetOk = Number(match[7] ?? 0) <= MAX_OFFSET_HOURS && Number(match[8] ?? 0) <= MAX_OFFSET_MINUTES;
  const ms = Date.parse(text);
  return survives && offsetOk && Number.isFinite(ms) ? ms : null;
}

/** `{ value }` (epoch ms, or null for an empty cell) or `{ error }` for a cell that is not a real instant. */
function parseTime(text, label) {
  if (isEmptyCell(text)) return { value: null };
  const ms = parseInstant(text);
  if (ms === null) return { error: `${label} "${text}" is not a real ISO 8601 instant; accepted: ${INSTANT_FORMAT}` };
  return { value: ms };
}

/** The first of the row's stamps later than now, as a reason; null when none is or no now was given. */
function laterThanNow(stamps, nowMs) {
  if (nowMs === undefined) return null;
  const late = stamps.find(([, ms]) => ms !== null && ms > nowMs);
  if (late === undefined) return null;
  return `${late[0]} ${isoText(late[1])} is later than now (${isoText(nowMs)}); set times from the clock (\`date -u +%Y-%m-%dT%H:%MZ\`), never from memory`;
}

function parseRow(cells, line, nowMs) {
  const [id, item, size, startedText, doneText, evidenceText] = cells;
  const fail = (reason) => ({ problem: { line, id: id || undefined, reason: `${id || 'row'}: ${reason}` } });
  if (id === '') return fail('the id cell is empty');
  if (!SIZES.includes(size)) return fail(`size "${size}" is not S, M or L`);
  const started = parseTime(startedText, 'started');
  const done = parseTime(doneText, 'done');
  if (started.error) return fail(started.error);
  if (done.error) return fail(done.error);
  const evidence = isEmptyCell(evidenceText) ? '' : evidenceText;
  const kind = kindOf(item, id);
  const event = kind === 'deliver'; // done alone marks the hand-over: started is then the done time
  const startedAt = event && started.value === null ? done.value : started.value;
  if (done.value !== null && evidence === '' && !event) return fail('done without evidence (commit sha, file path or `check: <cmd> PASS`)');
  if (done.value !== null && PLACEHOLDER_EVIDENCE.test(evidence)) return fail(`evidence "${evidence}" is a placeholder (commit sha, file path or \`check: <cmd> PASS\`)`);
  if (done.value !== null && startedAt === null) return fail('done without started; a row is started when its work begins (`status.mjs start <id>`)');
  // equal is valid: times have minute precision, so a row of under a minute has done == started
  if (done.value !== null && done.value < startedAt) return fail('done is not after started');
  const late = laterThanNow([['started', started.value], ['done', done.value]], nowMs);
  if (late !== null) return fail(late);
  return { item: { id, item, kind, size, started: startedAt, done: done.value, evidence, line } };
}

/** For each line: true when it is outside code fences. */
function unfencedLines(lines) {
  let inFence = false;
  return lines.map((text) => {
    if (FENCE.test(text)) inFence = !inFence;
    return !inFence && !FENCE.test(text);
  });
}

/** A line of the table block: a line with an unescaped pipe that is not a heading or a bullet (cell counts are checked later). */
const isTableLine = (text) => !NOT_A_ROW.test(text) && UNESCAPED_PIPE.test(text);

/** The table lines of the section that starts after `from`: one contiguous block, a problem for a row after a break, and `end`, the next heading. */
function tableLines(lines, visible, from) {
  const rows = [];
  const problems = [];
  let breakLine = 0;
  let end = lines.length;
  for (let i = from; i < lines.length; i += 1) {
    const text = lines[i];
    if (visible[i] && ANY_HEADING.test(text)) {
      end = i;
      break;
    }
    const isRow = visible[i] && isTableLine(text);
    if (isRow && breakLine > 0 && problems.length === 0) problems.push({ line: i + 1, reason: `table row after a break at line ${breakLine}; keep one table` });
    else if (isRow && breakLine === 0) rows.push({ text, line: i + 1 });
    else if (!isRow && rows.length > 0 && breakLine === 0) breakLine = i + 1;
  }
  return { rows, problems, end };
}

/** A table row whose size cell is S, M or L: a work row (a table of another shape elsewhere in the file is not one). */
const isWorkShaped = (text) => isTableRow(text) && SIZES.includes(rowCells(text)[SIZE_CELL]);

/** Work-shaped rows outside the section [from, to): each is a problem naming its line. */
function strayRows(lines, visible, from, to) {
  return lines.flatMap((text, i) => (visible[i] && (i < from || i >= to) && isWorkShaped(text)
    ? [{ line: i + 1, reason: 'a work row outside the `## Work items` table; move it into the table' }]
    : []));
}

function headerProblem(row) {
  const cells = cellsOf(row.text).map((cell) => cell.toLowerCase());
  if (cells.join('|') === EXPECTED_COLUMNS.join('|')) return null;
  return { line: row.line, reason: `table header must be | ${EXPECTED_COLUMNS.join(' | ')} | (found ${cells.length} columns)` };
}

function separatorProblem(row) {
  const cells = row === undefined ? [] : cellsOf(row.text);
  if (cells.length === EXPECTED_COLUMNS.length && cells.every((cell) => SEPARATOR_CELL.test(cell))) return null;
  return { line: row?.line ?? 0, reason: 'the line under the header must be the separator, e.g. | -- | ---- | ---- | ------- | ---- | -------- |' };
}

function readRows(rows, nowMs) {
  const items = [];
  const problems = [];
  const firstLineOfId = new Map();
  for (const { text, line } of rows) {
    const cells = cellsOf(text);
    if (cells.length !== EXPECTED_COLUMNS.length) {
      problems.push({ line, reason: `row has ${cells.length} cells, expected ${EXPECTED_COLUMNS.length} (write a pipe inside a cell as \\|)` });
      continue;
    }
    const parsed = parseRow(cells, line, nowMs);
    const idKey = cells[0].toLowerCase();
    if (parsed.problem) problems.push(parsed.problem);
    else if (firstLineOfId.has(idKey)) problems.push({ line, id: cells[0], reason: `${cells[0]}: id repeated (ignoring case), first on line ${firstLineOfId.get(idKey)}` });
    else items.push(parsed.item);
    if (!firstLineOfId.has(idKey)) firstLineOfId.set(idKey, line);
  }
  return { items, problems };
}

function sectionProblem(headings) {
  const lineNumbers = headings.map((at) => at + 1);
  const listed = lineNumbers.length === 2 ? `${lineNumbers[0]} and ${lineNumbers[1]}` : `${lineNumbers.slice(0, -1).join(', ')} and ${lineNumbers.at(-1)}`;
  const count = lineNumbers.length === 2 ? 'two' : String(lineNumbers.length);
  return { line: lineNumbers[1], reason: `${count} Work items sections, lines ${listed}; keep one` };
}

const byLine = (problems) => [...problems].sort((a, b) => a.line - b.line);

/**
 * Parses the work items table.
 * @param {string} markdown STATUS.md text.
 * @param {number} [nowMs] epoch ms of now: a started or done later than it is a problem; omitted, stamps are not compared with now.
 * @returns {{items: object[], problems: {line: number, reason: string}[]}} items in file order ({ id, item, kind, size, started,
 *   done, evidence, line }, stamps in epoch ms or null); problems name the 1-based line, sorted by line. Any problem means the
 *   table was not fully understood.
 */
export function parseWorkItems(markdown, nowMs) {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  const visible = unfencedLines(lines);
  const headings = lines.flatMap((text, i) => (visible[i] && HEADING.test(text) ? [i] : []));
  if (headings.length === 0) return { items: [], problems: [{ line: 0, reason: 'no "## Work items" table found' }] };
  if (headings.length > 1) return { items: [], problems: [sectionProblem(headings)] };

  const { rows, problems: breaks, end } = tableLines(lines, visible, headings[0] + 1);
  const problems = [...breaks, ...strayRows(lines, visible, headings[0], end)];
  if (rows.length === 0) return { items: [], problems: byLine([...problems, { line: headings[0] + 1, reason: 'no table header under "## Work items"' }]) };
  const structure = headerProblem(rows[0]) ?? separatorProblem(rows[1]);
  if (structure) return { items: [], problems: byLine([...problems, structure]) };

  const read = readRows(rows.slice(2), nowMs);
  return { items: read.items, problems: byLine([...problems, ...read.problems]) };
}
