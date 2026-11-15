// Tests for the "not before" finish: a follow-up round or first-cycle closing phase that has run past the high end of its range
// has no supportable upper end, so line 1 is `Finish: not before <day> <clock> (...)`, the Includes line says why, the status line
// shows `>=`, and calibration logs and scores it as a low-only prediction that feeds no factor. Expected values are hand arithmetic;
// `now` is injected, the zone fixed (Asia/Tehran, +03:30; BASE_MS = Tue 10 Nov 00:00Z = 03:30 local).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { applyFactors, calibrationFactors, isRepeat, logEntry, scoreEntries, trackRecord } from '../home/tools/estimate/lib/calibration.mjs';
import { readLog, writeLog } from '../home/tools/estimate/lib/estimate-log.mjs';
import { finishClock, formatEstimate, printedBounds } from '../home/tools/estimate/lib/report.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const TZ = 'Asia/Tehran';
const at = (hours) => Math.round(BASE_MS + hours * HOUR_MS);
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const close = (spec) => row({ ...spec, item: 'close: row' });
const block = (result) => formatEstimate(result, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ }).split('\n');
/** Five done 6-minute S rows (0.1 h/point) and a close row 1.0-1.5 h: band 0.1-0.5 h/point, one delivery at 1.5 h (05:00 local). */
const FIRST_JOB = [...[0, 0.2, 0.4, 0.6, 0.8].map((h, i) => row({ id: `D${i + 1}`, startedH: h, doneH: h + 0.1 })), close({ id: 'C1', startedH: 1, doneH: 1.5 })];
/** The round after it: V1 running since 2 h (round 0.4-2.6 h, so its high end is 4.6 h) and V2 not started. */
const ROUND = [...FIRST_JOB, close({ id: 'V1', startedH: 2 }), close({ id: 'V2' })];
const estimate = (rows, nowH) => computeEstimate(itemsOf(rows), [], at(nowH));

test('a round past its high end prints "not before" now + the open rows\' low remaining time, with the reason in the Includes line', () => {
  const result = estimate(ROUND, 5); // the round has run 3 h; V1 is past every rate, V2 needs 0.1-0.5 h by size
  assert.equal(result.notBefore, true);
  assert.equal(result.finish.highMs, null);
  assert.equal(result.raw.high, null);
  const lines = block(result);
  assert.equal(lines[0], 'Finish: not before Tue 10 Nov 08:35 (local +03:30, now 08:30)'); // 5 h + 0.1 h = 08:36, floored to 08:35
  assert.equal(lines[1], 'Includes: follow-up round after the delivery at 05:00, started 05:30 (V1): 2 open rows (1 running); '
    + 'this round has run 3 h, longer than every measured round (0.4-2.6 h; default, not yet measured here): no upper end can be supported; '
    + 'the open rows need at least 0.1-3 h by size (V1, V2, 1 lane); delivery guessed from a pause: add a deliver: row when you hand over'); // V1's 3 h so far raises the band's high rate to 3
  assert.equal(printedBounds(result, TZ).high, null);
});

test('exactly at the round\'s high end it is still a range; one minute later it is "not before"', () => {
  assert.match(block(estimate(ROUND, 4.6))[0], /^Finish: Tue 10 Nov \d\d:\d\d-\d\d:\d\d /);
  assert.match(block(estimate(ROUND, 4.6 + 1 / 60))[0], /^Finish: not before Tue 10 Nov /);
});

test('a round past its high end with no open row left by size is refused, never "not before now"', () => {
  const result = estimate([...FIRST_JOB, close({ id: 'V1', startedH: 2 })], 6);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'overrun');
});

test('a first-cycle closing phase past its high end with a close row open prints "not before" and says why', () => {
  const result = estimate(fiveDoneRows([close({ id: 'K1' })]), 20); // D5 done at 13 h: the closing has run 7 h; K1 needs 1-3 h by size
  assert.equal(result.notBefore, true);
  const lines = block(result);
  assert.equal(lines[0], 'Finish: not before Wed 11 Nov 00:30 (local +03:30, now 23:30)'); // 20 h + 1 h = 21:00Z = 00:30 local
  assert.equal(lines[1], 'Includes: 1 open row (0 running); this closing phase has run 7 h, longer than every measured closing (1.4-2.5 h; default, not yet measured here): '
    + 'no upper end can be supported; the open rows need at least 1-3 h by size (K1, 1 lane)');
});

