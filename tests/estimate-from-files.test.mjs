// Tests for estimateFile (home/tools/estimate/lib/from-files.mjs), model s1, the one function behind the CLI and the status line:
// states, the clocks across a pause, the job's one promise (made by a recorded CLI run at the real clock, never re-made, late in
// working minutes only, kept across a hand-over inside the job), the hand-over, the text (no Held line, the 80% time only),
// what is recorded (rows with cost, k and runMin, the upgrade of a c3 file), the capped log (alone and under two runs at once), the store key, held and stalled rows, pause reasons from the limits log and the owner's questions, the seed dedupe
// and the status line numbers (per-row minutes, late with its cause, v2 rounded once, the byte cap).
// Synthetic tables, transcripts and seeds only; the clock is passed in except where the promise needs the real clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { promiseJobKey } from '../home/tools/estimate/lib/finish-result.mjs';
import { UsageError, estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { MAX_CACHE_IDS, MAX_CACHE_ROWS, jobNumbers } from '../home/tools/estimate/lib/job-rows.mjs';
import { formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { MAX_CACHE_BYTES, readEntry, writeEntry } from '../home/tools/estimate/lib/segment-cache.mjs';
import { resultSegment } from '../home/tools/estimate/lib/segment-text.mjs';
import { poolRuns, seedTablesInStore } from '../home/tools/estimate/lib/store-pools.mjs';
import { tableId, updateTable } from '../home/tools/estimate/lib/table-store.mjs';
import { BASE_MS, MIN_MS, SESSION, iso, row, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const TASK_RUNS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const OPEN_DOC = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]);
const at = (hours) => Date.parse(iso(hours));

/** A seed-runs.json of task runs (seed table t1), so the kind pools are known: task = 10..100 plus the store's own runs. */
const writeSeedRuns = (file, runs = TASK_RUNS) => writeFileSync(file, JSON.stringify({ v: 2, rows: runs.map((runMin, k) => ({ t: 't1', k: 'task', runMin, doneMin: 1000 + k })) }));

/** A table, a transcript active from 0 to 1 h, the seeds and an empty store; run(hours, doc?, extra?) estimates it. */
async function setup(doc = OPEN_DOC) {
  const root = realpathSync(makeTempDir('estimate-file-'));
  const statusPath = join(root, 'STATUS.md');
  const projectsDir = join(root, 'projects');
  const stateDir = join(root, 'state');
  const seedFile = join(root, 'seed.json');
  const seedRunsFile = join(root, 'seed-runs.json');
  const limitsDir = join(root, 'limits');
  await writeFile(statusPath, doc);
  writeTranscript(projectsDir, SESSION, 0, 1);
  writeSeed(seedFile, seedRows('S', 5, 30));
  writeSeedRuns(seedRunsFile);
  const env = { HOME: root };
  const options = { stateDir, projectsDir, sessionId: SESSION, record: true, seedFile, seedRunsFile, account: undefined, limitsDir, env };
  const run = async (hours, nextDoc, extra = {}) => {
    if (nextDoc !== undefined) await writeFile(statusPath, nextDoc);
    return estimateFile(statusPath, { ...options, ...(hours === null ? {} : { now: iso(hours) }), ...extra });
  };
  const stored = () => JSON.parse(readFileSync(join(stateDir, 'table', `${tableId(statusPath)}.json`), 'utf8'));
  return { root, statusPath, stateDir, projectsDir, seedFile, seedRunsFile, limitsDir, options, run, stored };
}

/** Stores a promise of the job after no hand-over, made at `hours` for `workMin` of 80% work, as promiseOf would. */
function storePromise({ stateDir, statusPath }, hours, workMin, rows) {
  updateTable(stateDir, statusPath, (table) => ({ ...table, promise: { model: 's1', job: promiseJobKey(tableId(statusPath), null), atMs: at(hours), p80Ms: at(hours) + workMin * MIN_MS, workMin, rows } }));
}

test('now moved over a silence changes no work number and moves the clocks by the silence, on the 5-minute grid', async () => {
  const { run } = await setup();
  const before = (await run(1)).result;
  const after = (await run(3)).result; // no activity from 1 h to 3 h
  assert.equal(before.state, 'finish');
  assert.equal(before.model, 's1');
  assert.deepEqual(after.job, before.job);
  assert.equal(after.finish.clockMs - before.finish.clockMs, 120 * MIN_MS);
  assert.equal(before.finish.clockMs % (5 * MIN_MS), 0, 'R10: the clock is rounded up once, in the numbers');
  assert.equal(before.numbers.v2.job.p50Ms, before.finish.clockMs);
  assert.ok(before.numbers.v2.job.p80Ms >= before.numbers.v2.job.p50Ms);
});

test('the promise: no --now or status-line run makes it; a recorded CLI run at the real clock makes it once and never again', async () => {
  const { run, stored } = await setup();
  assert.equal((await run(1, undefined, { cli: true })).result.promise, null, 'a --now run describes another instant');
  assert.equal((await run(null)).result.promise, null, 'a status-line refresh never promises');
  const first = (await run(null, undefined, { cli: true })).result;
  assert.notEqual(first.promise, null);
  assert.deepEqual(first.promise.rows.map((each) => each.id), ['D1', 'O1']);
  const again = (await run(null, statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), row({ id: 'O2' })]), { cli: true })).result;
  assert.equal(again.promise.atMs, first.promise.atMs, 'never re-made inside the job');
  assert.deepEqual(stored().promise, first.promise);
});

