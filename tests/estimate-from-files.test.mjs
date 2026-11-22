// Tests for estimateFile (home/tools/estimate/lib/from-files.mjs), the one function behind the CLI and the status line: states,
// the committed time across a pause, a move with its stored cause, the hand-over, what is recorded, the capped log that keeps every
// first and scored entry (also with two runs at once), the job's pace, and the status line numbers (late, per-row left, byte size).
// Synthetic tables, transcripts and seeds only; the clock is always passed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { UsageError, estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { MAX_CACHE_BYTES } from '../home/tools/estimate/lib/segment-cache.mjs';
import { resultSegment } from '../home/tools/estimate/lib/segment-text.mjs';
import { tableId, updateTable } from '../home/tools/estimate/lib/table-store.mjs';
import { MIN_MS, SESSION, iso, row, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const S_COSTS = [20, 40, 60, 80, 100];
const OPEN_DOC = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]);

/** A table, a transcript active from 0 to 1 h, a seed of S and M rows and an empty store; run(now, doc?) estimates it. */
async function setup(doc = OPEN_DOC, seed = [...S_COSTS.flatMap((cost) => seedRows('S', 1, cost)), ...seedRows('M', 5, 90)]) {
  const root = makeTempDir('estimate-file-');
  const statusPath = join(root, 'STATUS.md');
  const projectsDir = join(root, 'projects');
  const stateDir = join(root, 'state');
  const seedFile = join(root, 'seed.json');
  await writeFile(statusPath, doc);
  writeTranscript(projectsDir, SESSION, 0, 1);
  writeSeed(seedFile, seed);
  const options = { stateDir, projectsDir, sessionId: SESSION, record: true, seedFile };
  const run = async (hours, nextDoc) => {
    if (nextDoc !== undefined) await writeFile(statusPath, nextDoc);
    return estimateFile(statusPath, { ...options, now: iso(hours) });
  };
  const stored = () => JSON.parse(readFileSync(join(stateDir, 'table', `${tableId(statusPath)}.json`), 'utf8'));
  return { root, statusPath, stateDir, projectsDir, seedFile, run, stored };
}

test('now moved over a silence changes no work number and moves the shown clock by the silence, on the 5-minute grid', async () => {
  const { run } = await setup();
  const before = (await run(1)).result;
  const after = (await run(3)).result; // no activity from 1 h to 3 h
  assert.equal(before.state, 'finish');
  assert.deepEqual(after.work, before.work);
  assert.equal(after.commit.leftMin, before.commit.leftMin);
  assert.equal(after.finish.clockMs - before.finish.clockMs, 120 * MIN_MS);
  assert.equal(after.commit.pausedMin, 120);
  const clock = (result) => formatEstimate(result, { timeZone: 'UTC' }).split('\n')[0].match(/\d\d:\d\d/)[0];
  const [h1, m1] = clock(before).split(':').map(Number);
  const [h2, m2] = clock(after).split(':').map(Number);
  assert.equal((h2 * 60 + m2) - (h1 * 60 + m1), 120);
  assert.equal(m1 % 5, 0);
});

test('while work runs the committed clock holds; the first run commits the median of the fresh forecast', async () => {
  const { run, stored } = await setup();
  const first = (await run(1)).result;
  assert.equal(first.commit.budgetMin, first.work.p50);
  assert.equal(first.commit.leftMin, first.work.p50);
  assert.equal(stored().log.length, 1);
  assert.equal(stored().log[0].first, true);
  const again = (await run(1)).result;
  assert.equal(again.finish.clockMs, first.finish.clockMs);
  assert.equal(stored().log.length, 1, 'a hold logs nothing');
});

test('15 minutes of work after the commitment: the budget is held when the fresh median is within the hold band of it, else it moves to the fresh median', async () => {
  const { run, projectsDir } = await setup();
  const first = (await run(1)).result;
  writeTranscript(projectsDir, SESSION, 1, 1.25);
  const later = (await run(1.25)).result;
  const left = first.commit.leftMin - 15;
  const held = Math.abs(left - later.work.p50) <= Math.max(15, 0.25 * Math.max(left, later.work.p50));
  assert.equal(later.commit.leftMin, held ? first.commit.leftMin - 15 : later.work.p50);
  if (held) assert.equal(later.finish.clockMs, first.finish.clockMs);
  assert.equal(later.commit.pausedMin, 0);
});

