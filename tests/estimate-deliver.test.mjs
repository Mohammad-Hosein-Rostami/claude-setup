// Tests for explicit deliveries: a `deliver:` row's done time is a delivery; once a table has one, only such rows are
// deliveries and the 10-minute pause rule is off. Without them the pause rule stays and the Includes line says the delivery
// was guessed (lib/items.mjs, lib/history.mjs, lib/compute.mjs, lib/report.mjs). `now` is injected; zone Asia/Tehran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { findDeliveries, followUpRounds } from '../home/tools/estimate/lib/history.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const TZ = 'Asia/Tehran';
const at = (hours) => BASE_MS + hours * HOUR_MS;
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const close = (spec) => row({ ...spec, item: 'close: row' });
const deliver = (spec) => row({ ...spec, item: 'Deliver: hand over' });
const block = (result) => formatEstimate(result, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ }).split('\n');
const GUESSED = /; delivery guessed from a pause: add a deliver: row when you hand over$/;
/** D5 done 13 h, a mid-job review row 13-14 h, then a 15-minute pause before B1 starts. */
const MID_JOB = fiveDoneRows([close({ id: 'C1', startedH: 13, doneH: 14 }), row({ id: 'B1', size: 'L', startedH: 14.25 })]);

test('a deliver: row parses as kind deliver, whatever its case', () => {
  assert.equal(itemsOf([deliver({ id: 'X1' })])[0].kind, 'deliver');
});

test('a mid-job close row and a 15-minute pause are no delivery when the table has a deliver: row', () => {
  const rows = [...MID_JOB, deliver({ id: 'X1' })];
  const result = computeEstimate(itemsOf(rows), [], at(15));
  assert.equal(result.followUp, undefined); // still the first cycle: build, then closing
  assert.deepEqual(result.closing, { low: 1.4, high: 2.5, measured: 0 });
  assert.doesNotMatch(block(result)[1], /guessed/);
  const done = [...fiveDoneRows([close({ id: 'C1', startedH: 13, doneH: 14 }), row({ id: 'B1', size: 'L', startedH: 14.25, doneH: 16 })]), deliver({ id: 'X1', startedH: 16, doneH: 16.5 })];
  assert.deepEqual(findDeliveries(itemsOf(done), [], at(17)).map((d) => d.at), [at(16.5)]);
});

test('the same table without a deliver: row keeps the pause rule and says the delivery was guessed', () => {
  const result = computeEstimate(itemsOf(MID_JOB), [], at(15));
  assert.equal(result.followUp.deliveryAt, at(14));
  assert.match(block(result)[1], GUESSED);
});

test('two deliver: rows with a follow-up round between them: the round is measured, no guess', () => {
  const rows = fiveDoneRows([deliver({ id: 'X1', startedH: 13, doneH: 13.5 }), row({ id: 'R1', item: 'rework: fix', startedH: 14, doneH: 15 }),
    deliver({ id: 'X2', startedH: 15, doneH: 15.5 }), row({ id: 'B9', startedH: 16 })]);
  const items = itemsOf(rows);
  const deliveries = findDeliveries(items, [], at(16.5));
  assert.deepEqual(deliveries.map((d) => d.at), [at(13.5), at(15.5)]);
  assert.deepEqual(followUpRounds(items, deliveries, []).map((r) => r.hours), [1.5]);
  const result = computeEstimate(items, [], at(16.5));
  assert.equal(result.followUp.deliveryAt, at(15.5));
  assert.doesNotMatch(block(result)[1], /guessed/);
});

test('a deliver: row started but not done is no delivery and no build work', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([deliver({ id: 'X1', startedH: 13.5 })])), [], at(14));
  assert.deepEqual(findDeliveries(itemsOf(fiveDoneRows([deliver({ id: 'X1', startedH: 13.5 })])), [], at(14)), []);
  assert.equal(result.followUp, undefined);
  assert.deepEqual(result.build.ids, []);
  assert.equal(result.closingElapsed, 1); // the closing has run since D5 was done at 13 h
});

test('delivered with deliver: rows: nothing open and the last done row a deliver: row, final at once; a close row last is not delivered', () => {
  const delivered = computeEstimate(itemsOf(fiveDoneRows([deliver({ id: 'X1', startedH: 13, doneH: 13.5 })])), [], at(13.55));
  assert.equal(delivered.delivered, at(13.5));
  assert.equal(delivered.provisionalUntil, null);
  const closeLast = fiveDoneRows([deliver({ id: 'X1', startedH: 13, doneH: 13.5 }), close({ id: 'C2', startedH: 14, doneH: 14.5 })]);
  assert.equal(computeEstimate(itemsOf(closeLast), [], at(15)).delivered, undefined);
});
