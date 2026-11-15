// Tests for the whole-job finish time (L30 stage 1): row kinds, deliveries and the measured closing phase (lib/history.mjs),
// the build part and the finish range (lib/compute.mjs), and the Finish block, clock text and refusals (lib/report.mjs).
// Expected values are hand arithmetic from the L30 spec's formula, never the implementation's output. Times are injected
// (`now`), the zone is fixed (Asia/Tehran, +03:30 all year; UTC for the offset text): no wall-clock assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { closingRange, findDeliveries, reopenSummary } from '../home/tools/estimate/lib/history.mjs';
import { finishClock, formatEstimate, formatRefusal, printedBounds } from '../home/tools/estimate/lib/report.mjs';
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

test('fix rounds (a): two finished jobs give their measured tails 1.5 and 2 h; a first cycle with nothing open runs the closing phase', () => {
  const items = itemsOf([...TWO_JOBS, row({ id: 'B7', startedH: 20, doneH: 21 })]);
  const deliveries = findDeliveries(items, [], at(30));
  assert.deepEqual(deliveries, [
    { at: at(14.5), closingStart: at(13), tailHours: 1.5 },
    { at: at(19), closingStart: at(17), tailHours: 2 },
  ]);
  assert.deepEqual(closingRange(deliveries), { low: 1.5, high: 2, measured: 2 });
  const result = estimate(fiveDoneRows(), 14); // first cycle, no open row, the last done row (D5, 13 h) a build row
  nearRange(result.raw, [0.4, 1.5], 'raw'); // 1.4-2.5 h minus the 1 h since D5 was done
  assert.equal(block(result)[1], 'Includes: no open row: the build is done and the closing phase 1.4-2.5 h (review, fix rounds, recheck, landing; default, not yet measured here) is not in rows yet; it has run 1 h');
});

test('fix rounds (a): one finished job widens the default to include its tail; the last 5 tails are used', () => {
  assert.deepEqual(closingRange([{ tailHours: 3 }]), { low: 1.4, high: 3, measured: 1 });
  assert.deepEqual(closingRange([{ tailHours: 1 }]), { low: 1, high: 2.5, measured: 1 });
  assert.deepEqual(closingRange([9, 1, 2, 3, 4, 5].map((tailHours) => ({ tailHours }))), { low: 1, high: 5, measured: 5 });
});

test('fix rounds (a): one open close row (W15-style) does not shrink the closing, whatever its size', () => {
  const rows = (size) => fiveDoneRows([close({ id: 'C3', size, startedH: 13.5 })]); // first cycle: D5 done 13 h
  const small = estimate(rows('S'), 14);
  const large = estimate(rows('L'), 14);
  nearRange(small.raw, [0.4, 1.5], 'S'); // closing 1.4-2.5 h minus the 1 h since D5 was done
  assert.deepEqual(large.raw, small.raw);
});

test('fix rounds (a): after a delivery an open close row is a follow-up round, floored by its size', () => {
  const rows = (size) => [...TWO_JOBS, row({ id: 'B7', startedH: 20, doneH: 21 }), close({ id: 'C3', size, startedH: 21 })];
  // round from B7's start at 20 h, 0.4-3 h (default widened by the 16-19 h round); band 1-3 h/point, 0.5 h of C3 run
  nearRange(estimate(rows('S'), 21.5).raw, [0.5, 2.5], 'S'); // size 0.5-2.5 h beats the round's 20.4-23 h
  nearRange(estimate(rows('L'), 21.5).raw, [3.5, 11.5], 'L');
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
  assert.deepEqual(result.reopen, { deliveries: 1, reopened: 1, lowHours: 1, highHours: 1, open: true, reworkOpen: true });
  assert.equal(block(result)[3], 'After your review: 1 of 1 earlier deliveries here were reopened by your corrections; that rework took 1 h so far (still open)');
});

