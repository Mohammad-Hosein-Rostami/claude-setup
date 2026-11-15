// Tests for the whole-job finish time (L30 stage 1): row kinds, deliveries and the measured closing phase (lib/history.mjs),
// the build part and the finish range (lib/compute.mjs), and the Finish block, clock text and refusals (lib/report.mjs).
// Expected values are hand arithmetic from the L30 spec's formula, never the implementation's output. Times are injected
// (`now`), the zone is fixed (Asia/Tehran, +03:30 all year; UTC for the offset text): no wall-clock assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { closingRange, findDeliveries, reopenSummary } from '../home/tools/estimate/lib/history.mjs';
import { finishClock, formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const TZ = 'Asia/Tehran';
const at = (hours) => BASE_MS + hours * HOUR_MS; // BASE_MS is Tue 10 Nov 2026 00:00Z = 03:30 local
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const estimate = (rows, nowH, windows = []) => computeEstimate(itemsOf(rows), windows, at(nowH));
const close = (spec) => row({ ...spec, item: 'close: row' });
const rework = (spec) => row({ ...spec, item: 'rework: row' });
const INPUTS = { path: 'S.md', now: 'n', transcriptDir: '/t', transcriptCount: 1, timeZone: TZ };
const block = (result, inputs = INPUTS) => formatEstimate(result, inputs).split('\n');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const nearRange = (range, [low, high], label) => {
  near(range.low, low, `${label} low`);
  near(range.high, high, `${label} high`);
};
/** Two finished jobs: D1..D5 (to 13 h), close C1 13-14.5 (tail 1.5 h); build B6 16-17, close C2 17-19 (tail 2 h). */
const TWO_JOBS = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), row({ id: 'B6', startedH: 16, doneH: 17 }), close({ id: 'C2', startedH: 17, doneH: 19 })];
/** Six done rows in two triples (0-1 h and 2-4 h): rates 1,1,1,2,2,2 h/point, measured lanes (3 + 6) / 3 = 3. */
const THREE_LANES = ['A1', 'A2', 'A3'].map((id) => row({ id, startedH: 0, doneH: 1 })).concat(['B1', 'B2', 'B3'].map((id) => row({ id, startedH: 2, doneH: 4 })));

test('kind: an item starting close: or rework: (any case) is that kind; everything else, "closed" included, is build', () => {
  const items = itemsOf([row({ id: 'A', item: 'CLOSE: review' }), row({ id: 'B', item: 'Rework: owner fix' }), row({ id: 'C', item: 'closed the gap' }), row({ id: 'D', item: 'review the diff' })]);
  assert.deepEqual(items.map((i) => i.kind), ['close', 'rework', 'build', 'build']);
});

test('fix rounds (a): only build rows open adds the 1.4-2.5 h default closing after the build part', () => {
  const result = estimate(fiveDoneRows([row({ id: 'O1' })]), 20); // rates 1-3 h/point, one S row open
  nearRange(result.build, [1, 3], 'build');
  assert.deepEqual(result.closing, { low: 1.4, high: 2.5, measured: 0 });
  nearRange(result.raw, [2.4, 5.5], 'raw');
  assert.deepEqual(result.finish, { lowMs: at(22.4), highMs: at(25.5) });
});

test('fix rounds (a): two finished jobs give their measured tails 1.5 and 2 h as the closing phase', () => {
  const items = itemsOf([...TWO_JOBS, row({ id: 'O1' })]);
  assert.deepEqual(findDeliveries(items, [], at(30)), [
    { at: at(14.5), closingStart: at(13), tailHours: 1.5 },
    { at: at(19), closingStart: at(17), tailHours: 2 },
  ]);
  const result = computeEstimate(items, [], at(30));
  assert.deepEqual(result.closing, { low: 1.5, high: 2, measured: 2 });
  nearRange(result.raw, [2.5, 5], 'raw');
  assert.equal(block(result)[1], 'Includes: 1 open row (0 running); build 1-3 h (O1, 1 lane), then the closing phase 1.5-2 h in series (review, fix rounds, recheck, landing; measured from 2 finished jobs here)');
});

test('fix rounds (a): one finished job widens the default to include its tail; the last 5 tails are used', () => {
  assert.deepEqual(closingRange([{ tailHours: 3 }]), { low: 1.4, high: 3, measured: 1 });
  assert.deepEqual(closingRange([{ tailHours: 1 }]), { low: 1, high: 2.5, measured: 1 });
  assert.deepEqual(closingRange([9, 1, 2, 3, 4, 5].map((tailHours) => ({ tailHours }))), { low: 1, high: 5, measured: 5 });
});

test('fix rounds (a): one open close row (W15-style) does not shrink the closing, whatever its size', () => {
  const rows = (size) => [...TWO_JOBS, row({ id: 'B7', startedH: 20, doneH: 21 }), close({ id: 'C3', size, startedH: 21 })];
  const small = estimate(rows('S'), 21.5);
  const large = estimate(rows('L'), 21.5);
  nearRange(small.raw, [1, 1.5], 'S'); // closing 1.5-2 h minus the 0.5 h since B7 was done
  assert.deepEqual(large.raw, small.raw);
});

