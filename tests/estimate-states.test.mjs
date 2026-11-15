// The one table classification (lib/history.mjs tableState) walked over every shape: {no deliver rows, deliver rows} x
// {before, after a delivery} x {last done row: build, close, rework, deliver} x {all done, an unstarted row open, a build row
// running, a close row running}, each with its expected state and the first words of line 1; then the shapes the reviews
// found (a deliver row done while rows still ran, a deliver row with only done); then the overrun shapes (a round or a first-cycle
// closing phase past the high end of its range, or exactly at it). `now` is injected; zone UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { tableState } from '../home/tools/estimate/lib/history.mjs';
import { formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, iso, row, statusDoc } from './estimate-fixtures.mjs';

const at = (hours) => BASE_MS + hours * HOUR_MS;
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const INPUTS = { transcriptDir: '/t', transcriptCount: 1, timeZone: 'UTC' };
const lineOne = (result) => (result.refused ? formatRefusal(result, 'UTC') : formatEstimate(result, INPUTS)).split('\n')[0];
const ITEM = { build: 'item', close: 'close: row', rework: 'rework: row', deliver: 'deliver: row' };
/** A deliver row is an event: done alone. */
const event = (id, doneH) => row({ id, item: ITEM.deliver, raw: { done: iso(doneH) } });

// Timeline (hours after BASE_MS): D5 done 13; a delivery at 13.25 (close 13.1-13.25, or a deliver row); the last done row
// 13.5-13.75; open rows from 14; now 14.25. A deliver-rows table "before a delivery" carries a deliver row done at 11 while
// D5 was running (10-13), so it is ignored.
const NOW_H = 14.25;
function shape({ deliverRows, after, last, open }) {
  const delivery = after ? [deliverRows ? event('X0', 13.25) : row({ id: 'C0', item: ITEM.close, startedH: 13.1, doneH: 13.25 })] : [];
  const ignored = deliverRows && !after ? [event('XI', 11)] : [];
  const lastRow = last === 'deliver' ? event('L', 13.75) : row({ id: 'L', item: ITEM[last], startedH: 13.5, doneH: 13.75 });
  const opened = { done: [], unstarted: [row({ id: 'O1' })], running: [row({ id: 'R1', startedH: 14 })], closeRunning: [row({ id: 'K1', item: ITEM.close, startedH: 14 })] }[open];
  return fiveDoneRows([...ignored, ...delivery, lastRow, ...opened]);
}

const STATE = { B: 'first-cycle-building', C: 'first-cycle-closing', O: 'round-open', N: 'round-done-not-delivered', D: 'delivered' };
const LINE = { B: 'Finish: Tue 10 Nov ', C: 'Finish: Tue 10 Nov ', O: 'Finish: Tue 10 Nov ', N: 'No finish time: every row of the follow-up round', D: 'Finish: delivered Tue 10 Nov ' };
const OPEN_SHAPES = ['done', 'unstarted', 'running', 'closeRunning'];
// Expected state per open shape (in OPEN_SHAPES order), by hand from the rules in history.mjs tableState and README Delivery.
const EXPECTED = [
  // no deliver rows: a close row followed by 10 quiet minutes is a (guessed) delivery
  { deliverRows: false, after: false, last: 'build', states: 'CBBC' },
  { deliverRows: false, after: false, last: 'close', states: 'DOOO' },
  { deliverRows: false, after: false, last: 'rework', states: 'CBBC' },
  { deliverRows: false, after: true, last: 'build', states: 'NOOO' },
  { deliverRows: false, after: true, last: 'close', states: 'DOOO' },
  { deliverRows: false, after: true, last: 'rework', states: 'NOOO' },
  // deliver rows: only a deliver row with nothing else running is a delivery
  { deliverRows: true, after: false, last: 'build', states: 'CBBC' },
  { deliverRows: true, after: false, last: 'close', states: 'CBBC' },
  { deliverRows: true, after: false, last: 'rework', states: 'CBBC' },
  { deliverRows: true, after: false, last: 'deliver', states: 'DOOO' },
  { deliverRows: true, after: true, last: 'build', states: 'NOOO' },
  { deliverRows: true, after: true, last: 'close', states: 'NOOO' },
  { deliverRows: true, after: true, last: 'rework', states: 'NOOO' },
  { deliverRows: true, after: true, last: 'deliver', states: 'DOOO' },
];
const CASES = EXPECTED.flatMap((group) => OPEN_SHAPES.map((open, k) => ({ ...group, open, code: group.states[k] })))
  .map((c) => ({ ...c, name: `${c.deliverRows ? 'deliver rows' : 'no deliver rows'}, ${c.after ? 'after' : 'before'} a delivery, last ${c.last}, ${c.open}`, rows: shape(c) }));