test('F2: two wall hours of pause after the promise are no lateness: the difference runs in worked minutes, the pause moves the clock', async () => {
  const setupDone = await setup();
  const { run } = setupDone;
  const before = (await run(1)).result;
  storePromise(setupDone, 1, before.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  const after = (await run(3)).result; // the transcript stops at 1 h: 120 wall minutes, 0 worked
  assert.equal(after.diff.min, 0, 'a wall-time difference would be 120');
  assert.equal(after.numbers.lateMin, null);
  assert.equal(after.pauses.min, 120);
  assert.deepEqual(after.pauses.byReason, { 'no activity': 120 });
  assert.equal(after.numbers.v2.promise.movedMs, after.numbers.v2.promise.p80Ms + 120 * MIN_MS);
});

test('late against the promise: rows added after it make the job later, with their ids as the cause, once 10 min over', async () => {
  const world = await setup();
  const first = (await world.run(1)).result;
  storePromise(world, 1, first.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  const added = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...['O2', 'O3', 'O4'].map((id) => row({ id }))]);
  const late = (await world.run(1, added)).result;
  assert.ok(late.diff.min >= 10, `${late.diff.min}`);
  assert.equal(late.numbers.lateMin, Math.round(late.diff.min * 10) / 10);
  assert.deepEqual(late.numbers.lateCause, { cause: 'rows-added', ids: ['O2', 'O3', 'O4'], count: 3 });
  assert.equal(late.numbers.firstBudgetMin, Math.round(first.job.p80 * 10) / 10);
  assert.equal(late.progress.tag, '+rows');
});

test('R3: the text never calls a clock that moved unchanged, and states only the confidence model s1 computes', async () => {
  const world = await setup();
  const first = (await world.run(1)).result;
  const firstText = formatEstimate(first, { timeZone: 'UTC' });
  storePromise(world, 1, first.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  const added = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...['O2', 'O3', 'O4'].map((id) => row({ id }))]);
  const later = (await world.run(1, added)).result;
  assert.notEqual(later.finish.clockMs, first.finish.clockMs, 'the rows added move the finish');
  const text = formatEstimate(later, { timeZone: 'UTC' });
  assert.doesNotMatch(`${firstText}\n${text}`, /unchanged|Held:|Moved:|85%|95%/);
  assert.ok(!firstText.split('\n').some((line) => line.startsWith('Promise:')), 'no promise yet: no Promise line');
  assert.match(text, /^Finish: \w{3} \d+ Nov \d\d:\d\d \(likely; 80% by (\w{3} )?\d\d:\d\d; local \+00:00, now 01:00\)$/m);
  assert.match(text, /^Promise: given \w{3} \d+ Nov 01:00: 80% by (\w{3} )?\d\d:\d\d; now (\d+ min|\d+ h \d\d) of work later, because 3 rows were added \(O2, O3, O4\)\.$/m);
});

