// The one table classification (lib/history.mjs tableState) walked over every shape: {no deliver rows, deliver rows} x
// {before, after a delivery} x {last done row: build, close, rework, deliver} x {all done, an unstarted row open, a build row
// running, a close row running}, each with its expected state and the first words of line 1; then the shapes the reviews
// found (a deliver row done while rows still ran, a deliver row with only done). `now` is injected; zone UTC.
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
const LINE = { B: 'Finish: Tue 10 Nov ', C: 'Finish: Tue 10 Nov ', O: 'Finish: Tue 10 Nov ', N: 'No finish time: every row of the follow-up round', D: 'Finish: delivered Tue 10 Nov 13:' };
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
const CASES = EXPECTED.flatMap((group) => OPEN_SHAPES.map((open, k) => ({ ...group, open, code: group.states[k] })));

test(`tableState: ${CASES.length} table shapes, each with one state and its line 1`, () => {
  for (const c of CASES) {
    const name = `${c.deliverRows ? 'deliver rows' : 'no deliver rows'}, ${c.after ? 'after' : 'before'} a delivery, last ${c.last}, ${c.open}`;
    const items = itemsOf(shape(c));
    assert.equal(tableState(items, [], at(NOW_H)).state, STATE[c.code], name);
    assert.ok(lineOne(computeEstimate(items, [], at(NOW_H))).startsWith(LINE[c.code]), `${name}: ${lineOne(computeEstimate(items, [], at(NOW_H)))}`);
  }
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
