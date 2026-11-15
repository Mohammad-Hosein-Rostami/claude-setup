// Parses the `## Work items` table of a STATUS.md into work items plus per-row problems.
// Exports: parseWorkItems(markdown) -> { items, problems }; parseInstant(text) -> epoch ms | null; INSTANT_FORMAT; SIZE_POINTS (S=1, M=2, L=4).
// Each item has a kind: 'close' when the item cell starts `close:` (review, fixes from a review, recheck, gate, landing,
// hand-over report), 'rework' when it starts `rework:` (an owner correction), else 'build'; case-insensitive.
// Invariants: pure (no I/O); line numbers are 1-based in the given text (a leading BOM and CRLF do not change them); exactly
// one `## Work items` section and one contiguous table in it, else a problem (nothing is skipped silently); a time must be a
// real ISO 8601 instant (see INSTANT_FORMAT), a bare `10:45` or `2026-02-30T08:00Z` is a problem; `-` or an empty cell means
// "not set"; fenced code is ignored; ids are unique ignoring case.
export const SIZE_POINTS = { S: 1, M: 2, L: 4 };
export const INSTANT_FORMAT = 'YYYY-MM-DDTHH:MM[:SS[.fff]] with Z or an offset (+HH:MM or -HH:MM), e.g. 2026-11-14T10:45Z';

const HEADING = /^##\s+Work items\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const EXPECTED_COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
const SEPARATOR_CELL = /^:?-+:?$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const MAX_OFFSET_HOURS = 14;
const MAX_OFFSET_MINUTES = 59;
const EMPTY_CELL = '-';
const PLACEHOLDER_EVIDENCE = /^(x+|n\/?a|none|tbd|todo|\?+|\.+)$/i;
const PIPES_OF_A_ROW = EXPECTED_COLUMNS.length - 1;
const KIND_PREFIXES = [['close', /^\s*close:/i], ['rework', /^\s*rework:/i]];

/** The row's kind from its item cell prefix: 'close', 'rework' or 'build'. */
const kindOf = (item) => KIND_PREFIXES.find(([, prefix]) => prefix.test(item))?.[0] ?? 'build';

/** Splits a table line into trimmed cells; `\|` stays inside a cell. */
function cellsOf(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

const isEmptyCell = (text) => text === '' || text === EMPTY_CELL;

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

function parseRow(cells, line) {
  const [id, item, size, startedText, doneText, evidenceText] = cells;
  const fail = (reason) => ({ problem: { line, reason: `${id || 'row'}: ${reason}` } });
  if (id === '') return fail('the id cell is empty');
  if (!Object.hasOwn(SIZE_POINTS, size)) return fail(`size "${size}" is not S, M or L`);
  const started = parseTime(startedText, 'started');
  const done = parseTime(doneText, 'done');
  if (started.error) return fail(started.error);
  if (done.error) return fail(done.error);
  const evidence = isEmptyCell(evidenceText) ? '' : evidenceText;
  if (done.value !== null && evidence === '') return fail('done without evidence (commit sha, file path or `check: <cmd> PASS`)');
  if (done.value !== null && PLACEHOLDER_EVIDENCE.test(evidence)) return fail(`evidence "${evidence}" is a placeholder (commit sha, file path or \`check: <cmd> PASS\`)`);
  if (done.value !== null && started.value !== null && done.value <= started.value) return fail('done is not after started');
  return { item: { id, item, kind: kindOf(item), size, points: SIZE_POINTS[size], started: started.value, done: done.value, evidence, line } };
}

/** For each line: true when it is outside code fences. */
function unfencedLines(lines) {
  let inFence = false;
  return lines.map((text) => {
    if (FENCE.test(text)) inFence = !inFence;
    return !inFence && !FENCE.test(text);
  });
}

const unescapedPipes = (text) => text.split(/(?<!\\)\|/).length - 1;
const looksLikeRow = (text) => unescapedPipes(text) >= PIPES_OF_A_ROW;

/** The table lines of the section that starts after `from`: one contiguous block, plus problems for stray rows. */
function tableLines(lines, visible, from) {
  const rows = [];
  const problems = [];
  let breakLine = 0;
  for (let i = from; i < lines.length; i += 1) {
    const text = lines[i];
    if (visible[i] && ANY_HEADING.test(text)) break;
    const isRow = visible[i] && text.trim().startsWith('|');
    if (isRow && breakLine > 0) {
      problems.push({ line: i + 1, reason: `table row after a break at line ${breakLine}; keep one table` });
      break;
    }
    if (isRow) rows.push({ text, line: i + 1 });
    else if (rows.length > 0 && breakLine === 0) breakLine = i + 1;
    if (!isRow && rows.length > 0 && visible[i] && looksLikeRow(text)) {
      problems.push({ line: i + 1, reason: 'this looks like a table row but does not start with `|`; keep one table' });
    }
  }
  return { rows, problems };
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

function readRows(rows) {
  const items = [];
  const problems = [];
  const firstLineOfId = new Map();
  for (const { text, line } of rows) {
    const cells = cellsOf(text);
    if (cells.length !== EXPECTED_COLUMNS.length) {
      problems.push({ line, reason: `row has ${cells.length} cells, expected ${EXPECTED_COLUMNS.length} (write a pipe inside a cell as \\|)` });
      continue;
    }
    const parsed = parseRow(cells, line);
    const idKey = cells[0].toLowerCase();
    if (parsed.problem) problems.push(parsed.problem);
    else if (firstLineOfId.has(idKey)) problems.push({ line, reason: `${cells[0]}: id repeated (ignoring case), first on line ${firstLineOfId.get(idKey)}` });
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

/**
 * Parses the work items table.
 * @param {string} markdown STATUS.md text.
 * @returns {{items: object[], problems: {line: number, reason: string}[]}} items in file order; problems name the 1-based line,
 *   sorted by line. Any problem means the table was not fully understood.
 */
export function parseWorkItems(markdown) {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  const visible = unfencedLines(lines);
  const headings = lines.flatMap((text, i) => (visible[i] && HEADING.test(text) ? [i] : []));
  if (headings.length === 0) return { items: [], problems: [{ line: 0, reason: 'no "## Work items" table found' }] };
  if (headings.length > 1) return { items: [], problems: [sectionProblem(headings)] };

  const { rows, problems } = tableLines(lines, visible, headings[0] + 1);
  if (rows.length === 0) return { items: [], problems: [...problems, { line: headings[0] + 1, reason: 'no table header under "## Work items"' }] };
  const structure = headerProblem(rows[0]) ?? separatorProblem(rows[1]);
  if (structure) return { items: [], problems: [...problems, structure] };

  const read = readRows(rows.slice(2));
  return { items: read.items, problems: [...problems, ...read.problems].sort((a, b) => a.line - b.line) };
}
