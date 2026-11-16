// Tests for the estimate table reader (home/tools/estimate/lib/items.mjs): rows in either pipe style, kinds, instants, and every
// problem the reader names with its line. Also holds the parser cases of the old tool's state, deliver and same-minute tests.
// Expected values come from the estimator design (section 6) and hand arithmetic, not from the implementation's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTableRow, parseWorkItems, rowCells } from '../home/tools/estimate/lib/items.mjs';
import { BASE_MS, FIRST_ROW_LINE, HOUR_MS, iso, plainDoc, row, statusDoc } from './estimate-tables.mjs';

const MINUTE_H = 1 / 60;
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const HEADER_ROWS = ['| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
const parseLines = (lines, nowMs) => parseWorkItems(`${lines.join('\n')}\n`, nowMs);
const reasons = (parsed) => parsed.problems.map((p) => `${p.line}: ${p.reason}`);

test('parseWorkItems reads rows with sizes, epoch times, empty cells and 1-based line numbers; no points', () => {
  const { items, problems } = parseWorkItems(statusDoc([row({ id: 'M1', size: 'L', startedH: 1, doneH: 3 }), row({ id: 'M2', size: 'M', startedH: 2 }), row({ id: 'M3', evidence: '' })]));
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => [i.id, i.size, i.line]), [['M1', 'L', FIRST_ROW_LINE], ['M2', 'M', FIRST_ROW_LINE + 1], ['M3', 'S', FIRST_ROW_LINE + 2]]);
  assert.equal(items[0].started, BASE_MS + HOUR_MS);
  assert.equal(items[0].done, BASE_MS + 3 * HOUR_MS);
  assert.equal(items[1].done, null);
  assert.equal(items[2].started, null);
  assert.equal(items[0].evidence, 'abc1234');
  assert.equal('points' in items[0], false);
});

test('a table without outer pipes, as status.mjs writes it, parses with 0 problems and the same items', () => {
  const rows = [row({ id: '1', startedH: 0, doneH: 1 }), row({ id: 'deliver:1', item: 'report to owner', raw: { started: '' }, doneH: 1, evidence: '' }), row({ id: 'close:2', item: 'fix review', startedH: 1 })];
  const plain = parseWorkItems(plainDoc(rows));
  assert.deepEqual(plain.problems, []);
  assert.deepEqual(plain.items.map((i) => [i.id, i.kind, i.size, i.started, i.done, i.evidence]), parseWorkItems(statusDoc(rows)).items.map((i) => [i.id, i.kind, i.size, i.started, i.done, i.evidence]));
  assert.deepEqual(plain.items.map((i) => i.kind), ['build', 'deliver', 'close']);
});

test('rowCells and isTableRow: outer pipes optional, a trailing pipe of a plain row ends the evidence cell, headings and bullets are no rows', () => {
  assert.deepEqual(rowCells('| a | b | S | - | - | x |'), ['a', 'b', 'S', '-', '-', 'x']);
  assert.deepEqual(rowCells('a | b | S |  | t |'), ['a', 'b', 'S', '', 't', '']);
  assert.deepEqual(rowCells('a | b | S | | t | x |'), ['a', 'b', 'S', '', 't', 'x']);
  assert.deepEqual(rowCells('| a \\| b | c |'), ['a \\| b', 'c']);
  assert.equal(isTableRow('a | b | S | - | - | x'), true);
  assert.equal(isTableRow('- a | b | S | - | - | x'), false);
  assert.equal(isTableRow('## a | b | S | - | - | x'), false);
  assert.equal(isTableRow('| a | b | c |'), false);
  assert.equal(isTableRow('a b S - - x'), false);
});

test('kind: an item cell starting close:, rework: or deliver: (any case) sets it; else the id cell\'s prefix; "closed" is build', () => {
  const items = itemsOf([row({ id: 'A', item: 'CLOSE: review' }), row({ id: 'B', item: 'Rework: owner fix' }), row({ id: 'C', item: 'closed the gap' }), row({ id: 'D', item: 'review the diff' }),
    row({ id: 'close:5', item: 'fix review findings' }), row({ id: 'X1', item: 'DELIVER: hand over', raw: { done: iso(2) }, evidence: '-' }), row({ id: 'rework:7', item: 'questions' })]);
  assert.deepEqual(items.map((i) => i.kind), ['close', 'rework', 'build', 'build', 'close', 'deliver', 'rework']);
});