test('the status line numbers: each open row\'s kind median and likely minutes left; held rows are out', async () => {
  const doc = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), row({ id: 'P1', evidence: 'parked: later' }), row({ id: 'W1', evidence: 'waiting: which one?' })]);
  const { run } = await setup(doc);
  const { result } = await run(1);
  // task pool: 10..100 and D1's own 30 (11 runs, median 50); O1 has run 30 min: longer runs 40..100, median 70, so 40 left.
  assert.deepEqual(result.numbers.rows, [{ id: 'O1', expectMin: 50, leftMin: 40, startedMs: at(0.5) }]);
  assert.deepEqual(result.parked, ['P1']);
  assert.deepEqual(result.waiting.map((each) => [each.id, each.question, each.sinceMs]), [['W1', 'which one?', at(1)]]);
  assert.deepEqual([result.numbers.v2.waiting, result.numbers.v2.parked], [1, 1]);
});

test('the hand-over: no open row and a deliver row after every done row is handed over; the promise is scored and cleared', async () => {
  const world = await setup();
  const first = (await world.run(1)).result;
  storePromise(world, 1, first.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  writeTranscript(world.projectsDir, SESSION, 1, 2);
  const doc = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5, doneH: 1.5 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(1.6) }, evidence: '-' })]);
  const { result } = await world.run(1.7, doc);
  assert.equal(result.state, 'handed-over');
  assert.deepEqual([result.rows, result.workedMin], [2, 90]);
  assert.equal(world.stored().promise, null);
  const scored = world.stored().log.find((entry) => entry.model === 's1');
  assert.deepEqual([scored.scored.workedMin, scored.scored.met], [36, 36 <= first.job.p80]); // worked from 1:00 to the hand-over at 1:36
  assert.deepEqual(result.record, { met: scored.scored.met ? 1 : 0, of: 1 });
});

test('a hand-over while a started row runs is the same job (owner decision 2026-11-23): the promise is kept, scored only at the job\'s end', async () => {
  const world = await setup();
  const first = (await world.run(0.6)).result;
  storePromise(world, 0.6, first.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  const handOver = (n, hours) => row({ id: `deliver:${n}`, item: 'report', raw: { done: iso(hours) }, evidence: '-' });
  const midJob = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), handOver(1, 0.7)]);
  const kept = (await world.run(0.8, midJob)).result;
  assert.equal(kept.state, 'finish');
  assert.equal(kept.promise?.atMs, at(0.6), 'O1 ran across the hand-over at 0.7 h: it only checks the promise');
  assert.deepEqual(world.stored().log.filter((entry) => entry.model === 's1'), []);
  const ended = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5, doneH: 0.9 }), handOver(1, 0.7), handOver(2, 0.95)]);
  const { result } = await world.run(1, ended);
  assert.equal(result.state, 'handed-over');
  const scored = world.stored().log.find((entry) => entry.model === 's1');
  assert.deepEqual([scored.scored.handedOverMs, scored.scored.workedMin], [at(0.95), 21]); // worked from 0:36 to the job's end at 0:57
});

test('all done without a hand-over says so; no work row is the one refusal left', async () => {
  const { run } = await setup();
  const { result } = await run(1, statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5, doneH: 1 })]));
  assert.deepEqual(result, { state: 'all-done', nowMs: at(1), rows: 2, progress: { pct: 100, approx: false, rowsDone: 2, rowsTotal: 2, leftMin: 0, tag: null }, checks: [] });
  assert.equal((await run(1, statusDoc([]))).result.refusal.reason, 'no-rows');
});

test('a table problem throws a UsageError carrying the problems; a bad now is a UsageError', async () => {
  const { run, statusPath } = await setup();
  await assert.rejects(run(1, statusDoc([row({ id: 'M1', doneH: 0.5 })])), (error) => error instanceof UsageError && error.problems[0].id === 'M1');
  await assert.rejects(run(0.2, OPEN_DOC), (error) => error instanceof UsageError && /later than now/.test(error.message));
  assert.throws(() => estimateFile(statusPath, { now: '2026-02-30T08:00Z' }), UsageError);
});

