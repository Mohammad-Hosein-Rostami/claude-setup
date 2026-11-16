// Tests for home/tools/estimate/lib/forecast.mjs: the reference pool (windows, seed rows, growth), the seeded runs with the
// conditional draw, and the refusal reasons. The two synthetic cases are those of the estimator design 8.3; no private data is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastWork, nearestRank, referencePool, refusalOf } from '../home/tools/estimate/lib/forecast.mjs';

const doneAt = (k) => new Date(Date.UTC(2026, 10, 1) + k * 60_000).toISOString();
const rowsOf = (size, costs, from = 0) => costs.map((cost, k) => ({ size, kind: 'build', done: doneAt(from + k), cost }));
const poolOf = (costs, growth = 0, longestJobMin = 1e9) => ({ costs, growth, longestJobMin, rowCount: 0, jobCount: 0 });
const FIVE = [10, 20, 30, 40, 50];

test('nearestRank takes the value at rank ceil(share x n)', () => {
  const values = Array.from({ length: 20 }, (_, k) => k + 1);
  assert.equal(nearestRank(values, 0.85), 17);
  assert.equal(nearestRank(values, 0.5), 10);
  assert.equal(nearestRank([7], 0.95), 7);
});

test('referencePool joins every table and the seed rows whose table has no file; rows without a cost are left out', () => {
  const tables = [
    { id: 'a'.repeat(32), rows: [...rowsOf('S', [5, 0, 7]), ...rowsOf('M', [30])], jobs: [] },
    { id: 'b'.repeat(32), rows: rowsOf('S', [9]), jobs: [] },
  ];
  const seed = { rows: [{ table: 'b'.repeat(32), ...rowsOf('S', [100])[0] }, { table: 'c'.repeat(32), ...rowsOf('L', [200])[0] }], jobs: [] };
  const pool = referencePool(tables, seed);
  assert.deepEqual(pool.costs, { S: [5, 7, 9], M: [30], L: [200] });
  assert.equal(pool.rowCount, 5);
});

test('referencePool counts a seed row or job once when a live table under another path id holds it (the PC has other paths)', () => {
  const job = (k, minutes) => ({ at: doneAt(k), minutes, growthNum: 0, growthDen: 1 });
  // The same STATUS.md on another machine: its table id differs from the seed's, its rows keep their done times; costs differ
  // because that machine measures its own transcripts.
  const live = [{ id: 'a'.repeat(32), rows: rowsOf('S', [6, 8]), jobs: [job(5, 40)] }];
  const fromMac = (entry) => ({ table: 'f'.repeat(32), ...entry });
  const seed = { rows: [...rowsOf('S', [5, 7, 9]).map(fromMac), ...rowsOf('M', [30]).map(fromMac)], jobs: [job(5, 50), job(9, 70)].map(fromMac) };
  const pool = referencePool(live, seed);
  assert.deepEqual(pool.costs, { S: [6, 8, 9], M: [30], L: [] }); // seed S rows done at minutes 0 and 1 are the live rows
  assert.equal(pool.jobCount, 2);
  assert.equal(pool.longestJobMin, 70);
});

test('referencePool keeps the 200 most recent rows of a size', () => {
  const old = rowsOf('M', Array(10).fill(1), 0);
  const recent = rowsOf('M', Array(200).fill(2), 100);
  const pool = referencePool([{ id: 'a'.repeat(32), rows: [...recent, ...old], jobs: [] }], { rows: [], jobs: [] });
  assert.equal(pool.costs.M.length, 200);
  assert.ok(pool.costs.M.every((cost) => cost === 2));
});

test('referencePool growth is a ratio of sums over the most recent jobs until they hold 20 hours of work', () => {
  const jobs = [
    { at: doneAt(1), minutes: 50, growthNum: 50, growthDen: 50 },
    { at: doneAt(3), minutes: 1000, growthNum: 100, growthDen: 1000 },
    { at: doneAt(2), minutes: 300, growthNum: 300, growthDen: 600 },
  ];
  const pool = referencePool([{ id: 'a'.repeat(32), rows: [], jobs }], { rows: [], jobs: [] });
  assert.equal(pool.growth, 400 / 1600); // the newest (1000 min) and the next (300 min) reach 1200; the oldest is left out
  assert.equal(pool.longestJobMin, 1000);
  assert.equal(pool.jobCount, 3);
  assert.equal(referencePool([], { rows: [], jobs: [] }).growth, 0);
});