test('a deliver row with only done (no started, no evidence) is accepted: its started is its done', () => {
  const { items, problems } = parseWorkItems(statusDoc([row({ id: 'deliver:1', item: 'report', raw: { done: iso(13.5) }, evidence: '-' })]));
  assert.deepEqual(problems, []);
  assert.equal(items[0].started, BASE_MS + 13.5 * HOUR_MS);
});

test('done equal to started is accepted; done before started is refused', () => {
  const equal = parseWorkItems(statusDoc([row({ id: 'A17', startedH: 1, doneH: 1 })]));
  assert.deepEqual(equal.problems, []);
  assert.equal(equal.items[0].started, equal.items[0].done);
  const before = parseWorkItems(statusDoc([row({ id: 'A18', startedH: 1, doneH: 1 - MINUTE_H })]));
  assert.match(before.problems[0].reason, /^A18: done is not after started/);
});

test('a done work row without started is a problem naming the row; a deliver row is not', () => {
  const parsed = parseWorkItems(statusDoc([row({ id: 'M1', doneH: 3 }), row({ id: 'deliver:1', item: 'x', doneH: 3, evidence: '-' })]));
  assert.deepEqual(reasons(parsed), [`${FIRST_ROW_LINE}: M1: done without started; a row is started when its work begins (\`status.mjs start <id>\`)`]);
});

test('with now, a started or done later than it is a problem naming the row, the cell and the time; the current minute is not later', () => {
  const now = BASE_MS + 20 * HOUR_MS + 30_000; // 30 s into the minute
  const current = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'S1', startedH: 20 }), row({ id: 'S2', startedH: 19.5, doneH: 20 })], now);
  assert.deepEqual(current.problems, []);
  const late = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'F1', startedH: 500 })], now);
  assert.deepEqual(reasons(late), ['4: F1: started 2026-11-30T20:00Z is later than now (2026-11-10T20:00:30Z); set times from the clock (`date -u +%Y-%m-%dT%H:%MZ`), never from memory']);
  const deliver = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'X1', item: 'deliver: x', raw: { done: iso(21) }, evidence: '-' })], now);
  assert.match(reasons(deliver)[0], /^4: X1: done 2026-11-10T21:00Z is later than now/);
  assert.deepEqual(parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'F1', startedH: 500 })]).problems, [], 'no now: not compared');
});

test('a work row outside the Work items table is a problem that names its line; a table of another shape is not', () => {
  const doc = statusDoc([row({ id: 'A', startedH: 0 })], '\n## Owner decisions\n- a decision\n29 | stray row | M | - | - | -\n| B | another | S | - | - | - |\n');
  assert.deepEqual(reasons(parseWorkItems(doc)), [
    '11: a work row outside the `## Work items` table; move it into the table',
    '12: a work row outside the `## Work items` table; move it into the table',
  ]);
  const before = parseWorkItems(`${row({ id: 'Z' })}\n${statusDoc([row({ id: 'A' })])}`);
  assert.deepEqual(before.problems.map((p) => p.line), [1]);
});

test('parseWorkItems accepts a numeric offset and rejects a date without time', () => {
  const ok = parseWorkItems(statusDoc([row({ id: 'A', raw: { started: '2026-11-10T10:45+03:30' } })]));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.items[0].started, Date.UTC(2026, 10, 10, 7, 15));
  const bad = parseWorkItems(statusDoc([row({ id: 'B', raw: { started: '2026-11-10' } })]));
  assert.equal(bad.problems.length, 1);
});

