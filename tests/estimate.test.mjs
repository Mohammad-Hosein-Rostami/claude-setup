// Tests for the estimate lib (home/tools/estimate/lib): table parsing, limit-window detection, the formula, the report text.
// Expected values come from the L7 spec's acceptance list and hand arithmetic, not from the implementation's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { limitWindows, projectSlug, resolveTranscriptDir } from '../home/tools/estimate/lib/limits.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, FIRST_ROW_LINE, HOUR_MS, LIMIT_TEXT, RESET_TEXT, assistant, fiveDoneRows, iso, jsonl, row, statusDoc, synthetic, userNote } from './estimate-fixtures.mjs';

const NOW = BASE_MS + 100 * HOUR_MS;
const UTC_INPUTS = { transcriptDir: '/t', transcriptCount: 1, timeZone: 'UTC' };
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const hoursOf = (windows) => windows.map((w) => [(w.start - BASE_MS) / HOUR_MS, (w.end - BASE_MS) / HOUR_MS]);

test('parseWorkItems reads rows with points, epoch times, empty cells and 1-based line numbers', () => {
  const { items, problems } = parseWorkItems(statusDoc([row({ id: 'M1', size: 'L', startedH: 1, doneH: 3 }), row({ id: 'M2', size: 'M', startedH: 2 }), row({ id: 'M3', evidence: '' })]));
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((i) => [i.id, i.size, i.points, i.line]), [['M1', 'L', 4, FIRST_ROW_LINE], ['M2', 'M', 2, FIRST_ROW_LINE + 1], ['M3', 'S', 1, FIRST_ROW_LINE + 2]]);
  assert.equal(items[0].started, BASE_MS + HOUR_MS);
  assert.equal(items[0].done, BASE_MS + 3 * HOUR_MS);
  assert.equal(items[1].done, null);
  assert.equal(items[2].started, null);
  assert.equal(items[0].evidence, 'abc1234');
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

test('parseWorkItems accepts a numeric offset and rejects a date without time', () => {
  const ok = parseWorkItems(statusDoc([row({ id: 'A', raw: { started: '2026-11-10T10:45+03:30' } })]));
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.items[0].started, Date.UTC(2026, 10, 10, 7, 15));
  const bad = parseWorkItems(statusDoc([row({ id: 'B', raw: { started: '2026-11-10' } })]));
  assert.equal(bad.problems.length, 1);
});

test('parseWorkItems reports a missing table, a wrong header and a short row', () => {
  assert.match(parseWorkItems('# Status\nno table here\n').problems[0].reason, /no "## Work items" table/);
  const wrongHeader = '## Work items\n\n| id | what |\n| -- | ---- |\n| A | x |\n';
  assert.match(parseWorkItems(wrongHeader).problems[0].reason, /header/);
  const shortRow = statusDoc(['| A | only two cells |']);
  assert.deepEqual(parseWorkItems(shortRow).problems.map((p) => p.line), [FIRST_ROW_LINE]);
});

test('parseWorkItems stops at the next heading and ignores tables inside code fences', () => {
  const fenced = '```\n## Work items\n| id | item | size | started | done | evidence |\n```\n';
  assert.equal(parseWorkItems(fenced).problems.length, 1);
  const doc = statusDoc([row({ id: 'A' })], '\n## Notes\n\n| id | item | size | started | done | evidence |\n| x | y | Q | - | - | - |\n');
  const { items, problems } = parseWorkItems(doc);
  assert.deepEqual([items.length, problems.length], [1, 0]);
});

test('limitWindows: a synthetic limit message up to the reset note is one window', () => {
  const text = jsonl([assistant(1), synthetic(2, LIMIT_TEXT), userNote(3, 'still waiting'), userNote(5, RESET_TEXT), assistant(5.5)]);
  assert.deepEqual(hoursOf(limitWindows([text])), [[2, 5]]);
});

test('limitWindows: without a reset note the next non-synthetic assistant entry ends the window', () => {
  const text = jsonl([synthetic(2, LIMIT_TEXT), synthetic(2.5, LIMIT_TEXT), assistant(4)]);
  assert.deepEqual(hoursOf(limitWindows([text])), [[2, 4]]);
});

test('limitWindows: "No response requested." and user text mentioning the limit are not windows', () => {
  const text = jsonl([synthetic(1, 'No response requested.'), userNote(2, `we discussed that you hit your usage limit`), assistant(3)]);
  assert.deepEqual(limitWindows([text]), []);
});