test('the status line text is `>=<clock>`, with the weekday when the low end is not today', () => {
  assert.equal(finishClock(estimate(ROUND, 5), TZ), '>=08:35');
  assert.equal(finishClock(estimate(fiveDoneRows([close({ id: 'K1' })]), 20), TZ), '>=Wed 00:30');
});

test('a not-before result is not scaled by the calibration factors', () => {
  const result = estimate(ROUND, 5);
  const scaled = applyFactors(result, { low: 0.5, high: 2, scored: 5, deliveries: 5 });
  assert.equal(scaled.finish.lowMs, result.finish.lowMs);
  assert.equal(scaled.finish.highMs, null);
});

test('calibration: a not-before entry is logged with a null high end, round-trips the log file, and is scored inside when the delivery is not before its low end', () => {
  const items = itemsOf(ROUND);
  const result = estimate(ROUND, 5);
  const entry = logEntry('/s/STATUS.md', result, items, printedBounds(result, TZ));
  assert.deepEqual(entry.raw, [0.1, null]);
  assert.equal(entry.printed[1], null);
  const dir = mkdtempSync(join(tmpdir(), 'estimate-not-before-'));
  assert.ok(writeLog('/s/STATUS.md', [entry], dir));
  assert.deepEqual(readLog('/s/STATUS.md', dir), [entry]);
  const delivered = [...FIRST_JOB, close({ id: 'V1', startedH: 2, doneH: 6 }), close({ id: 'V2', startedH: 6, doneH: 6.2 }), close({ id: 'X1', startedH: 6.2, doneH: 6.4 })];
  const [scored] = scoreEntries([entry], itemsOf(delivered), at(8));
  assert.equal(scored.inside, true);
  assert.deepEqual(scored.ratio, [Math.round(((at(6.4) - at(5)) / HOUR_MS / 0.1) * 1000) / 1000, null]);
  const early = scoreEntries([{ ...entry, printed: ['2026-11-10T09:30Z', null] }], itemsOf(delivered), at(8))[0]; // low end 9.5 h: the delivery at 6.4 h is before it
  assert.equal(early.inside, false);
});

test('calibration: not-before entries are counted apart and feed neither factor; they do not repeat a range entry', () => {
  const lowOnly = (minute, inside) => ({ v: 1, at: '2026-11-15T08:00:00Z', open: ['V1'], points: 1, raw: [0.1, null], printed: ['2026-11-15T08:10Z', null], phase: 'round', actual: `2026-11-15T09:${minute}:00Z`, inside, ratio: [9, null] });
  const entries = [10, 11, 12, 13, 14].map((minute) => lowOnly(minute, true)).concat(lowOnly(15, false));
  assert.deepEqual(calibrationFactors(entries, 'round'), { low: 1, high: 1, scored: 0, deliveries: 0 }); // 5 deliveries scored, none of them a range
  const record = trackRecord(entries, 'round');
  assert.deepEqual([record.scored, record.lowOnly, record.lowOnlyInside], [0, 6, 5]);
  const range = { ...lowOnly(10, true), printed: ['2026-11-15T08:10Z', '2026-11-15T09:00Z'], raw: [0.1, 1] };
  assert.equal(isRepeat([range], { ...range, at: '2026-11-15T08:20:00Z', printed: ['2026-11-15T08:10Z', null], raw: [0.1, null] }), false);
  assert.equal(isRepeat([range], { ...range, at: '2026-11-15T08:20:00Z' }), true);
});

test('the Track record line says how many not-before estimates held', () => {
  const result = estimate(ROUND, 5);
  const record = { scored: 0, inside: 0, late: 0, early: 0, medianLate: null, rewritten: 0, deliveries: 0, lowOnly: 2, lowOnlyInside: 1 };
  const lines = formatEstimate(result, { transcriptDir: '/t', transcriptCount: 1, timeZone: TZ, calibration: { record, factors: { low: 1, high: 1, scored: 0, deliveries: 0 } } }).split('\n');
  assert.equal(lines[4], 'Track record (follow-up rounds): no scored estimate yet; 1 of 2 not-before estimates held (delivered no earlier than printed); the range is adjusted once 5 deliveries are scored (target: 8 of 10 inside)');
});