test('without a store nothing is read or written; with one the rows are stored with kind and run minutes and no session is linked', async () => {
  const { root, statusPath, options, run, stored, stateDir } = await setup();
  const { result, inputs } = estimateFile(statusPath, { ...options, now: iso(1), stateDir: null });
  assert.equal(result.state, 'finish');
  assert.deepEqual([inputs.recorded, inputs.busy], [false, false]);
  assert.equal(existsSync(join(root, 'state')), false);
  const recorded = await run(1);
  assert.deepEqual([recorded.inputs.recorded, recorded.inputs.sessions], [true, 1]);
  assert.deepEqual(stored().rows.map((each) => [each.size, each.cost, each.k, each.runMin]), [['S', 30, 'task', 30]], 'the c3 cost stays beside k and runMin (spec section 9: add, not replace)');
  assert.deepEqual(Object.keys(stored().added).sort(), ['D1', 'O1']);
  assert.deepEqual(stored().sessions, []);
  assert.equal(existsSync(join(stateDir, 'session', `${SESSION}.json`)), false);
});

test('F1 upgrade: a c3 table file is read and rewritten in the s1 shape; its old first and scored entries stay', async () => {
  const world = await setup();
  const c3Log = [{ at: iso(-5), first: true, model: 'c3', budgetMin: 40, ids: ['x'], scored: { met: true } }];
  updateTable(world.stateDir, world.statusPath, (table) => ({ v: 2, path: table.path, sessions: [], added: {}, rows: [{ size: 'S', kind: 'build', done: iso(-6), cost: 12 }],
    jobs: [], commit: { at: iso(-5), budgetMin: 40, ids: ['x'], moved: null }, log: c3Log }));
  assert.equal((await world.run(1)).result.state, 'finish');
  const table = world.stored();
  assert.equal(table.commit, null);
  assert.deepEqual([table.promise, table.steps, table.waitSeen], [null, [], {}]);
  assert.deepEqual(table.rows.map((each) => [each.k, each.runMin]), [['task', 30]]);
  assert.deepEqual(table.log, c3Log);
});

test('two refreshes at once: under the table lock no first or scored entry is lost', async () => {
  const { statusPath, stateDir, projectsDir, seedFile, seedRunsFile, stored } = await setup();
  const before = Array.from({ length: 250 }, (_, k) => ({ at: new Date(at(-10) + k * MIN_MS).toISOString(), ids: ['gone'], p50: 10, raw85: 20, p85: 20, first: k < 5, model: 'c3', ...(k % 10 === 0 ? { scored: { met: true } } : {}) }));
  updateTable(stateDir, statusPath, (table) => ({ ...table, log: before }));
  const startAt = Date.now() + 300;
  const script = `
    import { estimateFile } from ${JSON.stringify(new URL('../home/tools/estimate/lib/from-files.mjs', import.meta.url).href)};
    while (Date.now() < ${startAt});
    const [statusPath, stateDir, projectsDir, seedFile, seedRunsFile, sessionId, now] = process.argv.slice(1);
    const { inputs } = estimateFile(statusPath, { stateDir, projectsDir, seedFile, seedRunsFile, sessionId, now, record: true, account: 'none' });
    process.stdout.write(inputs.busy ? 'busy' : 'recorded');`;
  const args = ['--input-type=module', '-e', script, statusPath, stateDir, projectsDir, seedFile, seedRunsFile, SESSION, iso(1)];
  const runs = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, args)));
  assert.ok(runs.some((each) => each.stdout === 'recorded'));
  const kept = new Set(stored().log.map((entry) => entry.at));
  assert.deepEqual(before.filter((entry) => entry.first || entry.scored).map((entry) => entry.at).filter((entryAt) => !kept.has(entryAt)), []);
});

test('the log is capped on a recorded run: the newest 200 entries and every older first and scored entry, nothing else', async () => {
  const world = await setup();
  const before = Array.from({ length: 250 }, (_, k) => ({ at: new Date(at(-10) + k * MIN_MS).toISOString(), ids: ['gone'], p50: 10, raw85: 20, p85: 20, first: k < 5, model: 'c3', ...(k % 10 === 0 ? { scored: { met: true } } : {}) }));
  updateTable(world.stateDir, world.statusPath, (table) => ({ ...table, log: before }));
  await world.run(1);
  const older = before.slice(0, 50).filter((entry) => entry.first || entry.scored);
  assert.equal(older.length, 9, 'k < 5 and every 10th: 0-4, 10, 20, 30, 40');
  assert.deepEqual(world.stored().log.map((entry) => entry.at), [...older, ...before.slice(50)].map((entry) => entry.at));
});