// Shapes from the last review: a row started in the same minute as the hand-over, and a row ticked done 1 or 5 minutes
// after it (DELIVERY_TOLERANCE_MS: 2 minutes).
const B1_STARTED = row({ id: 'B1', startedH: 13.5, doneH: 13.9 });
const EXTRA = [
  { name: 'rework started in the hand-over minute', rows: fiveDoneRows([event('X1', 13.5), row({ id: 'R1', item: ITEM.rework, startedH: 13.5 })]), code: 'O' },
  { name: 'last row ticked 1 minute after the deliver row', rows: fiveDoneRows([row({ id: 'B1', startedH: 13.5, doneH: 14 + 1 / 60 }), event('X1', 14)]), code: 'D' },
  { name: 'last row ticked 5 minutes after the deliver row', rows: fiveDoneRows([row({ id: 'B1', startedH: 13.5, doneH: 14 + 5 / 60 }), event('X1', 14)]), code: 'C' },
  { name: 'a deliver row after a finished build row', rows: fiveDoneRows([B1_STARTED, event('X1', 14)]), code: 'D' },
];

test(`tableState: ${CASES.length + EXTRA.length} table shapes, each with one state and its line 1`, () => {
  for (const c of [...CASES, ...EXTRA]) {
    const items = itemsOf(c.rows);
    assert.equal(tableState(items, [], at(NOW_H)).state, STATE[c.code], c.name);
    assert.ok(lineOne(computeEstimate(items, [], at(NOW_H))).startsWith(LINE[c.code]), `${c.name}: ${lineOne(computeEstimate(items, [], at(NOW_H)))}`);
  }
});

test('B1: a row started in the minute of the hand-over opens the follow-up round, so the round can run past its end', () => {
  const rows = fiveDoneRows([event('X1', 13.5), row({ id: 'R1', item: ITEM.rework, startedH: 13.5 })]);
  const open = computeEstimate(itemsOf(rows), [], at(14));
  assert.match(formatEstimate(open, INPUTS).split('\n')[1], /^Includes: follow-up round after the delivery at 13:30, started 13:30 \(R1\):/);
  assert.equal(open.reopen.reopened, 1); // the rework reopened that delivery
  const past = computeEstimate(itemsOf(rows), [], at(16.5)); // R1 ran 3 h: past the 0.4-2.6 h round and past every rate
  assert.equal(past.reason, 'overrun');
});

test('S1: a row ticked done 5 minutes after the deliver row was still running: the note names it', () => {
  const rows = fiveDoneRows([row({ id: 'B1', startedH: 13.5, doneH: 14 + 5 / 60 }), event('X1', 14)]);
  assert.match(formatEstimate(computeEstimate(itemsOf(rows), [], at(NOW_H)), INPUTS).split('\n')[1], /; deliver row X1 ignored: 1 row was still running at 14:00$/);
});

test('S3: a done-only deliver row later than now is refused by its done time', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([event('X1', 15)])), [], at(14));
  assert.match(formatRefusal(result, 'UTC'), /Later than now \(2026-11-10T14:00Z\): X1 \(line 12\) done 2026-11-10T15:00Z\./);
  assert.doesNotMatch(formatRefusal(result, 'UTC'), /started/);
});