test('limitWindows: overlapping windows of two sessions are counted once, disjoint ones stay apart', () => {
  const a = jsonl([synthetic(2, LIMIT_TEXT), assistant(6)]);
  const b = jsonl([synthetic(4, LIMIT_TEXT), assistant(8), synthetic(20, LIMIT_TEXT), assistant(21)]);
  assert.deepEqual(hoursOf(limitWindows([a, b])), [[2, 8], [20, 21]]);
});

test('limitWindows: a window with no end runs to the last timestamp; broken lines are skipped', () => {
  const text = `${jsonl([synthetic(2, LIMIT_TEXT)])}not json hit your limit\n${jsonl([userNote(3, 'x')])}`;
  assert.deepEqual(hoursOf(limitWindows([text])), [[2, 3]]);
});

test('projectSlug turns every non-alphanumeric character into a dash and resolveTranscriptDir walks up to an existing folder', () => {
  assert.equal(projectSlug('/a/b&c/sub'), '-a-b-c-sub');
  const existing = new Set(['/root/-a-b-c']);
  const found = resolveTranscriptDir('/a/b&c/sub', '/root', (dir) => existing.has(dir));
  assert.equal(found, '/root/-a-b-c');
  assert.equal(resolveTranscriptDir('/a/b&c/sub', '/root', () => false), null);
  assert.equal(resolveTranscriptDir('/a/b&c/sub', '/root', (dir) => dir === '/root/-a-b-c-sub'), '/root/-a-b-c-sub');
});

test('computeEstimate refuses under 5 measured done items and names the done rows missing started', () => {
  const rows = [row({ id: 'M1', startedH: 0, doneH: 1 }), row({ id: 'M2', doneH: 2 }), row({ id: 'M3', startedH: 2, doneH: 3 }), row({ id: 'M4', startedH: 3, doneH: 4 })];
  const result = computeEstimate(itemsOf(rows), [], NOW);
  assert.deepEqual(result.missing, [`M2 (line ${FIRST_ROW_LINE + 1})`]);
  assert.equal(result.measured, 3);
  assert.equal(result.agentHours, undefined);
});

test('computeEstimate: r = 1,1,2,2,3 h/point and 4 open points give 4-12 agent-hours (fastest to slowest of 5), median 8', () => {
  const open = [row({ id: 'O1', size: 'L' })];
  const result = computeEstimate(itemsOf(fiveDoneRows(open)), [], NOW);
  assert.deepEqual([result.openPoints, result.openItems, result.inFlight], [4, 1, 0]);
  assert.deepEqual([result.rate.p25, result.rate.p50, result.rate.p75], [1, 2, 2]);
  assert.deepEqual([result.agentHours.low, result.agentHours.median, result.agentHours.high], [4, 8, 12]);
});

test('computeEstimate: an item spanning a 2 h limit window loses 2 h and the Assumes line names the window', () => {
  const items = itemsOf(fiveDoneRows([row({ id: 'O1' })]));
  const windowInD5 = [{ start: BASE_MS + 11 * HOUR_MS, end: BASE_MS + 13 * HOUR_MS }]; // D5 runs 10..13
  const result = computeEstimate(items, windowInD5, NOW);
  assert.deepEqual([result.rate.p25, result.rate.p50, result.rate.p75], [1, 1, 2]); // D5: (3-2)/1 = 1
  assert.match(formatEstimate(result, UTC_INPUTS), /; 1 limit window \(2 h\) in 1 transcript taken out$/m);
  assert.equal(result.windowsInSpan.count, 1);
  assert.equal(result.windowsInSpan.hours, 2);
});

test('computeEstimate: two overlapping 2 h items measure 2.0 lanes; open rows cap the lanes used', () => {
  const overlapping = [row({ id: 'A', startedH: 0, doneH: 2 }), row({ id: 'B', startedH: 0, doneH: 2 })];
  const lone = [3, 5, 7].map((h, i) => row({ id: `C${i}`, startedH: h, doneH: h + 1 }));
  const one = computeEstimate(itemsOf([...overlapping, ...lone, row({ id: 'O1' })]), [], NOW);
  assert.equal(one.measuredLanes, (2 + 2 + 3) / (2 + 3)); // sum(d) 7 over a 5 h union
  const twoOverlapsOnly = [...overlapping, ...[0, 0, 0].map((_, i) => row({ id: `E${i}`, startedH: 0, doneH: 2 }))];
  const many = computeEstimate(itemsOf([...twoOverlapsOnly, row({ id: 'O1' })]), [], NOW);
  assert.equal(many.measuredLanes, 5);
  assert.equal(many.lanes, 1); // one open row
  const wide = computeEstimate(itemsOf([...twoOverlapsOnly, row({ id: 'O1' }), row({ id: 'O2' })]), [], NOW);
  assert.equal(wide.lanes, 2);
});

