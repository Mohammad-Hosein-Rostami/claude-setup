// Tests for the estimate lib (home/tools/estimate/lib): table parsing, limit-window detection, the formula, the report text.
// Expected values come from the L7 spec's acceptance list and hand arithmetic, not from the implementation's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { limitWindows, projectSlug, resolveTranscriptDir } from '../home/tools/estimate/lib/limits.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, FIRST_ROW_LINE, HOUR_MS, LIMIT_TEXT, RESET_TEXT, assistant, fiveDoneRows, iso, jsonl, row, statusDoc, synthetic, userNote } from './estimate-fixtures.mjs';

const NOW = BASE_MS + 100 * HOUR_MS;
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
  assert.match(problems[3].reason, /done is before started/);
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

test('computeEstimate: r = 1,1,2,2,3 h/point and 4 open points give 4-8 agent-hours, median 8 (nearest rank)', () => {
  const open = [row({ id: 'O1', size: 'L' })];
  const result = computeEstimate(itemsOf(fiveDoneRows(open)), [], NOW);
  assert.deepEqual([result.openPoints, result.openItems, result.inFlight], [4, 1, 0]);
  assert.deepEqual([result.rate.p25, result.rate.p50, result.rate.p75], [1, 2, 2]);
  assert.deepEqual([result.agentHours.low, result.agentHours.median, result.agentHours.high], [4, 8, 8]);
});

test('computeEstimate: an item spanning a 2 h limit window loses 2 h and the idle share is above zero', () => {
  const items = itemsOf(fiveDoneRows([row({ id: 'O1' })]));
  const windowInD5 = [{ start: BASE_MS + 11 * HOUR_MS, end: BASE_MS + 13 * HOUR_MS }]; // D5 runs 10..13
  const result = computeEstimate(items, windowInD5, NOW);
  assert.deepEqual([result.rate.p25, result.rate.p50, result.rate.p75], [1, 1, 2]); // D5: (3-2)/1 = 1
  assert.ok(result.limitIdle > 0);
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

test('computeEstimate: running time and calendar days follow Running / active share / 24', () => {
  // D1..D5 are 1,1,2,2,3 h with 1 h gaps: union 9 h of a 13 h span, one lane.
  const items = itemsOf(fiveDoneRows([row({ id: 'O1' }), row({ id: 'O2' })]));
  const result = computeEstimate(items, [], NOW);
  assert.equal(result.lanes, 1);
  assert.deepEqual([result.agentHours.low, result.agentHours.median, result.agentHours.high], [2, 4, 4]);
  assert.ok(Math.abs(result.activeShare - 9 / 13) < 1e-9);
  assert.ok(Math.abs(result.calendarDays.median - 4 / (9 / 13) / 24) < 1e-9);
});

test('computeEstimate counts in-flight rows whole and reports nothing remaining when all are done', () => {
  const inFlight = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1', size: 'M', startedH: 20 })])), [], NOW);
  assert.deepEqual([inFlight.openPoints, inFlight.inFlight], [2, 1]);
  const finished = computeEstimate(itemsOf(fiveDoneRows()), [], NOW);
  assert.equal(finished.openItems, 0);
  assert.equal(finished.agentHours.median, 0);
});

test('formatEstimate prints the pasted block; no transcripts says not measured; nothing open prints Remaining: 0 items', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1', size: 'L', startedH: 20 })])), [{ start: BASE_MS + 11 * HOUR_MS, end: BASE_MS + 13 * HOUR_MS }], NOW);
  const lines = formatEstimate(result, { path: 'STATUS.md', now: '2026-11-14T10:00:00Z', transcriptDir: '/t', transcriptCount: 3 }).split('\n');
  assert.equal(lines[0], 'Estimate (computed 2026-11-14T10:00:00Z by estimate.mjs from STATUS.md)');
  assert.equal(lines[1], 'Remaining: 1 item, 4 points (1 in flight, counted whole)');
  assert.match(lines[2], /^Agent-hours: 4-8 \(median \d+\)$/);
  assert.match(lines[3], /^Running time: [\d.]+-[\d.]+ h at 1\.0 lanes \(measured/);
  assert.match(lines[4], /^Calendar: [\d.]+-[\d.]+ days \(active \d+% of elapsed; usage-limit idle \d+%\)$/);
  assert.match(lines[5], /^From: 5 done items 2026-11-10\.\.2026-11-10, [\d.]+-[\d.]+ h\/point \(p25-p75\), 1 limit window \(2 h\) in 3 transcripts$/);
  const unmeasured = formatEstimate(result, { path: 'S.md', now: 'n', transcriptDir: '/nowhere', transcriptCount: 0 });
  assert.match(unmeasured, /usage-limit idle: not measured \(no transcripts at \/nowhere\)/);
  const done = computeEstimate(itemsOf(fiveDoneRows()), [], NOW);
  assert.match(formatEstimate(done, { path: 'S.md', now: 'n', transcriptDir: '/t', transcriptCount: 1 }), /\nRemaining: 0 items\n/);
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
