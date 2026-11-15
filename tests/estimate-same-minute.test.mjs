// Tests for rows whose two times are in the same minute (times have minute precision, so done == started is valid): the parser
// accepts them, done before started stays refused, and such a row of under a minute gives no rate (lib/compute.mjs), is named in
// the Assumes line and in a count refusal, and never distorts the p25-p75 band. Expected values are hand arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { scoreEntries } from '../home/tools/estimate/lib/calibration.mjs';
import { formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const TZ = 'UTC';
const at = (hours) => BASE_MS + hours * HOUR_MS;
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const MINUTE_H = 1 / 60;

test('done equal to started is accepted; done before started is refused with the same message as before', () => {
  const equal = parseWorkItems(statusDoc([row({ id: 'A17', startedH: 1, doneH: 1 })]));
  assert.deepEqual(equal.problems, []);
  assert.equal(equal.items[0].started, equal.items[0].done);
  const before = parseWorkItems(statusDoc([row({ id: 'A18', startedH: 1, doneH: 1 - MINUTE_H })]));
  assert.equal(before.problems.length, 1);
  assert.match(before.problems[0].reason, /^A18: done is not after started/);
});

test('a row of under a minute leaves the rate band, the lanes and the Assumes row count as they were, and is named', () => {
  const plain = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1' })])), [], at(20));
  const withInstant = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'A17', startedH: 14, doneH: 14 }), row({ id: 'O1' })])), [], at(20));
  assert.equal(withInstant.refused, undefined);
  assert.deepEqual(withInstant.rate, plain.rate); // a 0 h/point rate would have pulled the low end to 0
  assert.equal(withInstant.measuredLanes, plain.measuredLanes);
  assert.deepEqual(withInstant.underMinute, ['A17']);
  const assumes = formatEstimate(withInstant, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ }).split('\n').find((l) => l.startsWith('Assumes:'));
  assert.match(assumes, /h\/point \(min-max of 5 done rows, [^)]*\); A17 took under a minute and is left out of the rates; /);
});

test('rows of under a minute do not count toward the 5 rows needed: the refusal says so', () => {
  const four = fiveDoneRows().slice(0, 4);
  const result = computeEstimate(itemsOf([...four, row({ id: 'A17', startedH: 14, doneH: 14 }), row({ id: 'O1' })]), [], at(20));
  assert.equal(result.refused, true);
  assert.match(formatRefusal(result, TZ), /^No finish time: 4 done items with started, done and evidence; need 5 \(A17 took under a minute and is not counted\)\./);
});

test('a row started in the current minute, and one done in it, are not later than now', () => {
  const now = at(20);
  const rows = fiveDoneRows([row({ id: 'S1', startedH: 20 }), row({ id: 'S2', startedH: 19.5, doneH: 20 })]);
  const result = computeEstimate(itemsOf(rows), [], now);
  assert.equal(result.refused, undefined);
  assert.equal(result.openItems, 1); // S1 is open; S2 is done in the current minute
});

test('an estimate printed 30 s into the minute is scored against a delivery stamped with that minute', () => {
  const rows = fiveDoneRows([row({ id: 'O1', startedH: 14, doneH: 15 }), row({ id: 'C1', item: 'close: row', startedH: 15, doneH: 15.5 })]);
  const entry = { v: 1, at: new Date(at(15.5) + 30_000).toISOString().replace('.000Z', 'Z'), status: '/s', open: ['O1'], started: [new Date(at(14)).toISOString().replace(':00.000Z', 'Z')], sizes: ['S'], points: 1, raw: [1, 2], printed: ['2026-11-10T15:00Z', '2026-11-10T17:00Z'] };
  const [scored] = scoreEntries([entry], itemsOf(rows), at(20));
  assert.equal(scored.actual, '2026-11-10T15:30:00Z');
  assert.equal(scored.inside, true);
});
