// Tests for the job progress percent (home/tools/estimate/lib/progress.mjs): the forecast path, the fallback path for refusals, the hold
// that never lets a job's percent fall, the 99 cap, the tags. The numbers are worked out by hand from the lane P spec (step 1), not
// copied from the code's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classMedians, progressOf } from '../home/tools/estimate/lib/progress.mjs';

const row = (size, done, elapsedMin = 0) => ({ size, done, elapsedMin });
const NO_POOL = { medians: {}, growth: null };
const forecast = (fields = {}) => progressOf({
  workedMin: 60, p50LeftMin: 30, committedLeftMin: 50, rows: [row('S', true), row('M', false)], pool: NO_POOL, heldPct: null, moved: false, rowsAdded: false, ...fields,
});
const fallback = (fields = {}) => forecast({ p50LeftMin: null, committedLeftMin: null, ...fields });

test('forecast path: floor(100 x worked / (worked + median left)), with the rows and the median left', () => {
  assert.deepEqual(forecast(), { pct: 66, approx: false, rowsDone: 1, rowsTotal: 2, leftMin: 30, tag: null }); // 60 / 90 = 66.7
  assert.equal(forecast({ workedMin: 0, p50LeftMin: 30 }).pct, 0);
  assert.equal(forecast({ workedMin: 0, p50LeftMin: 0 }).pct, 0, 'nothing worked and nothing left is 0, not NaN');
});

test('fallback path: weights S 3, M 9, L 40 without a pool median, earned = done weights + open rows capped at 90% of their weight', () => {
  const rows = [row('S', true), row('M', false, 3), row('L', false, 100)];
  // earned = 3 + 3 + min(36, 100) = 42; total = (3 + 9 + 40) / (1 - 0.416) = 89.04; 42 / 89.04 = 47.2 %
  assert.deepEqual(fallback({ rows }), { pct: 47, approx: true, rowsDone: 1, rowsTotal: 3, leftMin: null, tag: null });
});

test('fallback path: a pool median replaces the default weight of its size; growth below 0.75 replaces 0.416', () => {
  const rows = [row('S', true), row('M', false, 3)];
  // weights S 6, M 9: earned = 6 + 3 = 9; total = 15 / (1 - 0.25) = 20; 9 / 20 = 45 %
  assert.equal(fallback({ rows, pool: { medians: { S: 6 }, growth: 0.25 } }).pct, 45);
  // growth 0.75 or more, or unknown, uses 0.416: total = 15 / 0.584 = 25.7; 9 / 25.7 = 35.0 % (floor 35)
  assert.equal(fallback({ rows, pool: { medians: { S: 6 }, growth: 0.75 } }).pct, 35);
  assert.equal(fallback({ rows, pool: { medians: { S: 6 }, growth: null } }).pct, 35);
});

test('the percent never falls: the held percent wins over a lower fresh one and a higher fresh one replaces it', () => {
  assert.equal(forecast({ heldPct: 80 }).pct, 80);
  assert.equal(forecast({ heldPct: 50 }).pct, 66);
  assert.equal(fallback({ heldPct: 90, rows: [row('S', false), row('S', false)] }).pct, 90);
});

test('99 until every row is done, 100 only then', () => {
  const nearly = forecast({ workedMin: 1000, p50LeftMin: 0 }); // 100 % by the formula
  assert.equal(nearly.pct, 99);
  assert.equal(forecast({ heldPct: 100 }).pct, 99);
  const done = forecast({ rows: [row('S', true), row('M', true)], p50LeftMin: null, committedLeftMin: null });
  assert.deepEqual(done, { pct: 100, approx: false, rowsDone: 2, rowsTotal: 2, leftMin: 0, tag: null });
});

test('no rows: 0 percent of 0 rows', () => {
  assert.deepEqual(fallback({ rows: [] }), { pct: 0, approx: true, rowsDone: 0, rowsTotal: 0, leftMin: null, tag: null });
});

test('the tag: overdue when the committed time is used up, else +rows, else moved; none when all is done', () => {
  assert.equal(forecast({ moved: true }).tag, 'moved');
  assert.equal(forecast({ moved: true, rowsAdded: true }).tag, '+rows');
  assert.equal(forecast({ moved: true, rowsAdded: true, committedLeftMin: 0 }).tag, 'overdue');
  assert.equal(forecast({ committedLeftMin: -5 }).tag, 'overdue');
  assert.equal(forecast({ committedLeftMin: 1 }).tag, null);
  assert.equal(forecast({ rows: [row('S', true)], moved: true, committedLeftMin: -5 }).tag, null);
});

test('classMedians: a size has a median only from 5 finished rows (nearest rank, like the forecast)', () => {
  assert.deepEqual(classMedians({ S: [20, 40, 60, 80, 100], M: [10, 20, 30, 40], L: [] }), { S: 60 });
  assert.deepEqual(classMedians({ S: [], M: [], L: [] }), {});
});