test('rework (f): a reopened delivery that was delivered again counts until that delivery', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), rework({ id: 'R1', startedH: 16, doneH: 17 }), close({ id: 'C2', startedH: 17, doneH: 18 }), row({ id: 'O1' })];
  const items = itemsOf(rows);
  assert.deepEqual(reopenSummary(items, findDeliveries(items, [], at(20)), at(20)), { deliveries: 2, reopened: 1, lowHours: 2, highHours: 2, open: false, reworkOpen: false });
  assert.equal(block(computeEstimate(items, [], at(20)))[3], 'After your review: 1 of 2 earlier deliveries here were reopened by your corrections; that rework took 2 h');
});

test('rework (f): no delivery prints the default After line; a plain build row after a delivery is not a reopen', () => {
  const none = estimate(fiveDoneRows([row({ id: 'O1' })]), 20);
  assert.equal(none.reopen, null);
  assert.equal(block(none)[3], 'After your review: not measured here yet (no earlier delivery in this table)');
  const plain = estimate([...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), row({ id: 'B6', startedH: 16 })], 17);
  assert.equal(block(plain)[3], 'After your review: 0 of 1 earlier deliveries here were reopened by your corrections');
});

test('rates (g): a row that ran 1.4 of its 1.5 h leaves at most 0.1 h, and its running time enters the band above the lowest done rate', () => {
  const done = [[0, 1], [2, 1.5], [4, 1.5], [6, 1.5], [8, 1.5]].map(([h, d], i) => row({ id: `D${i + 1}`, startedH: h, doneH: h + d }));
  const result = estimate([...done, row({ id: 'O1', startedH: 18.6 })], 20);
  assert.equal(result.rate.running, 1);
  near(result.rate.p25, 1.4, 'p25 of 1, 1.4, 1.5 x4 is the running row');
  near(result.rate.low, 1, 'band low');
  near(result.rate.high, 1.5, 'band high');
  near(result.build.low, 0, 'build low');
  assert.ok(result.build.high <= 0.1 + 1e-9, `build high ${result.build.high}`);
});

test('hidden hours (c): the block has no days; a 20-minute job prints a 5-minute clock range; a range on the grid is widened to 5 minutes', () => {
  // every row 0.25 h per point; a delivery at 3.25 h, then two finished 0.5 h follow-up rounds: the round range is 0.5-0.5 h
  const quarter = (id, h, item) => row({ id, item, startedH: h, doneH: h + 0.25 });
  const jobs = [...[0, 0.5, 1, 1.5, 2].map((h, i) => quarter(`E${i + 1}`, h)), quarter('C1', 3, 'close: row'), quarter('B6', 4), quarter('C2', 4.25, 'close: row'),
    quarter('B7', 5), quarter('C3', 5.25, 'close: row')];
  const twenty = computeEstimate(itemsOf([...jobs, row({ id: 'B8', raw: { started: '2026-11-10T06:02Z' } })]), [], Date.parse('2026-11-10T06:12Z'));
  assert.equal(block(twenty)[0], 'Finish: Tue 10 Nov 10:00-10:05 (local +03:30, now 09:42)'); // round end 06:32Z = 10:02 local; B8 needs 5 more minutes
  assert.doesNotMatch(formatEstimate(twenty, INPUTS), /day/);
  const onGrid = computeEstimate(itemsOf([...jobs, row({ id: 'B8', startedH: 6 })]), [], Date.parse('2026-11-10T06:12Z'));
  assert.equal(block(onGrid)[0], 'Finish: Tue 10 Nov 10:00-10:05 (local +03:30, now 09:42)'); // 06:30Z = 10:00 local
});