test('serial closing (d): an open L row and two close rows at 3 measured lanes run the closing after the build, not divided', () => {
  const result = estimate([...THREE_LANES, row({ id: 'O1', size: 'L' }), close({ id: 'K1' }), close({ id: 'K2' })], 10);
  assert.equal(result.measuredLanes, 3);
  assert.equal(result.lanes, 1); // one open build row
  nearRange(result.build, [4, 8], 'build');
  nearRange(result.raw, [5.4, 10.5], 'raw');
});

test('serial closing (d): an L row and two S rows at 3 lanes never finish before the L row alone', () => {
  const result = estimate([...THREE_LANES, row({ id: 'O1', size: 'L' }), row({ id: 'O2' }), row({ id: 'O3' })], 10);
  assert.equal(result.lanes, 3);
  nearRange(result.build, [4, 8], 'build'); // sums 6/3 and 12/3 are below the L row's 4 and 8
});

test('rework (f): a rework row after a delivery is 1 of 1 reopened, counted so far while it is open', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), rework({ id: 'R1', startedH: 16 })];
  const result = estimate(rows, 17);
  assert.deepEqual(result.reopen, { deliveries: 1, reopened: 1, lowHours: 1, highHours: 1, open: true });
  assert.equal(block(result)[3], 'After your review: 1 of 1 earlier deliveries here were reopened by your corrections; that rework took 1 h so far (still open)');
});

test('rework (f): a reopened delivery that was delivered again counts until that delivery', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), rework({ id: 'R1', startedH: 16, doneH: 17 }), close({ id: 'C2', startedH: 17, doneH: 18 }), row({ id: 'O1' })];
  const items = itemsOf(rows);
  assert.deepEqual(reopenSummary(items, findDeliveries(items, [], at(20)), at(20)), { deliveries: 2, reopened: 1, lowHours: 2, highHours: 2, open: false });
  assert.equal(block(computeEstimate(items, [], at(20)))[3], 'After your review: 1 of 2 earlier deliveries here were reopened by your corrections; that rework took 2 h');
});

test('rework (f): no delivery prints the default After line; a plain build row after a delivery is not a reopen', () => {
  const none = estimate(fiveDoneRows([row({ id: 'O1' })]), 20);
  assert.equal(none.reopen, null);
  assert.equal(block(none)[3], 'After your review: not measured here yet (no earlier delivery in this table)');
  const plain = estimate([...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), row({ id: 'B6', startedH: 16 })], 17);
  assert.equal(block(plain)[3], 'After your review: 0 of 1 earlier deliveries here were reopened by your corrections');
});

test('rates (g): a row that ran 1.4 of its 1.5 h leaves at most 0.1 h, and its running time enters the band', () => {
  const done = [0, 2, 4, 6, 8].map((h, i) => row({ id: `D${i + 1}`, startedH: h, doneH: h + 1.5 }));
  const result = estimate([...done, row({ id: 'O1', startedH: 18.6 })], 20);
  assert.equal(result.rate.running, 1);
  near(result.rate.low, 1.4, 'band low is the running row');
  near(result.rate.high, 1.5, 'band high');
  near(result.build.low, 0, 'build low');
  assert.ok(result.build.high <= 0.1 + 1e-9, `build high ${result.build.high}`);
});

test('hidden hours (c): the block has no days; a 20-minute job prints a 5-minute clock range; a range on the grid is widened to 5 minutes', () => {
  const jobs = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 13.5 }), row({ id: 'B6', startedH: 15, doneH: 16 }), close({ id: 'C2', startedH: 16, doneH: 16.5 })];
  const twenty = computeEstimate(itemsOf([...jobs, row({ id: 'B7', startedH: 18, raw: { done: '2026-11-10T19:02Z' } })]), [], Date.parse('2026-11-10T19:12Z'));
  assert.equal(block(twenty)[0], 'Finish: Tue 10 Nov 23:00-23:05 (local +03:30, now 22:42)'); // 19:32Z = 23:02 local
  assert.doesNotMatch(formatEstimate(twenty, INPUTS), /day/);
  const onGrid = computeEstimate(itemsOf([...jobs, row({ id: 'B7', startedH: 18, doneH: 19 })]), [], Date.parse('2026-11-10T19:12Z'));
  assert.equal(block(onGrid)[0], 'Finish: Tue 10 Nov 23:00-23:05 (local +03:30, now 22:42)'); // 19:30Z = 23:00 local
});

