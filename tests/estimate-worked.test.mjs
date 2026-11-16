// Tests for home/tools/estimate/lib/worked.mjs: working intervals with the tail rule, row costs, elapsed shares, untracked minutes and
// handed-over jobs with their growth parts. Expected values are hand arithmetic on the rules of the estimator design (3.1-3.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_GAP_MIN, elapsedShares, handedOverJobs, rowCosts, workedMinutes, workingIntervals } from '../home/tools/estimate/lib/worked.mjs';

const BASE_MIN = Date.parse('2026-11-16T10:00Z') / 60_000; // every time below is minutes after this one
const at = (minute) => (BASE_MIN + minute) * 60_000;
const run = (start, end) => [BASE_MIN + start, BASE_MIN + end];
const relative = (intervals) => intervals.map(([start, end]) => [start - BASE_MIN, end - BASE_MIN]);
const row = (id, started, done, extra = {}) => ({ id, kind: 'build', size: 'S', started: started === null ? null : at(started), done: done === null ? null : at(done), ...extra });
const handOver = (id, minute) => ({ id, kind: 'deliver', size: 'S', started: at(minute), done: at(minute) });

test('workingIntervals joins silences of up to IDLE_GAP_MIN minutes and keeps longer ones apart', () => {
  assert.equal(IDLE_GAP_MIN, 10);
  const runs = [run(0, 5), run(15, 20), run(31, 35)];
  assert.deepEqual(relative(workingIntervals(runs, BASE_MIN + 100)), [[0, 20], [31, 35]]);
});

test('workingIntervals: the last interval ends at now when now is at most 10 minutes after its end (tail rule)', () => {
  const runs = [run(0, 5), run(31, 35)];
  assert.deepEqual(relative(workingIntervals(runs, BASE_MIN + 45)), [[0, 5], [31, 45]]);
  assert.deepEqual(relative(workingIntervals(runs, BASE_MIN + 46)), [[0, 5], [31, 35]]);
});

test('workingIntervals ignores activity after now and cuts a run that reaches past it', () => {
  const runs = [run(0, 5), run(8, 30), run(50, 60)];
  assert.deepEqual(relative(workingIntervals(runs, BASE_MIN + 20)), [[0, 20]]);
  assert.deepEqual(workingIntervals([], BASE_MIN), []);
});

test('workedMinutes adds the overlap of every interval with the span', () => {
  const intervals = [run(0, 20), run(31, 40)];
  assert.equal(workedMinutes(intervals, BASE_MIN + 10, BASE_MIN + 35), 14);
  assert.equal(workedMinutes(intervals, BASE_MIN + 20, BASE_MIN + 31), 0);
  assert.equal(workedMinutes(intervals, BASE_MIN + 35, BASE_MIN + 10), 0);
});

test('workedMinutes: moving now through a silence changes no work number', () => {
  const runs = [run(0, 30), run(200, 210)];
  const early = workingIntervals(runs, BASE_MIN + 60);
  const late = workingIntervals(runs, BASE_MIN + 150);
  assert.equal(workedMinutes(early, BASE_MIN, BASE_MIN + 60), workedMinutes(late, BASE_MIN, BASE_MIN + 150));
});

test('rowCosts splits each working minute among the done rows running in it; open and deliver rows take no share', () => {
  const items = [row('a', 0, 20), row('b', 10, 30), row('c', 0, null), handOver('deliver:1', 30), row('d', 40, 50)];
  const costs = rowCosts(items, [run(0, 30)]);
  assert.deepEqual([...costs.entries()], [['a', 15], ['b', 15], ['d', 0]]);
});

test('rowCosts skips a done row without a started stamp', () => {
  assert.deepEqual([...rowCosts([row('a', null, 20)], [run(0, 30)]).keys()], []);
});

test('elapsedShares gives an open row its share among all started rows; a minute with none started is untracked', () => {
  const items = [row('a', 0, 10), row('b', 0, 20), row('c', 25, null), row('later', null, null)];
  const { elapsed, untrackedMin } = elapsedShares(items, [run(0, 40)], BASE_MIN + 40);
  assert.deepEqual([...elapsed.entries()], [['c', 15], ['later', 0]]);
  assert.equal(untrackedMin, 5); // minutes 20-24
});

test('elapsedShares counts untracked minutes only since the current job started', () => {
  const items = [row('a', 0, 10), handOver('deliver:1', 10), row('c', 30, null)];
  const { elapsed, untrackedMin } = elapsedShares(items, [run(0, 50)], BASE_MIN + 50);
  assert.deepEqual([...elapsed.entries()], [['c', 20]]);
  assert.equal(untrackedMin, 0); // minutes 10-29 are before the current job's first started row
});

test('handedOverJobs: a job is the rows done after the previous hand-over up to this one; an empty hand-over is ignored', () => {
  const items = [row('a', 0, 20), handOver('deliver:1', 20), handOver('deliver:2', 21), row('c', 22, 40), row('b', 25, 40, { kind: 'close' }), handOver('deliver:3', 40)];
  const intervals = [run(0, 40)];
  const jobs = handedOverJobs(items, rowCosts(items, intervals), intervals, new Map());
  assert.deepEqual(jobs.map((job) => [job.at, job.ids, job.minutes]), [[at(20), ['a'], 20], [at(40), ['c', 'b'], 18]]);
  // job 2 starts at 22; close row b counts as added at its start (25), row c at the job start.
  // num: minutes 22, 23, 24 each add cost(b) = 7.5; den: worked minutes from m to 40 for m = 22..39 = 18 + 17 + ... + 1 = 171
  assert.equal(jobs[1].growthNum, 22.5);
  assert.equal(jobs[1].growthDen, 171);
  assert.equal(jobs[0].growthNum, 0);
  assert.equal(jobs[0].growthDen, 210); // 20 + 19 + ... + 1
});

test('handedOverJobs uses a first-seen time when it is at or before the row started, else the fallback', () => {
  const items = [row('c', 22, 40), row('b', 25, 40, { kind: 'close' }), handOver('deliver:1', 40)];
  const intervals = [run(0, 40)];
  const costs = rowCosts(items, intervals);
  const listedEarly = handedOverJobs(items, costs, intervals, new Map([['b', at(22)]]));
  assert.equal(listedEarly[0].growthNum, 0);
  const seenAfterStart = handedOverJobs(items, costs, intervals, new Map([['b', at(30)], ['c', at(30)]]));
  assert.equal(seenAfterStart[0].growthNum, 22.5);
});

test('handedOverJobs returns nothing without a deliver row', () => {
  const items = [row('a', 0, 20)];
  assert.deepEqual(handedOverJobs(items, rowCosts(items, [run(0, 30)]), [run(0, 30)], new Map()), []);
});
