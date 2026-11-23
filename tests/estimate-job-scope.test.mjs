// Tests of the job's scope (estimate-spec R15, job-rows.mjs jobScope, through estimateFile): the PC case, where 26 of 27 rows
// belonged to another session's road that nobody had started since the last hand-over. That road stays out of the job total and
// the promise and is named once (`Queued: road <id>: <n> rows, not started`); it joins when one of its rows starts; a parked road
// stays out without a Queued line. Synthetic tables and transcripts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { jobScope } from '../home/tools/estimate/lib/job-rows.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { SESSION, iso, row, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HAND_OVER = row({ id: 'deliver:1', item: 'report', raw: { done: iso(0.2) }, evidence: '-' });
const DONE_BEFORE = row({ id: 'D0', startedH: 0, doneH: 0.1 });
const MINE = row({ id: 'A1', startedH: 0.5 });
/** Another session's road `pc`: 3 steps, 26 rows, none started (`started` per lane id, hours). */
function pcRoad({ started = {}, evidence = 'abc1234' } = {}) {
  const ids = [1, 2, 3].flatMap((step) => [...Array.from({ length: step === 3 ? 5 : 9 }, (_, k) => `pc.s${step}.lane${k + 1}`), `pc.s${step}.check`]);
  return ids.map((id) => row({ id, startedH: started[id], evidence }));
}

/** estimateFile of a table; recorded in a temp store, real clock when `cli` (the promise), else at 1 h. */
function estimate(rows, { cli = false } = {}) {
  const root = realpathSync(makeTempDir('estimate-scope-'));
  const statusPath = join(root, 'STATUS.md');
  const seedRunsFile = join(root, 'seed-runs.json');
  const seedFile = join(root, 'seed.json');
  writeFileSync(statusPath, statusDoc(rows));
  writeFileSync(seedRunsFile, JSON.stringify({ v: 2, rows: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].flatMap((runMin, k) => ['task', 'lane'].map((kind) => ({ t: 't1', k: kind, runMin, doneMin: k }))) }));
  writeSeed(seedFile, seedRows('S', 5, 30));
  writeTranscript(join(root, 'projects'), SESSION, 0, 1);
  const options = { stateDir: join(root, 'state'), projectsDir: join(root, 'projects'), sessionId: SESSION, record: true, seedFile, seedRunsFile, account: undefined, limitsDir: join(root, 'limits'), env: { HOME: root } };
  return estimateFile(statusPath, cli ? { ...options, cli: true } : { ...options, now: iso(1) }).result;
}

test('R15: one open row of this session and another session\'s 26-row road not started since the hand-over: the job is the one row', () => {
  const result = estimate([DONE_BEFORE, HAND_OVER, MINE, ...pcRoad()]);
  assert.equal(result.state, 'finish');
  assert.deepEqual([result.numbers.rowsTotal, result.numbers.rows.map((each) => each.id)], [1, ['A1']]);
  assert.deepEqual(result.queued, [{ road: 'pc', rows: 26 }]);
  assert.equal(result.road, undefined, 'no road of the job, so no step line');
  assert.ok(formatEstimate(result, { timeZone: 'UTC' }).split('\n').includes('Queued: road pc: 26 rows, not started'));
});

test('R15: the queued road is not in the promise', () => {
  const result = estimate([DONE_BEFORE, HAND_OVER, MINE, ...pcRoad()], { cli: true });
  assert.deepEqual(result.promise.rows.map((each) => each.id), ['A1']);
});

test('R15: once one of its rows starts after the hand-over the road joins the job, with its step', () => {
  const result = estimate([DONE_BEFORE, HAND_OVER, MINE, ...pcRoad({ started: { 'pc.s1.lane1': 0.6 } })]);
  assert.deepEqual(result.queued, []);
  assert.equal(result.numbers.rowsTotal, 27);
  assert.deepEqual([result.road.name, result.road.step, result.numbers.v2.step.lanesTotal], ['pc', 1, 9]);
  assert.ok(!formatEstimate(result, { timeZone: 'UTC' }).includes('Queued:'));
});

test('R15: a road started only before the last hand-over stays queued; a parked road stays out without a Queued line', () => {
  const before = estimate([row({ id: 'pc.s1.lane1', startedH: 0 }), HAND_OVER, MINE, ...pcRoad().slice(1)]);
  assert.deepEqual(before.queued, [{ road: 'pc', rows: 26 }]);
  const parked = estimate([DONE_BEFORE, HAND_OVER, MINE, ...pcRoad({ evidence: 'parked: web later' })]);
  assert.deepEqual([parked.queued, parked.numbers.rowsTotal], [[], 1]);
  assert.ok(!formatEstimate(parked, { timeZone: 'UTC' }).includes('Queued:'));
});

test('jobScope: with no hand-over any started road row joins; done non-road rows before the hand-over are out', () => {
  const items = [
    { id: 'D0', kind: 'build', started: 0, done: 10, evidence: 'x' },
    { id: 'deliver:1', kind: 'deliver', started: null, done: 20, evidence: '-' },
    { id: 'A1', kind: 'build', started: 30, done: null, evidence: 'x' },
    { id: 'rd.s1.a', kind: 'build', started: 5, done: null, evidence: 'x' },
  ];
  assert.deepEqual(jobScope(items, 20).items.map((item) => item.id), ['A1']);
  assert.deepEqual(jobScope(items, 20).queued, [{ road: 'rd', rows: 1 }]);
  assert.deepEqual(jobScope(items, null).items.map((item) => item.id), ['D0', 'A1', 'rd.s1.a']);
});
