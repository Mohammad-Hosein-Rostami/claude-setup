// Parses the `## Work items` table of a STATUS.md into work items plus per-row problems.
// Exports: parseWorkItems(markdown) -> { items, problems }; SIZE_POINTS (S=1, M=2, L=4).
// Invariants: pure (no I/O); line numbers are 1-based in the given text; a time must be ISO 8601 with `Z` or a
// `+HH:MM` offset (a bare `10:45` is a problem); `-` or an empty cell means "not set"; tables inside code fences are ignored.
export const SIZE_POINTS = { S: 1, M: 2, L: 4 };

const HEADING = /^##\s+Work items\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const EXPECTED_COLUMNS = ['id', 'item', 'size', 'started', 'done', 'evidence'];
const SEPARATOR_CELL = /^:?-+:?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EMPTY_CELL = '-';

/** Splits a table line into trimmed cells; `\|` stays inside a cell. */
function cellsOf(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

const isEmptyCell = (text) => text === '' || text === EMPTY_CELL;

/** Epoch ms of a valid timestamp cell, null for an empty cell, or `{ error }` for anything else. */
function parseTime(text, label) {
  if (isEmptyCell(text)) return null;
  const ms = TIMESTAMP.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(ms)) return { error: `${label} "${text}" is not ISO 8601 with Z or an offset (e.g. 2026-11-14T10:45Z)` };
  return ms;
}

function parseRow(cells, line) {
  const [id, item, size, startedText, doneText, evidenceText] = cells;
  const fail = (reason) => ({ problem: { line, reason: `${id || 'row'}: ${reason}` } });
  if (!Object.hasOwn(SIZE_POINTS, size)) return fail(`size "${size}" is not S, M or L`);
  const started = parseTime(startedText, 'started');
  const done = parseTime(doneText, 'done');
  if (started?.error) return fail(started.error);
  if (done?.error) return fail(done.error);
  const evidence = isEmptyCell(evidenceText) ? '' : evidenceText;
  if (done !== null && evidence === '') return fail('done without evidence (commit sha, file path or `check: <cmd> PASS`)');
  if (done !== null && started !== null && done < started) return fail('done is before started');
  return { item: { id, item, size, points: SIZE_POINTS[size], started, done, evidence, line } };
}

/** Line indexes (0-based) outside code fences. */
function unfencedLines(lines) {
  let inFence = false;
  return lines.map((text) => {
    if (FENCE.test(text)) inFence = !inFence;
    return !inFence && !FENCE.test(text);
  });
}

/**
 * Parses the work items table.
 * @param {string} markdown STATUS.md text.
 * @returns {{items: object[], problems: {line: number, reason: string}[]}} items in file order; problems name the 1-based line.
 */
export function parseWorkItems(markdown) {
  const lines = markdown.split(/\r?\n/);
  const visible = unfencedLines(lines);
  const headingAt = lines.findIndex((text, i) => visible[i] && HEADING.test(text));
  if (headingAt === -1) return { items: [], problems: [{ line: 0, reason: 'no "## Work items" table found' }] };

  const items = [];
  const problems = [];
  let headerSeen = false;
  for (let i = headingAt + 1; i < lines.length; i += 1) {
    const text = lines[i];
    if (visible[i] && ANY_HEADING.test(text)) break;
    if (!text.trim().startsWith('|')) {
      if (headerSeen && text.trim() !== '') break;
      continue;
    }
    const cells = cellsOf(text);
    if (!headerSeen) {
      headerSeen = true;
      if (cells.map((c) => c.toLowerCase()).join('|') !== EXPECTED_COLUMNS.join('|')) {
        problems.push({ line: i + 1, reason: `table header must be | ${EXPECTED_COLUMNS.join(' | ')} |` });
        break;
      }
      continue;
    }
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    if (cells.length !== EXPECTED_COLUMNS.length) {
      problems.push({ line: i + 1, reason: `row has ${cells.length} cells, expected ${EXPECTED_COLUMNS.length}` });
      continue;
    }
    const parsed = parseRow(cells, i + 1);
    if (parsed.problem) problems.push(parsed.problem);
    else items.push(parsed.item);
  }
  if (!headerSeen) problems.push({ line: headingAt + 1, reason: 'no table header under "## Work items"' });
  return { items, problems };
}