test('N2: a deliver row done while a build row ran is ignored; the build done, the closing phase says it is not in rows yet', () => {
  const rows = fiveDoneRows([row({ id: 'B1', startedH: 13, doneH: 15 }), event('X1', 14.5)]);
  const result = computeEstimate(itemsOf(rows), [], at(16));
  assert.equal(result.state, 'first-cycle-closing');
  assert.deepEqual(formatEstimate(result, INPUTS).split('\n').slice(0, 2), [
    'Finish: Tue 10 Nov 16:20-17:30 (local +00:00, now 16:00)',
    'Includes: no open row: the build is done and the closing phase 1.4-2.5 h (review, fix rounds, recheck, landing; default, not yet measured here) is not in rows yet; it has run 1 h; deliver row X1 ignored: 1 row was still running at 14:30',
  ]);
});

test('N3: a deliver row done while an L row still runs is no delivery: no follow-up round starting at now', () => {
  const rows = fiveDoneRows([row({ id: 'B1', size: 'L', startedH: 13 }), row({ id: 'X1', item: ITEM.deliver, startedH: 13.5, doneH: 14 })]);
  const result = computeEstimate(itemsOf(rows), [], at(14.5));
  assert.equal(result.state, 'first-cycle-building');
  assert.match(formatEstimate(result, INPUTS).split('\n')[1], /; deliver row X1 ignored: 1 row was still running at 14:00$/);
});

test('a deliver row with only done (no started, no evidence) is accepted and delivers at once', () => {
  const rows = fiveDoneRows([row({ id: 'X1', item: ITEM.deliver, raw: { done: iso(13.5) }, evidence: '-' })]);
  const { items, problems } = parseWorkItems(statusDoc(rows));
  assert.deepEqual(problems, []);
  assert.equal(items.at(-1).started, at(13.5));
  const result = computeEstimate(items, [], at(13.55));
  assert.equal(result.state, 'delivered');
  assert.equal(formatEstimate(result, INPUTS).split('\n')[0], 'Finish: delivered Tue 10 Nov 13:30 (local +00:00)');
  assert.equal(formatEstimate(result, INPUTS).split('\n')[1], 'Includes: no open row; the last done row (X1) is a deliver row');
});

// Overrun shapes: the flag of tableState on first-cycle-closing and round-open. The delivery C0 is done at 13.25 h, the round
// starts with R1 at 14 h (default round 0.4-2.6 h, so its high end is 16.6 h); D5 is done at 13 h (default closing high end 15.5 h).
const ROUND = [row({ id: 'C0', item: ITEM.close, startedH: 13.1, doneH: 13.25 }), row({ id: 'R1', startedH: 14 })];
const OVERRUN_SHAPES = [
  { name: 'round past its high end, an unstarted row open: not before', rows: fiveDoneRows([...ROUND, row({ id: 'O2' })]), nowH: 16.6 + 1 / 60, code: 'O', kind: 'round', line: 'Finish: not before Tue 10 Nov ' },
  { name: 'round exactly at its high end: still a range', rows: fiveDoneRows([...ROUND, row({ id: 'O2' })]), nowH: 16.6, code: 'O', kind: null, line: 'Finish: Tue 10 Nov ' },
  { name: 'round past its high end, the only open row past every rate: refused', rows: fiveDoneRows(ROUND), nowH: 17, code: 'O', kind: 'round', line: 'No finish time: the follow-up round has run' },
  { name: 'closing phase past its high end, a close row open: not before', rows: fiveDoneRows([row({ id: 'K1', item: ITEM.close })]), nowH: 15.5 + 1 / 60, code: 'C', kind: 'closing', line: 'Finish: not before Tue 10 Nov ' },
  { name: 'closing phase exactly at its high end: still a range', rows: fiveDoneRows([row({ id: 'K1', item: ITEM.close })]), nowH: 15.5, code: 'C', kind: null, line: 'Finish: Tue 10 Nov ' },
  { name: 'closing phase past its high end, no row open: refused', rows: fiveDoneRows(), nowH: 15.5 + 1 / 60, code: 'C', kind: 'closing', line: 'No finish time: the closing phase has run' },
];

