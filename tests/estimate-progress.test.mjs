// Tests for the job progress percent (home/tools/estimate/lib/progress.mjs): the forecast path, the fallback path for refusals, the hold
// that never lets a job's percent fall, the 99 cap, the tags. The numbers are worked out by hand from the lane P spec (step 1), not
// copied from the code's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { classMedians, progressOf } from '../home/tools/estimate/lib/progress.mjs';
import { formatEstimate, formatRefusal } from '../home/tools/estimate/lib/report.mjs';
import { errorSegment, resultSegment } from '../home/tools/estimate/lib/segment-text.mjs';
import { tableId } from '../home/tools/estimate/lib/table-store.mjs';
import { BASE_MS, HOUR_MS, SESSION, iso, row as tableRow, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

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

const S_COSTS = [20, 40, 60, 80, 100];
const OPEN_DOC = statusDoc([tableRow({ id: 'D1', startedH: 0, doneH: 0.5 }), tableRow({ id: 'O1', startedH: 0.5 })]);

/** A table, a transcript active from 0 to 1 h, a seed (5 S rows, 5 M rows unless given) and an empty store; run(hours, doc?) estimates it. */
async function setup(doc = OPEN_DOC, seed = [...S_COSTS.flatMap((cost) => seedRows('S', 1, cost)), ...seedRows('M', 5, 90)]) {
  const root = makeTempDir('estimate-progress-');
  const statusPath = join(root, 'STATUS.md');
  const projectsDir = join(root, 'projects');
  const stateDir = join(root, 'state');
  const seedFile = join(root, 'seed.json');
  await writeFile(statusPath, doc);
  writeTranscript(projectsDir, SESSION, 0, 1);
  writeSeed(seedFile, seed);
  const options = { stateDir, projectsDir, sessionId: SESSION, record: true, seedFile };
  const run = async (hours, nextDoc, extra = {}) => {
    if (nextDoc !== undefined) await writeFile(statusPath, nextDoc);
    return estimateFile(statusPath, { ...options, ...extra, now: iso(hours) });
  };
  const stored = () => JSON.parse(readFileSync(join(stateDir, 'table', `${tableId(statusPath)}.json`), 'utf8'));
  return { run, stored };
}

test('estimateFile, finish state: the percent is worked / (worked + median left) of the job, with the rows done', async () => {
  const { run } = await setup();
  const { result } = await run(1);
  assert.equal(result.state, 'finish');
  // the job began at 0 h and worked the whole hour: 60 minutes
  assert.deepEqual(result.progress, { pct: Math.floor((100 * 60) / (60 + result.work.p50)), approx: false, rowsDone: 1, rowsTotal: 2, leftMin: result.work.p50, tag: null });
});

test('estimateFile, refusal: the weights path with its flag; pool medians S 40 (6 rows) and the default M 9', async () => {
  const doc = statusDoc([tableRow({ id: 'D1', startedH: 0, doneH: 0.5 }), tableRow({ id: 'O1', size: 'M', startedH: 0.5 }), tableRow({ id: 'O2', size: 'M' })]);
  const { run } = await setup(doc, S_COSTS.flatMap((cost) => seedRows('S', 1, cost)));
  const { result } = await run(1);
  assert.equal(result.state, 'refused');
  assert.equal(result.refusal.reason, 'no-reference');
  // pool S costs 20 30 40 60 80 100 (D1 cost 30) -> median 40; earned = 40 + min(8.1, 30 min elapsed of O1); total = 40 + 9 + 9 = 58
  assert.deepEqual(result.progress, { pct: 82, approx: true, rowsDone: 1, rowsTotal: 3, leftMin: null, tag: null });
});

test('no row at all and a handed-over job show no progress; all rows done shows 100', async () => {
  const none = await setup(statusDoc([]));
  assert.equal((await none.run(1)).result.progress ?? null, null);
  const done = [tableRow({ id: 'D1', startedH: 0, doneH: 0.5 }), tableRow({ id: 'O1', startedH: 0.5, doneH: 0.9 })];
  const closed = await setup(statusDoc(done));
  assert.deepEqual((await closed.run(1)).result.progress, { pct: 100, approx: false, rowsDone: 2, rowsTotal: 2, leftMin: 0, tag: null });
  const handed = await setup(statusDoc([...done, tableRow({ id: 'deliver:1', item: 'report', raw: { done: iso(0.95) }, evidence: '-' })]));
  const { result } = await handed.run(1);
  assert.equal(result.state, 'handed-over');
  assert.equal(result.progress ?? null, null);
});

test('the percent is held per job: rows added cannot lower it, a next job starts again, a run that records nothing reads the hold', async () => {
  const { run, stored } = await setup();
  const first = (await run(1)).result.progress;
  const added = statusDoc([tableRow({ id: 'D1', startedH: 0, doneH: 0.5 }), tableRow({ id: 'O1', startedH: 0.5 }), ...['O2', 'O3', 'O4', 'O5', 'O6', 'O7'].map((id) => tableRow({ id }))]);
  const second = (await run(1, added)).result;
  assert.equal(second.progress.pct, first.pct, 'the fresh percent is lower (more work left), the held one is shown');
  assert.equal(second.progress.tag, '+rows');
  assert.deepEqual(stored().held, { start: new Date(BASE_MS).toISOString(), pct: first.pct });
  assert.equal((await run(1, undefined, { record: false })).result.progress.pct, first.pct);
  const nextJob = statusDoc([
    tableRow({ id: 'D1', startedH: 0, doneH: 0.5 }), tableRow({ id: 'O1', startedH: 0.5, doneH: 0.9 }),
    tableRow({ id: 'deliver:1', item: 'report', raw: { done: iso(0.95) }, evidence: '-' }), tableRow({ id: 'N1', startedH: 1.5 }),
  ]);
  const third = (await run(1.6, nextJob)).result;
  assert.equal(third.progress.pct, 0, 'the new job worked nothing yet; the old job\'s percent does not carry over');
  assert.equal(stored().held.start, new Date(BASE_MS + 1.5 * HOUR_MS).toISOString());
});

const PROGRESS = { pct: 54, approx: false, rowsDone: 5, rowsTotal: 9, leftMin: 30, tag: null };
const FINISH = {
  state: 'finish', nowMs: BASE_MS, finish: { clockMs: BASE_MS + HOUR_MS, likelyMs: BASE_MS + HOUR_MS, lateMs: BASE_MS + 2 * HOUR_MS, ahead: false },
  commit: { atMs: BASE_MS, budgetMin: 60, leftMin: 60, pausedMin: 0, moved: null }, covers: { open: 4, running: 1, sizes: { S: 4, M: 0, L: 0 }, growth: 0.2 },
  work: { p50: 30, p85: 60, p95: 90 }, record: null, pool: { rows: 10, jobs: 2 }, checks: [],
};

test('the Finish block and a refusal print one Progress line (after the track record, before the Check lines)', () => {
  const block = formatEstimate({ ...FINISH, progress: PROGRESS, checks: [{ kind: 'untracked', minutes: 45 }] }, { timeZone: 'UTC' }).split('\n');
  assert.equal(block[5], 'Progress: 54% (5 of 9 rows; median left 30 min; clock at 85%)');
  assert.match(block[6], /^Check: /);
  assert.equal(formatEstimate({ ...FINISH, progress: { ...PROGRESS, rowsDone: 0, rowsTotal: 1 } }, { timeZone: 'UTC' }).includes('(0 of 1 row;'), true);
  assert.equal(formatEstimate(FINISH, { timeZone: 'UTC' }).includes('Progress:'), false, 'a result with no progress prints none');
  const refused = { state: 'refused', refusal: { reason: 'growth', growth: 0.8 }, checks: [], progress: { pct: 31, approx: true, rowsDone: 2, rowsTotal: 4, leftMin: null, tag: null } };
  assert.equal(formatRefusal(refused).split('\n').at(-1), 'Progress: ~31% (2 of 4 rows; time n/a: too much unlisted work)');
  assert.equal(formatRefusal({ ...refused, progress: null }).includes('Progress:'), false);
});

test('the status-line segment carries the result\'s progress; an error carries none', () => {
  assert.deepEqual(resultSegment({ ...FINISH, progress: PROGRESS }, 'UTC').progress, PROGRESS);
  assert.equal(resultSegment(FINISH, 'UTC').progress, null);
  assert.equal(errorSegment(new Error('x')).progress, null);
});