test('forecastWork: a row that has run 90 minutes in a class of 60, 120 and 180 needs only 30 or 90 more', () => {
  const pool = poolOf({ S: [], M: [60, 60, 60, 120, 120, 180], L: [] });
  const work = forecastWork([{ id: 'r1', size: 'M', elapsed: 90 }], pool, 'table|r1');
  assert.deepEqual([work.p50, work.p85, work.p95], [30, 90, 90]);
  assert.deepEqual(work.stale, []);
});

test('forecastWork: a row past every finished row of its size is stale and draws from the whole class', () => {
  const pool = poolOf({ S: [], M: [60, 60, 60, 120, 120, 180], L: [] });
  const work = forecastWork([{ id: 'r1', size: 'M', elapsed: 200 }], pool, 'table|r1');
  assert.deepEqual(work.stale, ['r1']);
  assert.ok([60, 120, 180].includes(work.p50) && [60, 120, 180].includes(work.p95));
});

test('forecastWork: 400 simulated jobs forecast at the start with no growth are within p85 80-90 % of the time', () => {
  const costList = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 34, 38, 43, 49, 55, 62, 70, 80, 90, 105, 120, 140, 170, 220];
  let state = 12345;
  const nextRandom = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32); // the test's own draws, apart from the tool's
  const pool = poolOf({ S: costList, M: costList, L: costList });
  let within = 0;
  for (let job = 0; job < 400; job += 1) {
    const rowCount = 3 + Math.floor(nextRandom() * 13);
    const rows = Array.from({ length: rowCount }, (_, k) => ({ id: `j${job}r${k}`, size: 'S', elapsed: 0 }));
    const actual = rows.reduce((sum) => sum + costList[Math.floor(nextRandom() * costList.length)], 0);
    if (actual <= forecastWork(rows, pool, `job-${job}`).p85) within += 1;
  }
  assert.ok(within >= 320 && within <= 360, `within p85: ${within} of 400`);
});

test('forecastWork gives the same numbers for the same seed text and divides by (1 - growth)', () => {
  const rows = [{ id: 'a', size: 'S', elapsed: 0 }, { id: 'b', size: 'S', elapsed: 15 }];
  const plain = forecastWork(rows, poolOf({ S: FIVE, M: FIVE, L: FIVE }), 't|a,b');
  assert.deepEqual(forecastWork(rows, poolOf({ S: FIVE, M: FIVE, L: FIVE }), 't|a,b'), plain);
  const grown = forecastWork(rows, poolOf({ S: FIVE, M: FIVE, L: FIVE }, 0.5), 't|a,b');
  assert.deepEqual([grown.p50, grown.p85, grown.p95], [plain.p50 * 2, plain.p85 * 2, plain.p95 * 2]);
});

test('forecastWork gives no forecast when a size has fewer than 5 pool rows or growth is at the limit', () => {
  assert.equal(forecastWork([{ id: 'a', size: 'L', elapsed: 0 }], poolOf({ S: FIVE, M: FIVE, L: [1, 2, 3, 4] }), 's'), null);
  assert.equal(forecastWork([{ id: 'a', size: 'S', elapsed: 0 }], poolOf({ S: FIVE, M: FIVE, L: FIVE }, 0.75), 's'), null);
});

test('refusalOf: no-reference first, then growth, then horizon; null when a time can be given', () => {
  const rowsL = [{ id: 'a', size: 'S', elapsed: 0 }, { id: 'b', size: 'L', elapsed: 0 }];
  assert.deepEqual(refusalOf(rowsL, poolOf({ S: FIVE, M: [], L: [1, 2, 3, 4] }, 0.9), null), { reason: 'no-reference', size: 'L', rows: 4, needed: 5 });
  const rowsS = [{ id: 'a', size: 'S', elapsed: 0 }];
  assert.deepEqual(refusalOf(rowsS, poolOf({ S: FIVE, M: [], L: [] }, 0.75), null), { reason: 'growth', growth: 0.75 });
  const work = { p50: 201, p85: 250, p95: 300, stale: [] };
  assert.deepEqual(refusalOf(rowsS, poolOf({ S: FIVE, M: [], L: [] }, 0.4, 100), work), { reason: 'horizon', longestJobMin: 100, work });
  assert.equal(refusalOf(rowsS, poolOf({ S: FIVE, M: [], L: [] }, 0.4, 100), { ...work, p50: 200 }), null);
});