test('F3: the store key comes from the real path: a linked STATUS.md and its target share one table file', async () => {
  const world = await setup();
  const link = join(world.root, 'linked-STATUS.md');
  symlinkSync(world.statusPath, link);
  assert.equal(tableId(link), tableId(world.statusPath));
  estimateFile(link, { ...world.options, now: iso(1) });
  assert.deepEqual(world.stored().rows.map((each) => each.k), ['task']);
});

test('a row open far past its kind\'s runs with no agent stalls: one fresh run of its kind, and a Check line names it', async () => {
  const world = await setup(statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'S1', startedH: 0 })]));
  writeTranscript(world.projectsDir, SESSION, 1, 3);
  const { result } = await world.run(3);
  assert.deepEqual(result.stalled, ['S1']);
  assert.deepEqual(result.checks.filter((check) => check.kind === 'stalled').map((check) => [check.id, check.countedMin]), [['S1', 50]]);
  assert.ok(formatEstimate(result, { timeZone: 'UTC' }).split('\n').includes('Check: row S1 is still open after 3 h 00 of work: done, park or drop it (counted as one fresh task, 50 min).'));
});

test('pause reasons: a silence ending at a 5-hour reset seen at 100 % only in the 7-day log is a usage limit; an open question is waiting for you', async () => {
  const world = await setup();
  writeTranscript(world.projectsDir, SESSION, 2, 2.5);
  mkdirSync(world.limitsDir, { recursive: true });
  // Only the log holds the 100 % sample (the limits file keeps the newest 12): readLimits alone would miss it.
  appendFileSync(join(world.limitsDir, 'acct1.jsonl'), `${JSON.stringify({ t: at(0.9), five_hour: { used_percentage: 100, resets_at: at(2) / 1000 }, seven_day: null })}\n`);
  const limited = (await world.run(2.5, undefined, { account: 'acct1' })).result;
  assert.deepEqual(limited.pauses.byReason, { 'usage limit': 60 });
  const ask = { type: 'assistant', timestamp: new Date(at(2.5)).toISOString(), message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion' }] } };
  const answer = { type: 'user', timestamp: new Date(at(3.5)).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'q1' }] } };
  appendFileSync(join(world.projectsDir, '-synthetic-project', `${SESSION}.jsonl`), `${JSON.stringify(ask)}\n${JSON.stringify(answer)}\n`);
  const asked = (await world.run(3.5, undefined, { account: 'acct1' })).result;
  // The question's own line is the minute 2:30-2:31 of activity, so the silence it overlaps runs from 2:31 to the answer at 3:30.
  assert.equal(asked.pauses.byReason['waiting for you'], 59);
});

test('seed dedupe: a seed table the store holds (same kinds, done minutes one shift apart) leaves the pool; a partial match does not', () => {
  const seed = [{ t: 't1', k: 'lane', runMin: 20, doneMin: 10 }, { t: 't1', k: 'fix', runMin: 9, doneMin: 40 }, { t: 't2', k: 'lane', runMin: 30, doneMin: 5 }, { t: 't2', k: 'fix', runMin: 4, doneMin: 7 }];
  const shift = Math.floor(BASE_MS / MIN_MS);
  const stamp = (minute) => new Date((minute + shift) * MIN_MS).toISOString();
  const store = [{ rows: [{ k: 'lane', runMin: 21, done: stamp(10) }, { k: 'fix', runMin: 9, done: stamp(40) }, { k: 'lane', runMin: 30, done: stamp(99) }] }];
  assert.deepEqual(seedTablesInStore(seed, store), ['t1']);
  assert.deepEqual(poolRuns(store, seed), [{ k: 'lane', runMin: 21 }, { k: 'fix', runMin: 9 }, { k: 'lane', runMin: 30 }, { k: 'lane', runMin: 30 }, { k: 'fix', runMin: 4 }]);
  const shifted = [{ rows: [{ k: 'lane', runMin: 21, done: stamp(10) }, { k: 'fix', runMin: 9, done: stamp(41) }] }];
  assert.deepEqual(seedTablesInStore(seed, shifted), [], 'two shifts are two tables, not one');
  assert.deepEqual(seedTablesInStore(seed, [{ rows: [{ size: 'S', kind: 'build', done: stamp(10), cost: 5 }] }]), [], 'a c3 row matches nothing');
});