test(`tableState: ${OVERRUN_SHAPES.length} overrun shapes, each with its state, its overrun flag and its line 1`, () => {
  for (const c of OVERRUN_SHAPES) {
    const items = itemsOf(c.rows);
    const now = Math.round(at(c.nowH));
    const table = tableState(items, [], now);
    assert.equal(table.state, STATE[c.code], c.name);
    assert.equal(table.overrun?.kind ?? null, c.kind, c.name);
    assert.ok(lineOne(computeEstimate(items, [], now)).startsWith(c.line), `${c.name}: ${lineOne(computeEstimate(items, [], now))}`);
  }
});

// Zero-length rows (done == started) around a hand-over, now valid: one started and done in the delivery minute, or within the
// 2-minute tolerance after it, belongs to the delivered job; one done later starts a follow-up round (L1 of the l37 review).
const DELIVERY_H = 14.5; // 14:30 on this fixture's clock
const zero = (id, afterMin, item = ITEM.close) => row({ id, item, startedH: DELIVERY_H + afterMin / 60, doneH: DELIVERY_H + afterMin / 60 });
const HAND_OVER = [row({ id: 'B1', startedH: 13, doneH: 14 }), event('X1', DELIVERY_H)];
const PAUSE_RULE = [row({ id: 'B1', startedH: 13, doneH: 14 }), row({ id: 'C0', item: ITEM.close, startedH: 14, doneH: DELIVERY_H })];
const HAND_OVER_SHAPES = [
  { name: 'deliver row, a zero-length close row in the delivery minute', rows: fiveDoneRows([...HAND_OVER, zero('C1', 0)]), nowH: 14.6, code: 'D' },
  { name: 'pause rule, a zero-length close row in the delivery minute', rows: fiveDoneRows([...PAUSE_RULE, zero('C1', 0)]), nowH: 14.9, code: 'D' },
  { name: 'deliver row, two zero-length rows in the delivery minute', rows: fiveDoneRows([...HAND_OVER, zero('C1', 0), zero('C2', 0, ITEM.build)]), nowH: 14.6, code: 'D' },
  { name: 'deliver row, a zero-length row one minute after it', rows: fiveDoneRows([...HAND_OVER, zero('C1', 1)]), nowH: 14.6, code: 'D' },
  { name: 'deliver row, a zero-length row five minutes after it: a round, all done', rows: fiveDoneRows([...HAND_OVER, zero('C1', 5)]), nowH: 14.7, code: 'N' },
  { name: 'deliver row, a rework row started in the delivery minute and still open: a round', rows: fiveDoneRows([...HAND_OVER, row({ id: 'R1', item: ITEM.rework, startedH: DELIVERY_H })]), nowH: 14.6, code: 'O' },
];

test(`tableState: ${HAND_OVER_SHAPES.length} hand-over shapes with zero-length rows (the state table has ${CASES.length + EXTRA.length + OVERRUN_SHAPES.length + HAND_OVER_SHAPES.length} shapes in all)`, () => {
  for (const c of HAND_OVER_SHAPES) {
    const now = Math.round(at(c.nowH));
    const items = itemsOf(c.rows);
    assert.equal(tableState(items, [], now).state, STATE[c.code], c.name);
    assert.ok(lineOne(computeEstimate(items, [], now)).startsWith(LINE[c.code]), `${c.name}: ${lineOne(computeEstimate(items, [], now))}`);
  }
});

test('S1: the overrun test uses the range in use: a round past the printed range but inside the high factor is still a range', () => {
  const rows = fiveDoneRows([...ROUND, row({ id: 'O2' })]);
  const items = itemsOf(rows);
  const now = Math.round(at(16.6 + 0.5)); // the round ran 2.6 h + 30 minutes: past the default range, inside 2.6 x 1.5 = 3.9 h
  assert.equal(tableState(items, [], now).overrun.kind, 'round');
  assert.equal(tableState(items, [], now, () => 1.5).overrun, null);
  const scaled = tableState(items, [], Math.round(at(16.6 + 1.5)), () => 1.5).overrun; // 4.1 h: past 3.9 h
  assert.equal(scaled.closing.high, 2.6 * 1.5); // the text names the range in use
});