test('hidden hours (c): a range across local midnight names both days; finishClock adds the weekday only when the low end is not today', () => {
  const evening = estimate(fiveDoneRows([row({ id: 'O1' })]), 18); // finish 20:24Z-23:30Z = 23:54-03:00 local
  assert.equal(block(evening)[0], 'Finish: Tue 10 Nov 23:50 - Wed 11 Nov 03:00 (local +03:30, now 21:30)');
  assert.equal(finishClock(evening, TZ), '23:50-03:00');
  const late = estimate(fiveDoneRows([row({ id: 'O1' })]), 20); // finish 22:24Z-01:30Z = 01:54-05:00 local, after midnight
  assert.equal(block(late)[0], 'Finish: Wed 11 Nov 01:50-05:00 (local +03:30, now 23:30)');
  assert.equal(finishClock(late, TZ), 'Wed 01:50-05:00');
  assert.equal(finishClock(late, 'UTC'), '22:20-01:30');
  assert.equal(block(late, { ...INPUTS, timeZone: 'UTC' })[0], 'Finish: Tue 10 Nov 22:20 - Wed 11 Nov 01:30 (local +00:00, now 20:00)');
});

test('the full block: Finish, Includes, Excludes, After, Assumes, Agent-hours in that order', () => {
  assert.deepEqual(block(estimate(fiveDoneRows([row({ id: 'O1' })]), 20)), [
    'Finish: Wed 11 Nov 01:50-05:00 (local +03:30, now 23:30)',
    'Includes: 1 open row (0 running); build 1-3 h (O1, 1 lane), then the closing phase 1.4-2.5 h in series (review, fix rounds, recheck, landing; default, not yet measured here)',
    'Excludes: your review and any rework it starts (next line); usage-limit pauses from now on; steps only you do (push, deploy); requests that are not rows',
    'After your review: not measured here yet (no earlier delivery in this table)',
    'Assumes: the table as it is now; 1-3 h/point (min-max of 5 done rows, 10 Nov); 1.0 lanes (measured); no limit windows in the transcripts',
    'Agent-hours: 1.0-3.0 for the open build rows, counted whole',
  ]);
});

test('missing clock (h): a 9-minute quiet gap after a close row is not a delivery, 10 minutes is', () => {
  const after = (started) => itemsOf([...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14 }), row({ id: 'B6', raw: { started } })]);
  assert.deepEqual(findDeliveries(after('2026-11-10T14:09Z'), [], at(15)), []);
  assert.deepEqual(findDeliveries(after('2026-11-10T14:10Z'), [], at(15)).map((d) => d.at), [at(14)]);
});

test('missing clock (h): nothing open after a delivery prints when it was delivered', () => {
  const result = estimate(TWO_JOBS, 20);
  assert.equal(result.delivered, at(19));
  assert.deepEqual(block(result), ['Finish: delivered Tue 10 Nov 22:30 (local +03:30)', 'After your review: 0 of 2 earlier deliveries here were reopened by your corrections']);
});

test('overrun: no build row open and the closing ran as long as its high end is refused with a reason and what to do', () => {
  const almost = estimate(fiveDoneRows(), 15.5 - 1 / 60);
  assert.equal(almost.refused, undefined);
  const result = estimate(fiveDoneRows(), 15.5); // D5 done 13 h, default high 2.5 h
  assert.equal(result.refused, true);
  assert.equal(result.finish, undefined);
  assert.equal(formatRefusal(result, TZ), 'No finish time: the closing phase has run 2.5 h since the last build row was done (D5, 16:30), longer than the default closing (1.4-2.5 h, not yet measured here).\n'
    + 'What to do: tell the owner the job is past its usual closing; this ends at delivery, whose length then joins the history. Work not in the table: add it as a row first.');
  const measured = estimate([...TWO_JOBS, row({ id: 'B7', startedH: 20, doneH: 21 })], 23);
  assert.match(formatRefusal(measured, TZ), /^No finish time: the closing phase has run 2 h since the last build row was done \(B7, 00:30\), longer than every closing measured here \(1\.5-2 h, 2 jobs\)\.\n/);
  const onlyClose = estimate([...TWO_JOBS, close({ id: 'C3', startedH: 20 })], 23);
  assert.match(formatRefusal(onlyClose, TZ), /run 3 h since the first closing row started \(C3, 23:30\)/);
});

test('the table refusals keep their reasons under No finish time: and add one What to do sentence each', () => {
  const few = estimate([row({ id: 'M1', doneH: 1 }), row({ id: 'M2', startedH: 1, doneH: 2 }), row({ id: 'O1' })], 20);
  assert.equal(formatRefusal(few, TZ), 'No finish time: 1 done items with started, done and evidence; need 5. Missing started on: M1 (line 7).\n'
    + 'What to do: finish and record more rows. Fill started of those rows with the real start, or delete the row.');
  const later = estimate(fiveDoneRows([row({ id: 'F1', startedH: 500 })]), 20);
  assert.match(formatRefusal(later, TZ), /\nWhat to do: correct the time from the clock \(`date -u \+%Y-%m-%dT%H:%MZ`\), never from memory, or pass the right --now\.$/);
  const swallowed = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1' })])), [{ start: BASE_MS, end: at(20) }], at(20));
  assert.match(formatRefusal(swallowed, TZ), /\nWhat to do: correct started and done of those rows: they lie inside usage-limit windows\.$/);
  for (const refusal of [few, later, swallowed]) assert.doesNotMatch(formatRefusal(refusal, TZ), /Finish:/);
});