test('a moved commitment prints its stored cause, and a later run prints the same cause', async () => {
  const { run, stored } = await setup();
  await run(1);
  const added = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...['O2', 'O3', 'O4', 'O5', 'O6', 'O7'].map((id) => row({ id }))]);
  const moved = (await run(1, added)).result;
  assert.equal(moved.commit.moved.cause, 'rows-added');
  assert.deepEqual(moved.commit.moved.ids, ['O2', 'O3', 'O4', 'O5', 'O6', 'O7']);
  assert.ok(moved.finish.clockMs > moved.commit.moved.wasClockMs, 'a move is always later');
  const later = formatEstimate((await run(1.05)).result, { timeZone: 'UTC' }).split('\n').find((line) => line.startsWith('Moved:'));
  assert.match(later, /^Moved: at 01:00 from \d\d:\d\d, /);
  assert.match(later, /, because 6 rows were added \(O2, O3, O4, O5, O6 and 1 more\); unchanged since\.$/);
  assert.equal(stored().log.filter((entry) => entry.first === false).length, 1);
});

test('the hand-over: no open row and a deliver row after every done row is handed over, clears the commitment and scores it', async () => {
  const { run, stored, projectsDir } = await setup();
  await run(1);
  writeTranscript(projectsDir, SESSION, 1, 2);
  const doc = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5, doneH: 1.5 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(1.6) }, evidence: '-' })]);
  const { result } = await run(1.7, doc);
  assert.equal(result.state, 'handed-over');
  assert.equal(result.rows, 2);
  assert.equal(result.workedMin, 90); // D1 30 minutes, O1 60
  assert.equal(stored().commit, null);
  const [entry] = stored().log;
  assert.equal(entry.scored.actualMin, 36); // worked from the commitment at 1:00 to the hand-over at 1:36
  assert.equal(entry.scored.met, 36 <= entry.p85);
});

test('all done without a hand-over says so; the commitment is kept for the hand-over', async () => {
  const { run, stored } = await setup();
  await run(1);
  const { result } = await run(1, statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5, doneH: 1 })]));
  assert.deepEqual(result, { state: 'all-done', nowMs: Date.parse(iso(1)), rows: 2, progress: { pct: 100, approx: false, rowsDone: 2, rowsTotal: 2, leftMin: 0, tag: null }, checks: [] });
  assert.notEqual(stored().commit, null);
});

test('refusals: no work row, too few rows of a size (no time, the commitment left alone), each logged once', async () => {
  const { run, stored } = await setup();
  await run(1);
  const withL = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), row({ id: 'B1', size: 'L' })]);
  const refused = (await run(1, withL)).result;
  assert.deepEqual(refused.refusal, { reason: 'no-reference', size: 'L', rows: 0, needed: 5 });
  assert.equal(refused.finish, undefined);
  await run(1);
  assert.notEqual(stored().commit, null);
  assert.equal(stored().log.filter((entry) => entry.refusal === 'no-reference').length, 1);
  assert.equal((await run(1, statusDoc([]))).result.refusal.reason, 'no-rows');
});

test('a table problem throws a UsageError carrying the problems; a bad now is a UsageError', async () => {
  const { run, statusPath } = await setup();
  await assert.rejects(run(1, statusDoc([row({ id: 'M1', doneH: 0.5 })])), (error) => error instanceof UsageError && error.problems[0].id === 'M1');
  await assert.rejects(run(0.2, OPEN_DOC), (error) => error instanceof UsageError && /later than now/.test(error.message)); // D1 is done at 0:30
  assert.throws(() => estimateFile(statusPath, { now: '2026-02-30T08:00Z' }), UsageError);
});

test('without a store nothing is read or written; with one the rows are stored for other tables and no session is linked', async () => {
  const { root, statusPath, projectsDir, seedFile, stateDir, run, stored } = await setup();
  const { result, inputs } = estimateFile(statusPath, { now: iso(1), stateDir: null, projectsDir, sessionId: SESSION, seedFile });
  assert.equal(result.state, 'finish');
  assert.deepEqual([inputs.recorded, inputs.busy], [false, false]);
  assert.equal(existsSync(join(root, 'state')), false);
  const recorded = await run(1);
  assert.deepEqual([recorded.inputs.recorded, recorded.inputs.sessions], [true, 1]);
  assert.deepEqual(stored().rows.map((stored) => [stored.size, stored.cost]), [['S', 30]]);
  assert.deepEqual(Object.keys(stored().added).sort(), ['D1', 'O1'], 'first-seen times are still recorded');
  // Only status.mjs edits link a session (audit option a): an estimate or a status-line refresh must not make a session's
  // transcripts count for this table for good, nor point its Stop hook at this table.
  assert.deepEqual(stored().sessions, []);
  assert.equal(existsSync(join(stateDir, 'session', `${SESSION}.json`)), false);
});