test('F4: a 300-row job stays under the cache byte cap with 64 rows and its late cause cut; an R18 entry is still read', async () => {
  const longId = (k) => `row-with-a-rather-long-name-${String(k).padStart(4, '0')}`;
  const world = await setup();
  const first = (await world.run(1)).result;
  storePromise(world, 1, first.job.p80, [{ id: 'D1', likelyMin: 30 }, { id: 'O1', likelyMin: 70 }]);
  const many = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), ...Array.from({ length: 300 }, (_, k) => row({ id: longId(k) }))]);
  const { result } = await world.run(1, many);
  assert.equal(result.numbers.rows.length, 64);
  assert.deepEqual([result.numbers.lateCause.count, result.numbers.lateCause.ids.length], [300, 16]);
  const cache = join(world.root, 'cache');
  const entry = { path: world.statusPath, ...resultSegment(result), mtimeMs: 1, size: 1e6, computedAt: Date.now(), refreshStartedAt: Date.now() };
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) < MAX_CACHE_BYTES, `${Buffer.byteLength(JSON.stringify(entry))} bytes`);
  assert.ok(writeEntry(cache, world.statusPath, entry));
  assert.equal(readEntry(cache, world.statusPath).numbers.v2.model, 's1');
  const r18 = { ...entry, numbers: { finishMs: at(2), p85Ms: at(3), leftMin: 30, workedMin: 10, rowsDone: 1, rowsTotal: 2, rows: [{ id: 'O1', expectMin: 9, leftMin: 3, startedMs: null }] } };
  assert.ok(writeEntry(cache, world.statusPath, r18));
  assert.deepEqual(readEntry(cache, world.statusPath).numbers, r18.numbers);
});

test('F4: 64 rows, 64 stalled ids and two reasons of 100 long ids stay under the cache byte cap; every id list keeps its count', () => {
  const longId = (prefix, k) => `${prefix}-row-with-a-rather-long-name-${String(k).padStart(4, '0')}`;
  const ids = (prefix) => Array.from({ length: 100 }, (_, k) => longId(prefix, k));
  const nowMs = at(1);
  const numbers = jobNumbers({ nowMs, workedMin: 300, rows: ids('o').map((id, k) => ({ id, done: false, expectMin: 22.5, leftMin: 13.3, startedMs: nowMs - k })) }, {
    job: { p50: 300, p80: 400 }, step: null, waiting: 0, parked: 0, stalled: ids('o').slice(0, 64), promise: { atMs: nowMs - 1e6, p80Ms: nowMs + 1e6, workMin: 200 },
    diff: { min: 120, reasons: [{ kind: 'rows-added', min: 100, ids: ids('a') }, { kind: 'over-usual', min: 40, ids: ids('o') }] }, pauses: { min: 0, byReason: {} },
  });
  const entry = { path: '/Users/u/p/STATUS.md', kind: 'finish', text: 'done by 13:20', highMs: 1, progress: null, numbers, mtimeMs: 1, size: 1, computedAt: nowMs, refreshStartedAt: nowMs };
  assert.ok(Buffer.byteLength(JSON.stringify(entry)) < MAX_CACHE_BYTES, `${Buffer.byteLength(JSON.stringify(entry))} bytes`);
  assert.equal(numbers.rows.length, MAX_CACHE_ROWS);
  assert.deepEqual([numbers.v2.stalled.length, numbers.v2.stalledCount], [MAX_CACHE_IDS, 64]);
  assert.deepEqual(numbers.v2.diff.reasons.map((reason) => [reason.ids.length, reason.count]), [[MAX_CACHE_IDS, 100], [MAX_CACHE_IDS, 100]]);
  assert.deepEqual([numbers.lateCause.ids.length, numbers.lateCause.count], [MAX_CACHE_IDS, 100]);
});