test('parseWorkItems reports done without evidence, size XL, a time without offset and done before started, each with its line', () => {
  const rows = [
    row({ id: 'A', startedH: 0, doneH: 1, evidence: '' }),
    row({ id: 'B', size: 'XL', startedH: 0, doneH: 1 }),
    row({ id: 'C', startedH: 0, doneH: 1, raw: { started: '10:45' } }),
    row({ id: 'D', startedH: 5, doneH: 4 }),
  ];
  const { problems } = parseWorkItems(statusDoc(rows));
  assert.deepEqual(problems.map((p) => p.line), [7, 8, 9, 10]);
  assert.match(problems[0].reason, /done without evidence/);
  assert.match(problems[1].reason, /size "XL"/);
  assert.match(problems[2].reason, /started "10:45".*offset/);
  assert.match(problems[3].reason, /done is not after started/);
});

test('parseWorkItems reports a missing table, a wrong header and a short row', () => {
  assert.match(parseWorkItems('# Status\nno table here\n').problems[0].reason, /no "## Work items" table/);
  const wrongHeader = '## Work items\n\n| id | what |\n| -- | ---- |\n| A | x |\n';
  assert.match(parseWorkItems(wrongHeader).problems[0].reason, /header/);
  const shortRow = statusDoc(['| A | only two cells |']);
  assert.deepEqual(parseWorkItems(shortRow).problems.map((p) => p.line), [FIRST_ROW_LINE]);
  assert.match(parseWorkItems('## Work items\n\nno table yet\n').problems[0].reason, /no table header under "## Work items"/);
});

test('parseWorkItems stops at the next heading and ignores tables inside code fences', () => {
  const fenced = '```\n## Work items\n| id | item | size | started | done | evidence |\n```\n';
  assert.equal(parseWorkItems(fenced).problems.length, 1);
  const doc = statusDoc([row({ id: 'A' })], '\n## Notes\n\n| id | item | size | started | done | evidence |\n| x | y | Q | - | - | - |\n');
  const { items, problems } = parseWorkItems(doc);
  assert.deepEqual([items.length, problems.length], [1, 0]);
  const fencedRow = statusDoc([row({ id: 'A' })], '\n## Notes\n```\n| B | fenced | S | - | - | - |\n```\n');
  assert.deepEqual(parseWorkItems(fencedRow).problems, []);
});

test('B1: a second ## Work items section is refused naming both heading lines', () => {
  const doc = ['## Work items', '', ...HEADER_ROWS, row({ id: 'A' }), '', '## Work items', '', ...HEADER_ROWS, row({ id: 'B' })];
  const parsed = parseLines(doc);
  assert.deepEqual(parsed.items, []);
  assert.match(parsed.problems[0].reason, /two Work items sections, lines 1 and 7/);
});

test('B1: a table row after a text line or a blank line is refused naming the break, never dropped; prose after the table is fine', () => {
  const afterText = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), 'Some note', row({ id: 'A6' })]);
  assert.deepEqual(reasons(afterText), ['6: table row after a break at line 5; keep one table']);
  const afterBlank = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), '', 'A6 | open | S | - | - | -']);
  assert.deepEqual(reasons(afterBlank), ['6: table row after a break at line 5; keep one table']);
  const mixed = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), 'A6 | open | S | - | - | -']);
  assert.deepEqual([mixed.problems, mixed.items.map((i) => i.id)], [[], ['A', 'A6']]);
  const fine = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), '', 'Prose after the table is fine.', '## Next']);
  assert.deepEqual(fine.problems, []);
});

test('B1: the header must be the six names in order (case and spaces ignored); an extra column or a missing separator is refused', () => {
  const ok = parseLines(['## Work items', '|  ID | Item | SIZE | Started | Done | Evidence |', HEADER_ROWS[1], row({ id: 'A' })]);
  assert.deepEqual(ok.problems, []);
  const extra = parseLines(['## Work items', '| id | item | size | started | done | evidence | notes |', '| - | - | - | - | - | - | - |']);
  assert.match(reasons(extra)[0], /table header must be \| id \| item \| size \| started \| done \| evidence \|/);
  const swapped = parseLines(['## Work items', '| id | item | size | done | started | evidence |', HEADER_ROWS[1]]);
  assert.match(reasons(swapped)[0], /table header must be/);
  const noSeparator = parseLines(['## Work items', HEADER_ROWS[0], row({ id: 'A' })]);
  assert.match(reasons(noSeparator)[0], /must be the separator/);
});