test('computeEstimate: finish = now + the build part over the lanes + the default closing phase', () => {
  // D1..D5 are 1,1,2,2,3 h with 1 h gaps: one lane; two open S rows give a build part of 2-6 h, then 1.4-2.5 h of closing.
  const items = itemsOf(fiveDoneRows([row({ id: 'O1' }), row({ id: 'O2' })]));
  const result = computeEstimate(items, [], NOW);
  assert.equal(result.lanes, 1);
  assert.deepEqual([result.agentHours.low, result.agentHours.median, result.agentHours.high], [2, 4, 6]);
  assert.deepEqual([result.build.low, result.build.high], [2, 6]);
  assert.ok(Math.abs(result.finish.lowMs - (NOW + 3.4 * HOUR_MS)) < 1 && Math.abs(result.finish.highMs - (NOW + 8.5 * HOUR_MS)) < 1);
});

test('computeEstimate subtracts an in-flight row\'s running time; all done long ago with only build rows is a closing overrun', () => {
  const inFlight = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1', size: 'M', startedH: 20 })])), [], NOW);
  assert.deepEqual([inFlight.openPoints, inFlight.inFlight], [2, 1]);
  assert.deepEqual([inFlight.build.low, inFlight.build.high], [0, 0]); // ran 80 h, band 1..40 h/point (its own 80/2 is the high end)
  const finished = computeEstimate(itemsOf(fiveDoneRows()), [], NOW);
  assert.equal(finished.refused, true);
  assert.equal(finished.reason, 'overrun');
  assert.equal(finished.overrun.hours, 87); // D5 done at 13 h, now 100 h
});

test('formatEstimate prints the pasted block; no transcripts says not measured; nothing open after a delivery says delivered', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1', size: 'L' })])), [{ start: BASE_MS + 11 * HOUR_MS, end: BASE_MS + 13 * HOUR_MS }], NOW);
  const lines = formatEstimate(result, { ...UTC_INPUTS, transcriptCount: 3 }).split('\n');
  assert.equal(lines[0], 'Finish: Sat 14 Nov 09:20-14:30 (local +00:00, now 04:00)'); // now + 4 + 1.4 .. now + 8 + 2.5 h
  assert.equal(lines[1], 'Includes: 1 open row (0 running); build 4-8 h (O1, 1 lane), then the closing phase 1.4-2.5 h in series (review, fix rounds, recheck, landing; default, not yet measured here)');
  assert.equal(lines[4], 'Assumes: the table as it is now; 1-2 h/point (min-max of 5 done rows, 10 Nov); 1.0 lanes (measured); 1 limit window (2 h) in 3 transcripts taken out');
  assert.equal(lines[5], 'Agent-hours: 4.0-8.0 for the open build rows, counted whole');
  const unmeasured = formatEstimate(result, { ...UTC_INPUTS, transcriptDir: '/nowhere', transcriptCount: 0 });
  assert.match(unmeasured, /usage-limit windows not measured \(no transcripts at \/nowhere\)/);
  const done = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'C1', item: 'close: row', startedH: 13, doneH: 14 })])), [], NOW);
  assert.match(formatEstimate(done, UTC_INPUTS), /^Finish: delivered Tue 10 Nov 14:00 \(local \+00:00\)$/m);
});

test('computeEstimate: nearest rank on 8 items r = 1..8 takes ranks 2, 4 and 6 (exact products round up, not down)', () => {
  let cursor = 0;
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => {
    const made = row({ id: `D${d}`, startedH: cursor, doneH: cursor + d });
    cursor += d + 1;
    return made;
  });
  const result = computeEstimate(itemsOf([...rows, row({ id: 'O1' })]), [], NOW);
  assert.deepEqual([result.rate.p25, result.rate.p50, result.rate.p75], [2, 4, 6]);
});

// ---- Review findings of round 3 (l7-review.md): every input below must be refused or labelled, never turned into a number ----