test('hidden hours (c): a range across local midnight names both days; finishClock adds the weekday only when the low end is not today', () => {
  const evening = estimate(fiveDoneRows([row({ id: 'O1' })]), 18); // finish 20:24Z-23:30Z = 23:54-03:00 local
  assert.equal(block(evening)[0], 'Finish: Tue 10 Nov 23:50 - Wed 11 Nov 03:00 (local +03:30, now 21:30)');
  assert.equal(finishClock(evening, TZ), 'Tue 23:50 - Wed 03:00');
  const late = estimate(fiveDoneRows([row({ id: 'O1' })]), 20); // finish 22:24Z-01:30Z = 01:54-05:00 local, after midnight
  assert.equal(block(late)[0], 'Finish: Wed 11 Nov 01:50-05:00 (local +03:30, now 23:30)');
  assert.equal(finishClock(late, TZ), 'Wed 01:50-05:00');
  assert.equal(finishClock(late, 'UTC'), 'Tue 22:20 - Wed 01:30');
  assert.equal(finishClock(estimate(fiveDoneRows([row({ id: 'O1' })]), 14), TZ), '19:50-23:00'); // both ends today: clock only
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
  assert.deepEqual(block(result), [
    'Finish: delivered Tue 10 Nov 22:30 (local +03:30)',
    'Includes: no open row; the last done row (C2) is a close row; delivery guessed from a pause: add a deliver: row when you hand over',
    'After your review: 0 of 2 earlier deliveries here were reopened by your corrections',
  ]);
});

test('overrun: no build row open and the closing ran as long as its high end is refused with a reason and what to do', () => {
  const almost = estimate(fiveDoneRows(), 15.5 - 1 / 60);
  assert.equal(almost.refused, undefined);
  assert.equal(estimate(fiveDoneRows(), 15.5).refused, undefined); // exactly at the high end: still a range
  const result = estimate(fiveDoneRows(), 15.5 + 1 / 60); // D5 done 13 h, default high 2.5 h: one minute past it
  assert.equal(result.refused, true);
  assert.equal(result.finish, undefined);
  assert.equal(formatRefusal(result, TZ), 'No finish time: the closing phase has run 2.5 h since the last build row was done (D5, 16:30), longer than the default closing (1.4-2.5 h, not yet measured here).\n'
    + 'What to do: tell the owner the job is past its usual closing; this ends at delivery, whose length then joins the history. Work not in the table: add it as a row first.');
  const afterDelivery = estimate([...TWO_JOBS, row({ id: 'B7', startedH: 20, doneH: 21 })], 23); // B7 started after a delivery: a round
  assert.match(formatRefusal(afterDelivery, TZ), /^No finish time: every row of the follow-up round after the delivery at 22:30 \(started 23:30, B7\) is done, and no deliver: row marks its hand-over\.\n/);
  const onlyClose = estimate([0, 1, 2, 3, 4].map((h, i) => close({ id: `K${i + 1}`, startedH: h, doneH: h + 1 })).concat(close({ id: 'K6', startedH: 5 })), 8);
  assert.match(formatRefusal(onlyClose, TZ), /run 8 h since the first closing row started \(K1, 03:30\)/);
  assert.equal(estimate([...TWO_JOBS, close({ id: 'C3', startedH: 20 })], 23).refused, undefined); // exactly at the round's high end (3 h): still a range
  const round = estimate([...TWO_JOBS, close({ id: 'C3', startedH: 20 })], 23 + 1 / 60); // after a delivery, one minute past the round's high end
  assert.match(formatRefusal(round, TZ), /^No finish time: the follow-up round has run 3 h since it started \(C3, 23:30\), longer than the default round \(0\.4-3 h, widened by 1 finished round here\)/);
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

// ---- Review of a8ed49f ----

test('review 1: a running row only raises the band: one started a minute ago leaves the build at 8-24 h', () => {
  const rows = fiveDoneRows([row({ id: 'L1', size: 'L', raw: { started: '2026-11-10T13:59Z' } }), row({ id: 'M1', size: 'M' }), row({ id: 'M2', size: 'M' })]);
  const result = estimate(rows, 14);
  assert.deepEqual([result.rate.low, result.rate.high, result.rate.running], [1, 3, 0]);
  assert.equal(block(result, { ...INPUTS, timeZone: 'UTC' })[0], 'Finish: Tue 10 Nov 23:20 - Wed 11 Nov 16:30 (local +00:00, now 14:00)');
});

test('review 4: a close row done 2 minutes ago is not yet a delivery; the closing has run 2 h since the last build row', () => {
  const rows = fiveDoneRows([close({ id: 'C1', startedH: 13.5, doneH: 15 }), close({ id: 'C2' })]);
  assert.deepEqual(findDeliveries(itemsOf(rows), [], Date.parse('2026-11-10T15:02Z')), []);
  assert.deepEqual(findDeliveries(itemsOf(rows), [], Date.parse('2026-11-10T15:10Z')).map((d) => d.at), [at(15)]);
  const result = computeEstimate(itemsOf(rows), [], Date.parse('2026-11-10T15:02Z'));
  assert.equal(block(result, { ...INPUTS, timeZone: 'UTC' })[0], 'Finish: Tue 10 Nov 15:05-15:30 (local +00:00, now 15:02)'); // never before now
});

test('review 6a: a row running past every measured rate says its remaining time is not known', () => {
  const result = estimate(fiveDoneRows([row({ id: 'O1', startedH: 13.5 })]), 20); // ran 6.5 h, slowest done row 3 h/point
  assert.equal(block(result)[1], 'Includes: 1 open row (1 running); build 0-0 h (O1, 1 lane; O1 past every measured rate, its remaining time is not known), then the closing phase 1.4-2.5 h in series (review, fix rounds, recheck, landing; default, not yet measured here)');
});

test('review 6b: the printed low end is never earlier than now before the 5-minute floor', () => {
  const result = { ...estimate(fiveDoneRows([row({ id: 'O1' })]), 20), finish: { lowMs: at(19), highMs: at(23) } };
  assert.equal(printedBounds(result, 'UTC').low, at(20));
});

test('review 6c: a reopened delivery whose rework rows are done says "not delivered again yet", not "still open"', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14.5 }), rework({ id: 'R1', startedH: 16, doneH: 17 }), close({ id: 'C2', startedH: 17 })];
  const result = estimate(rows, 18);
  assert.equal(block(result)[3], 'After your review: 1 of 1 earlier deliveries here were reopened by your corrections; that rework took 2 h so far (not delivered again yet)');
});