test('B1: a row of 5 or 7 cells is refused with its line; an escaped pipe and backticks stay inside one cell; CRLF and a BOM change nothing', () => {
  const short = parseLines(['## Work items', ...HEADER_ROWS, '| A | item | S | - | - |']);
  assert.match(reasons(short)[0], /^4: row has 5 cells, expected 6/);
  const shortPlain = parseLines(['## Work items', ...HEADER_ROWS, 'A | item | S | - | -']);
  assert.match(reasons(shortPlain)[0], /^4: row has 5 cells, expected 6/);
  const unescaped = parseLines(['## Work items', ...HEADER_ROWS, '| A | `a | b` | S | - | - | - |']);
  assert.match(reasons(unescaped)[0], /^4: row has 7 cells/);
  const escaped = parseLines(['## Work items', ...HEADER_ROWS, '| A | `a \\| b` and `c` | S | - | - | - |']);
  assert.deepEqual(escaped.problems, []);
  assert.equal(escaped.items[0].item, '`a | b` and `c`');
  const lf = statusDoc([row({ id: 'A', startedH: 0, doneH: 1 }), row({ id: 'B' })]);
  const plain = parseWorkItems(lf);
  assert.deepEqual(parseWorkItems(lf.replace(/\n/g, '\r\n')), plain);
  assert.deepEqual(parseWorkItems(`﻿${lf}`), plain);
  assert.equal(parseWorkItems(`﻿${lf.slice(lf.indexOf('## '))}`).problems.length, 0); // heading on line 1 after a BOM
});

test('B4: impossible or partial instants are refused naming the id and the cell, and state the accepted format', () => {
  const bad = ['2026-02-30T08:00Z', '2026-02-29T08:00Z', '2026-11-14T24:00Z', '2026-13-01T08:00Z', '2026-11-14T10:60Z', '2026-11-14T10:45:60Z', '2026-11-14', '2026-11-14T10:45', '2026-11-14T10:45+25:00', '2026-11-14t10:45z', '0026-11-14T10:45Z'];
  for (const text of bad) {
    const parsed = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A7', raw: { started: text } })]);
    assert.equal(parsed.problems.length, 1, text);
    assert.ok(parsed.problems[0].reason.startsWith(`A7: started "${text}" is not a real ISO 8601 instant; accepted: YYYY-MM-DDTHH:MM`), text);
  }
  const doneCell = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A8', startedH: 0, raw: { done: '2026-02-30T08:00Z' } })]);
  assert.match(reasons(doneCell)[0], /A8: done "2026-02-30T08:00Z"/);
  for (const text of ['2028-02-29T08:00Z', '2026-11-14T23:59:59.250Z', '2026-11-14T10:45-05:30', '2026-11-14T10:45+14:00']) {
    assert.equal(parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A', raw: { started: text } })]).problems.length, 0, text);
  }
});

test('B2/S4: done before started, a repeated id (any case), an empty id and placeholder evidence are refused naming the row', () => {
  const rows = [
    row({ id: 'Z1', startedH: 1, doneH: 0.5 }),
    row({ id: 'A4' }),
    row({ id: 'a4' }),
    '| | no id | S | - | - | - |',
    row({ id: 'P1', startedH: 0, doneH: 1, evidence: 'n/a' }),
    row({ id: 'P2', startedH: 0, doneH: 1, evidence: 'x' }),
  ];
  const parsed = parseWorkItems(statusDoc(rows));
  assert.match(parsed.problems[0].reason, /^Z1: done is not after started/);
  assert.match(parsed.problems[1].reason, /^a4: id repeated \(ignoring case\), first on line 8/);
  assert.match(parsed.problems[2].reason, /^row: the id cell is empty/);
  assert.match(parsed.problems[3].reason, /^P1: evidence "n\/a" is a placeholder/);
  assert.match(parsed.problems[4].reason, /^P2: evidence "x" is a placeholder/);
});
