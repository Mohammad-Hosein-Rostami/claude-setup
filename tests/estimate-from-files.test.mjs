// Tests for estimateFile (home/tools/estimate/lib/from-files.mjs), the one function behind the CLI and the status line: states,
// the committed time across a pause, a move with its stored cause, the hand-over, and what is recorded. Synthetic tables,
// transcripts and seeds only; the clock is always passed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError, estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { tableId } from '../home/tools/estimate/lib/table-store.mjs';
import { MIN_MS, SESSION, iso, row, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';

const S_COSTS = [20, 40, 60, 80, 100];
const OPEN_DOC = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]);

/** A table, a transcript active from 0 to 1 h, a seed of S and M rows and an empty store; run(now, doc?) estimates it. */
async function setup(doc = OPEN_DOC, seed = [...S_COSTS.flatMap((cost) => seedRows('S', 1, cost)), ...seedRows('M', 5, 90)]) {
  const root = await mkdtemp(join(tmpdir(), 'estimate-file-'));
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

test('while work runs the committed clock holds; the first run commits p85 of the fresh forecast', async () => {
  const { run, stored } = await setup();
  const first = (await run(1)).result;
  assert.equal(first.commit.budgetMin, first.work.p85);
  assert.equal(first.commit.leftMin, first.work.p85);
  assert.equal(stored().log.length, 1);
  assert.equal(stored().log[0].first, true);
  const again = (await run(1)).result;
  assert.equal(again.finish.clockMs, first.finish.clockMs);
  assert.equal(stored().log.length, 1, 'a hold logs nothing');
});

test('15 minutes of work after the commitment use 15 minutes of its budget and leave the shown clock where it was', async () => {
  const { run, projectsDir } = await setup();
  const first = (await run(1)).result;
  writeTranscript(projectsDir, SESSION, 1, 1.25);
  const later = (await run(1.25)).result;
  assert.equal(later.commit.leftMin, first.commit.leftMin - 15);
  assert.equal(later.finish.clockMs, first.finish.clockMs);
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
  const later = formatEstimate((await run(1.05)).result, { timeZone: 'UTC' }).split('\n')[3];
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
  assert.deepEqual(result, { state: 'all-done', nowMs: Date.parse(iso(1)), rows: 2 });
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

test('without a store nothing is read or written; with one the session is linked and the rows are stored for other tables', async () => {
  const { root, statusPath, projectsDir, seedFile, stateDir, run, stored } = await setup();
  const { result, inputs } = estimateFile(statusPath, { now: iso(1), stateDir: null, projectsDir, sessionId: SESSION, seedFile });
  assert.equal(result.state, 'finish');
  assert.deepEqual([inputs.recorded, inputs.busy], [false, false]);
  assert.equal(existsSync(join(root, 'state')), false);
  const recorded = await run(1);
  assert.deepEqual([recorded.inputs.recorded, recorded.inputs.sessions], [true, 1]);
  assert.deepEqual(stored().sessions, [SESSION]);
  assert.deepEqual(stored().rows.map((stored) => [stored.size, stored.cost]), [['S', 30]]);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'session', `${SESSION}.json`), 'utf8')).path.endsWith('STATUS.md'), true);
});