// ---- Live case of 15 Nov: every row done, the last a close row finished a minute ago ----

const CLOSED = fiveDoneRows([close({ id: 'C1', startedH: 13, doneH: 14 })]); // C1 done 14:00Z = 17:30 local

test('no open row and the last done row a close row: delivered, provisional until its 10 quiet minutes have passed', () => {
  const result = computeEstimate(itemsOf(CLOSED), [], Date.parse('2026-11-10T14:01Z'));
  assert.equal(result.finish, undefined);
  assert.deepEqual(block(result), [
    'Finish: delivered Tue 10 Nov 17:30 (local +03:30; provisional until 17:40: no open row)',
    'Includes: no open row; the last done row (C1) is a close row; delivery guessed from a pause: add a deliver: row when you hand over',
    'After your review: not measured here yet (no earlier delivery in this table)',
  ]);
});

test('no open row, 11 minutes after the last close row: delivered, final', () => {
  const result = computeEstimate(itemsOf(CLOSED), [], Date.parse('2026-11-10T14:11Z'));
  assert.deepEqual(block(result), [
    'Finish: delivered Tue 10 Nov 17:30 (local +03:30)',
    'Includes: no open row; the last done row (C1) is a close row; delivery guessed from a pause: add a deliver: row when you hand over',
    'After your review: 0 of 1 earlier deliveries here were reopened by your corrections',
  ]);
});

test('a row started inside the 10 quiet minutes brings back a normal Finish range', () => {
  const result = computeEstimate(itemsOf([...CLOSED, row({ id: 'B6', raw: { started: '2026-11-10T14:05Z' } })]), [], Date.parse('2026-11-10T14:06Z'));
  assert.equal(result.delivered, undefined);
  assert.match(block(result)[0], /^Finish: Tue 10 Nov \d\d:\d\d/);
});

test('no open row but the last done row a build row: the closing phase still applies', () => {
  const result = estimate(fiveDoneRows(), 13.5); // D5 done 13 h: closing 1.4-2.5 h, 0.5 h of it run
  assert.equal(result.delivered, undefined);
  nearRange(result.raw, [0.9, 2], 'raw');
});