const HEADER_ROWS = ['| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
const parseLines = (lines) => parseWorkItems(`${lines.join('\n')}\n`);
const reasons = (parsed) => parsed.problems.map((p) => `${p.line}: ${p.reason}`);

test('B1: a second ## Work items section is refused naming both heading lines', () => {
  const doc = ['## Work items', '', ...HEADER_ROWS, row({ id: 'A' }), '', '## Work items', '', ...HEADER_ROWS, row({ id: 'B' })];
  const parsed = parseLines(doc);
  assert.deepEqual(parsed.items, []);
  assert.match(parsed.problems[0].reason, /two Work items sections, lines 1 and 7/);
});

test('B1: a table row after a text line or a blank line is refused naming the break, never dropped', () => {
  const afterText = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), 'Some note', row({ id: 'A6' })]);
  assert.deepEqual(reasons(afterText), ['6: table row after a break at line 5; keep one table']);
  const afterBlank = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), '', row({ id: 'A6' })]);
  assert.deepEqual(reasons(afterBlank), ['6: table row after a break at line 5; keep one table']);
  const noLeadingPipe = parseLines(['## Work items', ...HEADER_ROWS, row({ id: 'A' }), 'A6 | open | S | - | - | -']);
  assert.match(reasons(noLeadingPipe)[0], /^5: this looks like a table row but does not start with `\|`/);
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

