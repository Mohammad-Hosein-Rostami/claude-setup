// Tests for follow-up rounds: rows started after a delivery (fixes from a verification, owner corrections, new requests) are
// a round counted from its first start, measured from this table's finished rounds (default 0.4-2.6 h), and never earlier
// than the open rows need by their sizes; they are not a new closing phase (lib/history.mjs, lib/compute.mjs, lib/report.mjs).
// Expected values are hand arithmetic from that rule; `now` is injected, the zone fixed (Asia/Tehran, +03:30).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { findDeliveries, followUpRange, followUpRounds } from '../home/tools/estimate/lib/history.mjs';
import { formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { calibrationFactors, logEntry, phaseOf } from '../home/tools/estimate/lib/calibration.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const TZ = 'Asia/Tehran';
const at = (hours) => BASE_MS + hours * HOUR_MS; // BASE_MS = Tue 10 Nov 00:00Z = 03:30 local
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const estimate = (rows, nowH) => computeEstimate(itemsOf(rows), [], at(nowH));
const close = (spec) => row({ ...spec, item: 'close: row' });
const block = (result) => formatEstimate(result, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ }).split('\n');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} != ${expected}`);
/** Five done 6-minute S rows (0.1 h/point) and a close row 1.0-1.5 h: one lane, one delivery at 1.5 h (05:00 local). */
const FIRST_JOB = [...[0, 0.2, 0.4, 0.6, 0.8].map((h, i) => row({ id: `D${i + 1}`, startedH: h, doneH: h + 0.1 })), close({ id: 'C1', startedH: 1, doneH: 1.5 })];
/** Six open S close rows after the delivery, the first started at `startH`. */
const sixOpen = (startH) => [close({ id: 'V1', startedH: startH }), ...['V2', 'V3', 'V4', 'V5', 'V6'].map((id) => close({ id }))];

test('live shape: six open close rows after one delivery run as a follow-up round from its start, with the default range and a size floor', () => {
  const result = estimate([...FIRST_JOB, ...sixOpen(2)], 2.25);
  // band 0.1-0.5 h/point (V1's 0.25 so far is above the lowest done rate), 1 lane: by size 0.5-2.75 h from now.
  // Round: 0.4-2.6 h from its start at 2 h, so 2.4-4.6 h; the size floor lifts both ends: 2.25 + 0.5 and 2.25 + 2.75 h.
  assert.deepEqual(result.closing, { low: 0.4, high: 2.6, measured: 0 });
  near(result.finish.lowMs, at(2.75), 'low');
  near(result.finish.highMs, at(5), 'high');
  assert.deepEqual(block(result).slice(0, 2), [
    'Finish: Tue 10 Nov 06:15-08:30 (local +03:30, now 05:45)',
    'Includes: follow-up round after the delivery at 05:00, started 05:30 (V1): 6 open rows (1 running); such rounds took 0.4-2.6 h here (default, not yet measured here); the open rows need at least 0.5-2.8 h by size (V1, V2, V3, V4, V5 and 1 more, 1 lane)',
  ]);
  assert.doesNotMatch(block(result).join('\n'), /closing phase 1\.4-2\.5/);
  assert.equal(block(result)[5], 'Agent-hours: 0.6-3.0 for the open rows, counted whole');
});

test('lanes in a follow-up round are capped by the open rows of any kind', () => {
  const lanes = ['A1', 'A2', 'A3'].map((id) => row({ id, startedH: 0, doneH: 1 })).concat(['B1', 'B2', 'B3'].map((id) => row({ id, startedH: 2, doneH: 4 })));
  const result = estimate([...lanes, close({ id: 'C1', startedH: 4, doneH: 5 }), close({ id: 'V1', startedH: 6 }), close({ id: 'V2' })], 6.5);
  assert.match(block(result)[4], /; 2\.0 lanes \(measured 2\.5, capped by 2 open rows\);/);
});

test('one finished follow-up round in the history widens the default; two give a measured range', () => {
  const secondJob = [row({ id: 'B6', startedH: 2, doneH: 4.5 }), close({ id: 'C2', startedH: 4.5, doneH: 5 })]; // round 2-5 h: 3 h
  const items = itemsOf([...FIRST_JOB, ...secondJob, ...sixOpen(5.5)]);
  assert.deepEqual(followUpRounds(items, findDeliveries(items, [], at(5.75)), []).map((r) => r.hours), [3]);
  const result = computeEstimate(items, [], at(5.75));
  assert.deepEqual(result.closing, { low: 0.4, high: 3, measured: 1 });
  assert.match(block(result)[1], /; such rounds took 0\.4-3 h here \(default, widened by the 1 finished round here\);/);
  assert.deepEqual(followUpRange([{ hours: 0.5 }, { hours: 1.2 }]), { low: 0.5, high: 1.2, measured: 2 });
});

test('floor: one open L close row after a delivery never finishes before its size range', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14 }), close({ id: 'L1', size: 'L', startedH: 15 })];
  const result = estimate(rows, 15); // band 1-3 h/point: L1 needs 4-12 h, longer than the 0.4-2.6 h round
  near(result.finish.lowMs, at(19), 'low');
  near(result.finish.highMs, at(27), 'high');
});

test('a build row started after a delivery is a follow-up round too, never shorter than its size range', () => {
  const rows = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14 }), row({ id: 'B1', size: 'M', startedH: 15 })];
  const result = estimate(rows, 15.5); // B1 needs 2-6 h, 0.5 h of it run: 1.5-5.5 h from now
  assert.match(block(result)[1], /^Includes: follow-up round after the delivery at 17:30, started 18:30 \(B1\):/);
  near(result.finish.lowMs, at(17), 'low');
  near(result.finish.highMs, at(21), 'high');
});

test('the first cycle (no delivery yet) keeps the build part and the closing phase', () => {
  const result = estimate(fiveDoneRows([row({ id: 'O1' })]), 20);
  assert.equal(result.followUp, undefined);
  assert.deepEqual(result.closing, { low: 1.4, high: 2.5, measured: 0 });
});

test('a follow-up round past its low end starts the range at now, never earlier', () => {
  const result = estimate([...FIRST_JOB, close({ id: 'V1', startedH: 2 })], 4); // round 2.4-4.6 h; V1 ran 2 h, at or past the band
  near(result.finish.lowMs, at(4), 'low');
  near(result.finish.highMs, at(4.6), 'high');
});

test('14 minutes into a round of S rows after S-row history, the low end is now + the rows\' remaining by size, never earlier', () => {
  const result = estimate([...FIRST_JOB, ...sixOpen(2)], 2 + 14 / 60); // band 0.1-0.5 h/point, 1 lane
  // by size: V1 has run past 0.1 h, the other five need 0.5 h, so low = now + 0.5 h, later than round start + 0.4 h (2.4 h)
  near(result.finish.lowMs, at(2 + 14 / 60 + 0.5), 'low');
  near(result.finish.highMs, at(2 + 14 / 60 + (0.5 - 14 / 60) + 2.5), 'high'); // V1 0.27 h + five x 0.5 h, after round end 4.6 h
  const late = estimate([...FIRST_JOB, close({ id: 'V1', startedH: 2 })], 2.5); // round start + 0.4 h passed, V1 past its low rate
  near(late.finish.lowMs, at(2.5), 'low at now');
});

test('a follow-up round whose rows are all done, the last a rework row, keeps the round range and the round factor set', () => {
  const rows = [...FIRST_JOB, row({ id: 'R1', item: 'rework: row', startedH: 2, doneH: 2.5 })];
  const result = estimate(rows, 2.6); // round from 2 h: 0.4-2.6 h, nothing left by size
  assert.equal(phaseOf(result), 'round');
  near(result.finish.lowMs, at(2.6), 'low at now');
  near(result.finish.highMs, at(4.6), 'high');
  assert.equal(block(result)[1], 'Includes: follow-up round after the delivery at 05:00, started 05:30 (R1): 0 open rows (0 running); such rounds took 0.4-2.6 h here (default, not yet measured here); no open row left');
  const past = estimate(rows, 4.7);
  assert.match(formatRefusal(past, TZ), /^No finish time: the follow-up round has run 2\.7 h since it started \(R1, 05:30\), longer than the default round \(0\.4-2\.6 h, not yet measured here\), and no open row is left\./);
});

test('line 1 never starts before now: a low end at now is rounded up to the clock step, not down', () => {
  const result = estimate([...FIRST_JOB, close({ id: 'V1', startedH: 2 })], 4 + 3 / 60); // low end = now 07:33, high 4.6 h = 08:06
  assert.equal(block(result)[0], 'Finish: Tue 10 Nov 07:35-08:10 (local +03:30, now 07:33)');
});

test('a follow-up round past its high end with nothing left by size is refused, never a finish of now', () => {
  const rows = [...FIRST_JOB, close({ id: 'V1', startedH: 2 })];
  const result = estimate(rows, 6); // V1 ran 4 h: past the band (0.1-4 h/point) and past the 2.6 h round
  assert.equal(result.refused, true);
  assert.equal(formatRefusal(result, TZ).split('\n')[0], 'No finish time: the follow-up round has run 4 h since it started (V1, 05:30), longer than the default round (0.4-2.6 h, not yet measured here), and its open rows are past their measured rates.');
});

test('calibration keeps two factor sets: follow-up round estimates never adjust first-cycle ranges, nor the reverse', () => {
  const round = estimate([...FIRST_JOB, ...sixOpen(2)], 2.25);
  const firstCycle = estimate(fiveDoneRows([row({ id: 'O1' })]), 20);
  const printed = { low: round.finish.lowMs, high: round.finish.highMs };
  assert.equal(logEntry('/s', round, itemsOf([...FIRST_JOB, ...sixOpen(2)]), printed).phase, 'round');
  assert.equal(phaseOf(firstCycle), 'job');
  // Replay ratios (actual / raw): rounds A0 [2.6, 0.66], A1 [0.77, 0.14], V9 [1.5, 0.11]; first cycles all >= 1.68 low.
  const scored = (ratio, phase) => ({ actual: '2026-11-15T08:10:00Z', ratio, ...(phase ? { phase } : {}) });
  const entries = [...[1.7, 2, 2.2, 1.8, 18].map((low) => scored([low, 0.95])), ...[0.16, 0.77, 1.02, 0.5, 0.3].map((low) => scored([low, 0.5], 'round'))];
  assert.deepEqual(calibrationFactors(entries), { low: 1, high: 1, scored: 5 }); // old entries without phase are jobs
  assert.deepEqual(calibrationFactors(entries, 'round'), { low: 0.16, high: 1, scored: 5 });
  const lineOf = (factors) => formatEstimate(round, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ, calibration: { record: { scored: 10, inside: 7, late: 0, early: 3, medianLate: null }, factors } }).split('\n')[4];
  assert.equal(lineOf(calibrationFactors(entries, 'round')), 'Track record (follow-up rounds): 7 of 10 inside, 0 late, 3 early; adjusted high x1, low x0.2 (target 8 of 10)');
  assert.equal(lineOf({ low: 1, high: 1, scored: 2 }), 'Track record (follow-up rounds): 7 of 10 inside, 0 late, 3 early; adjusted once 5 are scored');
});