test('while no row of the job has started, a run replaces the first commitment in place: no move, still one first entry', async () => {
  const unstarted = (ids) => statusDoc(ids.map((id) => row({ id })));
  const { run, stored } = await setup(unstarted(['O1']));
  await run(1);
  const listed = (await run(1.05, unstarted(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7']))).result;
  assert.equal(listed.commit.moved, null);
  assert.equal(listed.commit.budgetMin, listed.work.p50);
  assert.deepEqual(stored().log.map((entry) => [entry.first, entry.ids.length]), [[true, 7]]);
  assert.doesNotMatch(formatEstimate(listed, { timeZone: 'UTC' }), /Moved/);
  const more = ['O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9', 'O10', 'O11', 'O12', 'O13'].map((id) => row({ id }));
  const moved = (await run(1.1, statusDoc([row({ id: 'O1', startedH: 1.05 }), ...more]))).result;
  assert.equal(moved.commit.moved?.cause, 'rows-added', 'once a row has started the hold/move rule applies again');
  assert.deepEqual(stored().log.map((entry) => entry.first), [true, false]);
});

test('a commitment made in the same minute as the last hand-over belongs to the new job: logged as first once', async () => {
  const handedOver = [row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(1) }, evidence: '-' })];
  const { run, stored } = await setup(statusDoc([...handedOver, row({ id: 'O1', startedH: 1 })]));
  await run(1);
  await run(1);
  assert.deepEqual(stored().log.map((entry) => entry.first), [true]);
});

test('a commitment of the old job made in the hand-over\'s minute stays the old job\'s: the next job gets its own first entry', async () => {
  const { run, stored } = await setup(statusDoc([row({ id: 'O1', startedH: 0.5 })]));
  await run(1); // commits at 1:00 for O1
  const handedOver = [row({ id: 'O1', startedH: 0.5, doneH: 1 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(1) }, evidence: '-' })];
  await run(1.05, statusDoc([...handedOver, row({ id: 'O2' })]));
  assert.deepEqual(stored().log.map((entry) => [entry.first, entry.ids]), [[true, ['O1']], [true, ['O2']]]);
});

test('rows done before the last hand-over do not count as a started job: listing the next job\'s rows still replaces its first commitment', async () => {
  const handedOver = [row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(0.6) }, evidence: '-' })];
  const listed = (ids) => statusDoc([...handedOver, ...ids.map((id) => row({ id }))]);
  const { run, stored } = await setup(listed(['O1']));
  await run(1);
  const more = (await run(1.05, listed(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8']))).result;
  assert.equal(more.commit.moved, null);
  assert.deepEqual(stored().log.map((entry) => [entry.first, entry.ids.length]), [[true, 8]]);
});

const FROM_FILES_URL = new URL('../home/tools/estimate/lib/from-files.mjs', import.meta.url).href;
const runChild = promisify(execFile);
const MOVES = 250;
/** 250 logged entries before now: moves, every 10th scored, the first 5 scored first commitments of the old model c2b. */
const pastLog = () => Array.from({ length: MOVES }, (_, k) => ({
  at: new Date(Date.parse(iso(-10)) + k * MIN_MS).toISOString(), ids: ['gone'], p50: 10, raw85: 20, p85: 20, p95: 30, g: 0, kappa: 1,
  first: k < 5, cause: k < 5 ? null : 'pace', model: k < 5 ? 'c2b' : 'c3',
  ...(k % 10 === 0 ? { scored: { at: iso(-1), actualMin: 15, met: true, ratio: 0.75, ratio50: 1.5 } } : {}),
}));
const keptForGood = (log) => log.filter((entry) => entry.first === true || entry.scored !== undefined).map((entry) => entry.at);

test('the capped log: 250 moves then a first commitment keeps that first entry, every scored and every old first entry', async () => {
  const { statusPath, stateDir, run, stored } = await setup();
  const before = pastLog();
  updateTable(stateDir, statusPath, (table) => ({ ...table, log: before }));
  await run(1);
  const { log } = stored();
  assert.equal(log.at(-1).first, true);
  assert.equal(log.at(-1).model, 'c3');
  const kept = new Set(log.map((entry) => entry.at));
  assert.deepEqual(keptForGood(before).filter((at) => !kept.has(at)), [], 'no first or scored entry was dropped');
  assert.equal(log.length, 200 + keptForGood(before.slice(0, MOVES + 1 - 200)).length, 'the newest 200 plus the older kept ones');
  assert.equal(kept.has(before[6].at), false, 'an old unscored move still leaves');
});

test('two refreshes at once: under the table lock no first or scored entry is lost and one first commitment is added', async () => {
  const { statusPath, stateDir, projectsDir, seedFile, stored } = await setup();
  const before = pastLog();
  updateTable(stateDir, statusPath, (table) => ({ ...table, log: before }));
  const startAt = Date.now() + 300;
  const script = `
    import { estimateFile } from ${JSON.stringify(FROM_FILES_URL)};
    while (Date.now() < ${startAt});
    const [statusPath, stateDir, projectsDir, seedFile, sessionId, now] = process.argv.slice(1);
    const { inputs } = estimateFile(statusPath, { stateDir, projectsDir, seedFile, sessionId, now, record: true });
    process.stdout.write(inputs.busy ? 'busy' : 'recorded');`;
  const args = ['--input-type=module', '-e', script, statusPath, stateDir, projectsDir, seedFile, SESSION, iso(1)];
  const runs = await Promise.all([1, 2].map(() => runChild(process.execPath, args)));
  assert.ok(runs.some((result) => result.stdout === 'recorded'));
  const { log } = stored();
  const kept = new Set(log.map((entry) => entry.at));
  assert.deepEqual(keptForGood(before).filter((at) => !kept.has(at)), []);
  assert.equal(log.filter((entry) => entry.first === true && entry.model === 'c3').length, 1);
});

test('the status line numbers: per-row median left, first budget, and late with its cause only once 10 min over the first', async () => {
  const { run } = await setup();
  const first = (await run(1)).result;
  // O1 has run 30 min; the S pool is 20, 30 (D1), 40, 60, 80, 100: it needs 10, 30, 50 or 70 more, median 30.
  assert.deepEqual(first.numbers.rows, [{ id: 'O1', expectMin: 40, leftMin: 30, startedMs: Date.parse(iso(0.5)) }]);
  assert.deepEqual([first.numbers.firstBudgetMin, first.numbers.lateMin, first.numbers.lateCause], [first.work.p50, null, null]);
  const added = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...['O2', 'O3', 'O4'].map((id) => row({ id }))]);
  const late = (await run(1, added)).result;
  assert.equal(late.commit.moved.cause, 'rows-added');
  assert.equal(late.numbers.firstBudgetMin, first.work.p50);
  assert.equal(late.numbers.lateMin, late.commit.leftMin - first.work.p50);
  assert.ok(late.numbers.lateMin >= 10);
  assert.deepEqual(late.numbers.lateCause, { cause: 'rows-added', ids: ['O2', 'O3', 'O4'], count: 3 });
});