test('B2/S4: done equal to started, a repeated id (any case), an empty id and placeholder evidence are refused naming the row', () => {
  const rows = [
    row({ id: 'Z1', startedH: 1, doneH: 1 }),
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

test('S6: resolveTranscriptDir never tries the home folder or anything above it', () => {
  const existing = new Set(['/root/-home-me']);
  const tried = [];
  const found = resolveTranscriptDir('/home/me/work/proj', '/root', (dir) => (tried.push(dir), existing.has(dir)), '/home/me');
  assert.equal(found, null);
  assert.ok(!tried.includes('/root/-home-me'));
  assert.equal(resolveTranscriptDir('/home/me', '/root', (dir) => existing.has(dir), '/home/me'), null);
});

test('limitWindows reads a transcript given line by line the same as one string', () => {
  const text = jsonl([assistant(1), synthetic(2, LIMIT_TEXT), userNote(3, 'waiting')]);
  assert.deepEqual(limitWindows([text.split('\n')]), limitWindows([text]));
  assert.deepEqual(hoursOf(limitWindows((function* lazy() { yield text.split('\n'); })())), [[2, 3]]);
});

test('B3: a started or done later than now is refused naming the row, the cell and the time', () => {
  const rows = fiveDoneRows([row({ id: 'F1', startedH: 500 })]);
  const result = computeEstimate(itemsOf(rows), [], NOW);
  assert.equal(result.refused, true);
  assert.deepEqual(result.future.map((f) => [f.row, f.cell]), [[`F1 (line ${FIRST_ROW_LINE + 5})`, 'started']]);
  assert.equal(result.agentHours, undefined);
  assert.match(formatRefusal(result), /^No finish time: Later than now \(2026-11-14T04:00Z\): F1 \(line 12\) started 2026-11-30T20:00Z\.\nWhat to do: correct the time from the clock \(`date -u \+%Y-%m-%dT%H:%MZ`\), never from memory, or pass the right --now\.$/);
  const doneLater = computeEstimate(itemsOf(fiveDoneRows()), [], BASE_MS + 5 * HOUR_MS); // now is before D5 is done
  assert.deepEqual(doneLater.future.map((f) => f.cell), ['done', 'started', 'done', 'started', 'done']); // D3 done at 6 h, D4 and D5 both
});

test('B2: when limit windows swallow an item the rate would be zero, so the estimate is refused naming the item', () => {
  const items = itemsOf(fiveDoneRows([row({ id: 'O1' })]));
  const everything = [{ start: BASE_MS, end: BASE_MS + 20 * HOUR_MS }];
  const result = computeEstimate(items, everything, NOW);
  assert.equal(result.refused, true);
  assert.equal(result.noTime.length, 5);
  assert.match(formatRefusal(result), /No working time left after removing usage-limit windows: D1 \(line 7\)/);
  const one = computeEstimate(items, [{ start: BASE_MS, end: BASE_MS + 2 * HOUR_MS }], NOW); // D1 (0..1) and part of D2 gone
  assert.deepEqual(one.noTime, [`D1 (line ${FIRST_ROW_LINE})`]);
});

test('S4: a done row without started is refused even when five other items are measured', () => {
  const rows = [...fiveDoneRows([row({ id: 'O1' })]), row({ id: 'M1', doneH: 30 })];
  const result = computeEstimate(itemsOf(rows), [], NOW);
  assert.equal(result.refused, true);
  assert.deepEqual(result.missing, [`M1 (line ${FIRST_ROW_LINE + 6})`]);
  assert.equal(formatRefusal(result), `No finish time: Missing started on: M1 (line ${FIRST_ROW_LINE + 6}).\nWhat to do: fill started of those rows with the real start, or delete the row.`);
});

test('S3: below 10 done items the range is slowest..fastest, from 10 it is p25-p75; both say N', () => {
  const durations = (count) => Array.from({ length: count }, (_, i) => i + 1);
  const build = (count) => {
    let cursor = 0;
    const rows = durations(count).map((d) => {
      const made = row({ id: `D${d}`, startedH: cursor, doneH: cursor + d });
      cursor += d + 1;
      return made;
    });
    return computeEstimate(itemsOf([...rows, row({ id: 'O1' })]), [], BASE_MS + 1000 * HOUR_MS);
  };
  const nine = build(9);
  assert.deepEqual([nine.rate.low, nine.rate.high, nine.rate.band], [1, 9, 'min-max']);
  const ten = build(10);
  assert.deepEqual([ten.rate.low, ten.rate.high, ten.rate.band], [3, 8, 'p25-p75']); // ranks ceil(2.5)=3 and ceil(7.5)=8
  assert.match(formatEstimate(nine, UTC_INPUTS), /^Assumes: the table as it is now; 1-9 h\/point \(min-max of 9 done rows, /m);
  assert.match(formatEstimate(ten, UTC_INPUTS), /^Assumes: the table as it is now; 3-8 h\/point \(p25-p75 of 10 done rows, /m);
});

test('S3: identical rates say that no spread was measured instead of printing a falsely exact range', () => {
  const same = [0, 2, 4, 6, 8].map((h, i) => row({ id: `S${i}`, startedH: h, doneH: h + 1 }));
  const result = computeEstimate(itemsOf([...same, row({ id: 'O1' })]), [], NOW);
  const text = formatEstimate(result, UTC_INPUTS);
  assert.match(text, /; 1-1 h\/point \(min-max of 5 done rows, 10 Nov; all rates equal, real spread unknown\);/);
});

test('S1: the newest entry more than 24 h before now with open items prints one Note line; not when fresh or all done', () => {
  const inputs = UTC_INPUTS;
  const open = [row({ id: 'O1' })];
  const stale = formatEstimate(computeEstimate(itemsOf(fiveDoneRows(open)), [], BASE_MS + 13 * HOUR_MS + 30 * HOUR_MS), inputs).split('\n');
  assert.equal(stale.filter((l) => l.startsWith('Note:')).length, 1);
  assert.match(stale.at(-1), /^Note: the newest started or done in the table is 30 hours old \(2026-11-10T13:00Z\); update STATUS\.md/);
  const days = formatEstimate(computeEstimate(itemsOf(fiveDoneRows(open)), [], BASE_MS + 13 * HOUR_MS + 96 * HOUR_MS), inputs);
  assert.match(days, /^Note: the newest started or done in the table is 4 days old/m);
  const fresh = formatEstimate(computeEstimate(itemsOf(fiveDoneRows(open)), [], BASE_MS + 13 * HOUR_MS + 24 * HOUR_MS), inputs);
  assert.doesNotMatch(fresh, /Note:/);
  const allDone = computeEstimate(itemsOf(fiveDoneRows()), [], BASE_MS + 400 * HOUR_MS);
  assert.equal(allDone.refused, true); // all done long ago: the closing overrun refusal, which carries no Note
  assert.doesNotMatch(formatRefusal(allDone, 'UTC'), /Note:/);
});

test('S2: the Assumes line says whether usage-limit windows were measured, with and without transcripts', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1' })])), [], NOW);
  const withTranscripts = formatEstimate(result, { ...UTC_INPUTS, transcriptCount: 2 });
  assert.match(withTranscripts, /^Assumes: .*; no limit windows in the transcripts$/m);
  const without = formatEstimate(result, { ...UTC_INPUTS, transcriptCount: 0 });
  assert.match(without, /^Assumes: .*; usage-limit windows not measured \(no transcripts at \/t\)$/m);
});