test('the job\'s pace: 3 done rows slower than the pool scale the work left; rows done before the hand-over do not count', async () => {
  const done = [row({ id: 'D1', startedH: 0, doneH: 2 }), row({ id: 'D2', startedH: 2, doneH: 4 }), row({ id: 'D3', startedH: 4, doneH: 6 })];
  const handOver = row({ id: 'deliver:1', item: 'report', raw: { done: iso(6) }, evidence: '-' });
  const { statusPath, projectsDir, seedFile } = await setup(statusDoc([...done, row({ id: 'O1', startedH: 6 })]));
  writeTranscript(projectsDir, SESSION, 1, 6.5);
  const estimate = () => estimateFile(statusPath, { now: iso(6.5), stateDir: null, projectsDir, sessionId: SESSION, seedFile }).result;
  const paced = estimate();
  await writeFile(statusPath, statusDoc([...done, handOver, row({ id: 'O1', startedH: 6 })]));
  const plain = estimate();
  // Pool S: 20, 40, 60, 80, 100 and three of 120; middle cost 100; pace 360 / 300 = 1.2.
  for (const name of ['p50', 'p85', 'p95']) assert.ok(Math.abs(paced.work[name] - 1.2 * plain.work[name]) < 1e-9, name);
  assert.ok(Math.abs(paced.numbers.rows[0].leftMin - 1.2 * plain.numbers.rows[0].leftMin) <= 0.05);
});

test('a 300-row job with a late cause of 300 added rows stays under the cache byte cap', async () => {
  const longId = (k) => `row-with-a-rather-long-name-${String(k).padStart(4, '0')}`;
  const { run, seedFile } = await setup(statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]));
  writeSeed(seedFile, S_COSTS.flatMap((cost) => seedRows('S', 1, cost)), 100_000); // a long past job, so 300 rows are within the horizon
  await run(1);
  const many = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...Array.from({ length: 300 }, (_, k) => row({ id: longId(k) }))]);
  const { result } = await run(1, many);
  assert.equal(result.numbers.rows.length, 64);
  assert.deepEqual([result.numbers.lateCause.count, result.numbers.lateCause.ids.length], [300, 64]);
  const entry = { path: '/x'.repeat(100), ...resultSegment(result), mtimeMs: Date.now(), size: 1e6, computedAt: Date.now(), refreshStartedAt: Date.now() };
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) < MAX_CACHE_BYTES, `${Buffer.byteLength(JSON.stringify(entry))} bytes`);
});
