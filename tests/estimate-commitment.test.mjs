// Tests for home/tools/estimate/lib/commitment.mjs: the first / hold / move decision with its stored cause, the hold band, the
// kept first budget and latest later cause, scoring at the hand-over, the widening factor and the track record (current model
// only); the s1 promise: made once per job by a recorded CLI run only, torn or c3 records read as none, late or early in working
// minutes with at most two reasons. Expected values are hand arithmetic on the estimator design 3.8-3.9, spec R18 E2 and R22 R9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ID, PROMISE_MODEL, band, firstCommitmentOf, nextCommitment, promiseDiff, promiseOf, scoreLog, trackRecord, widening } from '../home/tools/estimate/lib/commitment.mjs';

const BASE_MIN = Date.parse('2026-11-16T10:00Z') / 60_000;
const isoAt = (minute) => new Date((BASE_MIN + minute) * 60_000).toISOString();
const msAt = (minute) => (BASE_MIN + minute) * 60_000;
const FRESH = { p50: 40, raw85: 80, p85: 80, p95: 120, g: 0.4, kappa: 1 };
const context = (openIds, slowRowId = null) => ({ nowMin: BASE_MIN + 30, openIds, slowRowId });
const held = { at: isoAt(0), budgetMin: 90, ids: ['a', 'b'], moved: null };

test('nextCommitment: with no commitment the first one is the fresh p50 from now, logged as first with the model id', () => {
  const { commit, entry } = nextCommitment(null, FRESH, null, context(['a', 'b']));
  assert.deepEqual(commit, { at: isoAt(30), budgetMin: 40, ids: ['a', 'b'], moved: null, first: { at: isoAt(30), budgetMin: 40 }, laterCause: null });
  assert.deepEqual(entry, { at: isoAt(30), ids: ['a', 'b'], p50: 40, raw85: 80, p85: 80, p95: 120, g: 0.4, kappa: 1, first: true, cause: null, model: 'c3' });
});

test('nextCommitment holds while the budget left covers the fresh p50, keeping a stored move', () => {
  const movedEarlier = { ...held, moved: { at: isoAt(0), wasClock: isoAt(20), cause: 'pace', ids: [] } };
  const result = nextCommitment(movedEarlier, FRESH, 40, context(['a', 'b', 'c']));
  assert.equal(result.commit, movedEarlier);
  assert.equal(result.entry, null);
});

test('nextCommitment hold band: max(15 min, 25 % of the larger of the fresh p50 and the budget left)', () => {
  const at = (p50) => ({ ...FRESH, p50 });
  assert.equal(nextCommitment(held, at(40), 26, context(['a', 'b'])).entry, null, '14 min apart: held');
  assert.equal(nextCommitment(held, at(40), 25, context(['a', 'b'])).entry, null, '15 min apart: held');
  assert.equal(nextCommitment(held, at(40), 24, context(['a', 'b'])).entry.first, false, '16 min apart: moved');
  assert.equal(nextCommitment(held, at(200), 160, context(['a', 'b'])).entry, null, '40 min apart, band 50: held');
  assert.equal(nextCommitment(held, at(200), 149, context(['a', 'b'])).entry.cause, 'pace', '51 min apart, band 50: moved');
  assert.equal(nextCommitment(held, at(149), 200, context(['a'])).entry.cause, 'ahead', 'the band is the same for an earlier move');
});

test('nextCommitment moves later when the budget left falls short by more than the band; added rows are the cause first', () => {
  const { commit, entry } = nextCommitment(held, FRESH, 20, context(['a', 'b', 'c', 'd'], 'a'));
  assert.deepEqual(commit, {
    at: isoAt(30), budgetMin: 40, ids: ['a', 'b', 'c', 'd'], moved: { at: isoAt(30), wasClock: isoAt(50), cause: 'rows-added', ids: ['c', 'd'] },
    first: { at: isoAt(0), budgetMin: 90 }, laterCause: { cause: 'rows-added', ids: ['c', 'd'] },
  });
  assert.equal(entry.first, false);
  assert.equal(entry.cause, 'rows-added');
});

test('a move keeps the first budget; an earlier move keeps the latest later cause', () => {
  const first = nextCommitment(null, { ...FRESH, p50: 60 }, null, context(['a', 'b'])).commit;
  const later = nextCommitment(first, { ...FRESH, p50: 100 }, 40, { ...context(['a', 'b', 'c']), nowMin: BASE_MIN + 50 }).commit;
  assert.deepEqual(later.laterCause, { cause: 'rows-added', ids: ['c'] });
  const earlier = nextCommitment(later, { ...FRESH, p50: 20 }, 90, { ...context(['c']), nowMin: BASE_MIN + 60 }).commit;
  assert.equal(earlier.moved.cause, 'ahead');
  assert.deepEqual(earlier.laterCause, { cause: 'rows-added', ids: ['c'] });
  assert.deepEqual(earlier.first, { at: isoAt(30), budgetMin: 60 });
});

test('a commitment stored before c3 (no first, no laterCause): its first budget is itself until it moved, then unknown', () => {
  assert.deepEqual(firstCommitmentOf(held), { at: isoAt(0), budgetMin: 90 });
  const movedOld = { ...held, moved: { at: isoAt(0), wasClock: isoAt(20), cause: 'pace', ids: [] } };
  assert.equal(firstCommitmentOf(movedOld), null);
  const next = nextCommitment(held, FRESH, -5, context(['a', 'b'])).commit;
  assert.deepEqual([next.first, next.laterCause], [{ at: isoAt(0), budgetMin: 90 }, { cause: 'pace', ids: [] }]);
  assert.equal(nextCommitment(movedOld, FRESH, -5, context(['a', 'b'])).commit.first, null);
});

test('nextCommitment move cause: a slow running row when no row was added, else pace', () => {
  assert.deepEqual(nextCommitment(held, FRESH, 10, context(['b'], 'b')).commit.moved, { at: isoAt(30), wasClock: isoAt(40), cause: 'slow-row', ids: ['b'] });
  assert.deepEqual(nextCommitment(held, FRESH, -5, context(['a', 'b'])).commit.moved, { at: isoAt(30), wasClock: isoAt(25), cause: 'pace', ids: [] });
});

test('scoreLog scores a commitment at the first hand-over by which all its ids still in the table are done', () => {
  const items = [
    { id: 'a', kind: 'build', started: msAt(0), done: msAt(30) },
    { id: 'b', kind: 'build', started: msAt(0), done: msAt(50) },
    { id: 'deliver:1', kind: 'deliver', started: msAt(40), done: msAt(40) },
    { id: 'deliver:2', kind: 'deliver', started: msAt(60), done: msAt(60) },
    { id: 'c', kind: 'build', started: msAt(55), done: null },
  ];
  const intervals = [[BASE_MIN, BASE_MIN + 20], [BASE_MIN + 30, BASE_MIN + 60]];
  const log = [
    { at: isoAt(0), ids: ['a', 'b', 'gone'], p50: 30, raw85: 40, p85: 45, p95: 60, g: 0, kappa: 1, first: true, cause: null },
    { at: isoAt(5), refusal: 'growth', p50: 10, p85: 20 },
    { at: isoAt(56), ids: ['c'], p50: 3, raw85: 5, p85: 5, p95: 8, g: 0, kappa: 1, first: true, cause: null },
    { at: isoAt(1), ids: ['a'], p50: 1, raw85: 1, p85: 1, p95: 1, g: 0, kappa: 1, first: true, cause: null, scored: { at: 'kept', actualMin: 1, met: true, ratio: 1 } },
  ];
  const scored = scoreLog(log, items, intervals);
  assert.deepEqual(scored[0].scored, { at: isoAt(60), actualMin: 50, met: false, ratio: 50 / 40, ratio50: 50 / 30 });
  assert.equal(scored[1].scored, undefined);
  assert.equal(scored[2].scored, undefined);
  assert.deepEqual(scored[3].scored, log[3].scored);
  assert.equal(log[0].scored, undefined, 'the given log is not changed');
});

const scoredFirst = (ratio, met = true, model = MODEL_ID) => ({ first: true, raw85: 1, model, scored: { ratio, met, ratio50: ratio } });

test('entries of the old model c2b are kept in the log but not counted by widening, band or track record', () => {
  const old = Array.from({ length: 25 }, () => scoredFirst(3, false, 'c2b'));
  assert.equal(widening(old), 1);
  assert.equal(trackRecord(old), null);
  assert.equal(band(old).count, 0);
  assert.equal(widening([...old, ...Array.from({ length: 10 }, () => scoredFirst(1.5))]), 1.5);
  assert.deepEqual(scoreLog(old, [], []), old, 'scored entries of any model stay as they are');
});

test('widening is 1 until 10 first commitments are scored, then the p85 of the last 20 ratios, never below 1', () => {
  assert.equal(widening(Array.from({ length: 9 }, () => scoredFirst(3))), 1);
  const ten = Array.from({ length: 10 }, (_, k) => scoredFirst((k + 1) / 5));
  assert.equal(widening(ten), 1.8);
  assert.equal(widening(Array.from({ length: 10 }, () => scoredFirst(0.5))), 1);
  const older = Array.from({ length: 5 }, () => scoredFirst(9));
  const moved = { first: false, raw85: 1, scored: { ratio: 9, met: false } };
  assert.equal(widening([...older, moved, ...Array.from({ length: 20 }, () => scoredFirst(1.2))]), 1.2);
});

test('trackRecord counts the met first commitments among the last 10 scored; null with none scored', () => {
  assert.equal(trackRecord([]), null);
  assert.equal(trackRecord([{ first: true, raw85: 1 }]), null);
  const log = [scoredFirst(2, false), scoredFirst(2, false), ...Array.from({ length: 9 }, () => scoredFirst(1)), scoredFirst(2, false), { first: false, scored: { met: true } }];
  assert.deepEqual(trackRecord(log), { met: 9, of: 10 });
});

// Model s1: the job's one finish promise (spec R9, R11, section 7; owner R22-E2, E3; contract F1-F3).
const NOW_MS = msAt(0);
const LATER_MS = msAt(45);
const CLI_RUN = { cli: true, realClock: true, recorded: true };
const ROWS = [{ id: 'a', likelyMin: 40 }, { id: 'b', likelyMin: 40 }, { id: 'c', likelyMin: 40 }];
const freshRun = (run, more = {}) => ({ job: 'job-1', p80Ms: msAt(150), workLeftMin: 120, rows: ROWS, run, ...more });
const made = promiseOf(null, freshRun(CLI_RUN), NOW_MS);

test('promiseOf: the first recorded CLI run at the real clock makes the promise: its 80% clock, 80% work and rows', () => {
  assert.deepEqual(made, { model: PROMISE_MODEL, job: 'job-1', atMs: NOW_MS, p80Ms: msAt(150), workMin: 120, rows: ROWS });
  assert.notEqual(made.rows, ROWS, 'the rows are copied, not shared with the caller');
});

test('promiseOf: a status-line refresh, a --now run or a run that could not take the table lock makes no promise (F1)', () => {
  for (const run of [{ ...CLI_RUN, cli: false }, { ...CLI_RUN, realClock: false }, { ...CLI_RUN, recorded: false }, undefined, 'cli', { cli: 1, realClock: 1, recorded: 1 }]) {
    assert.equal(promiseOf(null, freshRun(run), NOW_MS), null, JSON.stringify(run));
  }
});

test('promiseOf: the promise is made once per job; later runs of any kind keep it, so two runs under the lock keep the first', () => {
  const laterFresh = { p80Ms: msAt(400), workLeftMin: 300, rows: [...ROWS, { id: 'd', likelyMin: 90 }] };
  assert.deepEqual(promiseOf(made, freshRun(CLI_RUN, laterFresh), LATER_MS), made, 'a later CLI run keeps it: no hold band, no move');
  assert.deepEqual(promiseOf(made, freshRun({ ...CLI_RUN, cli: false }, laterFresh), LATER_MS), made, 'a status-line refresh shows it');
  const second = promiseOf(promiseOf(null, freshRun(CLI_RUN), NOW_MS), freshRun(CLI_RUN, laterFresh), NOW_MS + 1);
  assert.equal(second.atMs, NOW_MS, 'the second of two parallel CLI runs reads the first one\'s promise and keeps it');
});

test('promiseOf: a promise of another job is stale: none for a refresh, a new one for a recorded CLI run', () => {
  const nextJob = (run) => freshRun(run, { job: 'job-2', p80Ms: msAt(200) });
  assert.equal(promiseOf(made, nextJob({ ...CLI_RUN, cli: false }), LATER_MS), null);
  assert.deepEqual(promiseOf(made, nextJob(CLI_RUN), LATER_MS), { ...made, job: 'job-2', atMs: LATER_MS, p80Ms: msAt(200) });
});

test('promiseOf: a c3 commit record, a torn, future or malformed record reads as no promise, without error (F3)', () => {
  const c3Commit = { at: isoAt(0), budgetMin: 90, ids: ['a', 'b'], moved: null, first: { at: isoAt(0), budgetMin: 90 }, laterCause: null };
  const torn = [
    c3Commit, { ...c3Commit, model: 'c3' }, undefined, null, '{"model":"s1","job":"jo', [made], 42,
    { ...made, model: 'c3' }, { model: 's1', job: 'job-1' }, { ...made, atMs: Number.NaN }, { ...made, atMs: String(NOW_MS) },
    { ...made, atMs: LATER_MS + 1 }, { ...made, p80Ms: NOW_MS - 1 }, { ...made, workMin: -1 }, { ...made, workMin: Infinity },
    { ...made, rows: null }, { ...made, rows: [{ id: 'a', likelyMin: 1 }, { id: 'a', likelyMin: 2 }] }, { ...made, rows: [{ id: 'a' }] },
    { ...made, rows: [{ id: '', likelyMin: 1 }] }, { ...made, rows: [null] },
  ];
  for (const stored of torn) {
    assert.equal(promiseOf(stored, freshRun({ ...CLI_RUN, cli: false }), LATER_MS), null, JSON.stringify(stored));
    assert.equal(promiseOf(stored, freshRun(CLI_RUN), LATER_MS).atMs, LATER_MS, 'a recorded CLI run makes the job\'s promise in its place');
  }
});

test('promiseOf: malformed numbers of this run are a bug and throw', () => {
  assert.throws(() => promiseOf(null, freshRun(CLI_RUN), Number.NaN), TypeError);
  for (const bad of [{ job: '' }, { p80Ms: NOW_MS - 1 }, { workLeftMin: -5 }, { rows: [{ id: 'a', likelyMin: Number.NaN }] }]) {
    assert.throws(() => promiseOf(null, freshRun(CLI_RUN, bad), NOW_MS), TypeError, JSON.stringify(bad));
  }
});

const diff = (workedSinceMin, workLeftMin, rowsNow) => promiseDiff(made, { workLeftMin }, workedSinceMin, rowsNow, made.rows);

test('promiseDiff: later = worked since + fresh 80% work left - promised work; rows added and over usual are the reasons', () => {
  const rowsNow = [{ id: 'a', likelyMin: 40 }, { id: 'b', likelyMin: 55 }, { id: 'c', likelyMin: 40 }, { id: 'd', likelyMin: 20 }];
  assert.deepEqual(diff(50, 105, rowsNow), { min: 35, reasons: [{ kind: 'rows-added', min: 20, ids: ['d'] }, { kind: 'over-usual', min: 15, ids: ['b'] }] });
});

test('promiseDiff: late by a slow row is not blamed on small added rows; a reason under 10 % of the difference is dropped (R27)', () => {
  const rowsNow = [{ id: 'a', likelyMin: 150 }, ...ROWS.slice(1), { id: 'x', likelyMin: 5 }, { id: 'y', likelyMin: 6 }];
  assert.deepEqual(diff(120, 120, rowsNow), { min: 120, reasons: [{ kind: 'over-usual', min: 110, ids: ['a'] }] }, '11 of 120 is under 12: dropped');
  const atTenth = [{ id: 'a', likelyMin: 148 }, ...ROWS.slice(1), { id: 'x', likelyMin: 6 }, { id: 'y', likelyMin: 6 }];
  assert.deepEqual(diff(120, 120, atTenth).reasons.map((reason) => reason.min), [108, 12], '12 of 120 is 10 %: kept');
});

test('promiseDiff: earlier is negative; rows faster or dropped are its reasons, largest first, never an added row', () => {
  const rowsNow = [{ id: 'a', likelyMin: 25 }, { id: 'b', likelyMin: 10 }, { id: 'e', likelyMin: 15 }];
  assert.deepEqual(diff(30, 40, rowsNow), { min: -50, reasons: [{ kind: 'faster', min: -85, ids: ['c', 'b', 'a'] }] });
});

test('promiseDiff: on time when the difference is 0, whatever the rows did; at most two reasons', () => {
  const rowsNow = [{ id: 'a', likelyMin: 60 }, ...ROWS.slice(1), { id: 'd', likelyMin: 30 }];
  assert.deepEqual(diff(60, 60, rowsNow), { min: 0, reasons: [] });
  assert.equal(diff(60, 110, rowsNow).reasons.length, 2);
});

test('promiseDiff: a pause is no lateness: three wall hours with two paused and one worked count as one hour (F2, R22-E3)', () => {
  assert.deepEqual(diff(60, 60, ROWS), { min: 0, reasons: [] });
});

test('promiseDiff: malformed arguments throw', () => {
  assert.throws(() => promiseDiff(null, { workLeftMin: 1 }, 0, [], []), TypeError);
  assert.throws(() => diff(-1, 10, ROWS), TypeError);
  assert.throws(() => diff(0, Number.NaN, ROWS), TypeError);
  assert.throws(() => diff(0, 10, [{ id: 'a', likelyMin: 1 }, { id: 'a', likelyMin: 1 }]), TypeError);
});

const YEAR_AHEAD_MS = 366 * 24 * 60 * 60_000; // MAX_PROMISE_AHEAD_MS
const WORK_CAP_MIN = 366 * 24 * 60; // MAX_PROMISE_WORK_MIN

test('promiseOf: a stored time outside 2020..now + 366 days or minutes over the cap read as no promise, so every clock prints', () => {
  const outside = [
    { ...made, atMs: 0, p80Ms: 0 }, { ...made, atMs: -1e300, p80Ms: 1e300, workMin: 1e300 }, { ...made, atMs: Date.parse('2019-12-31T23:59Z') },
    { ...made, p80Ms: 1e300 }, { ...made, p80Ms: LATER_MS + YEAR_AHEAD_MS + 1 }, { ...made, workMin: WORK_CAP_MIN + 1 },
    { ...made, rows: [{ id: 'a', likelyMin: WORK_CAP_MIN + 1 }] }, { ...made, rows: [{ id: 'a', likelyMin: 1e300 }] },
  ];
  for (const stored of outside) assert.equal(promiseOf(stored, freshRun({ ...CLI_RUN, cli: false }), LATER_MS), null, JSON.stringify(stored));
  const edge = { ...made, p80Ms: LATER_MS + YEAR_AHEAD_MS, workMin: WORK_CAP_MIN, rows: [{ id: 'a', likelyMin: WORK_CAP_MIN }] };
  const kept = promiseOf(edge, freshRun({ ...CLI_RUN, cli: false }), LATER_MS);
  assert.deepEqual(kept, edge, 'the bounds themselves are kept');
  assert.doesNotThrow(() => [kept.atMs, kept.p80Ms].map((ms) => new Date(ms).toISOString()));
});

test('promiseOf and promiseDiff: this run\'s numbers outside the same bounds throw, so a made promise always reads back as kept', () => {
  assert.throws(() => promiseOf(null, freshRun(CLI_RUN), 0), TypeError);
  assert.throws(() => promiseOf(null, freshRun(CLI_RUN, { p80Ms: 1e300 }), 1e300), TypeError, 'a clock past the last Date');
  for (const bad of [{ p80Ms: NOW_MS + YEAR_AHEAD_MS + 1 }, { workLeftMin: WORK_CAP_MIN + 1 }, { rows: [{ id: 'a', likelyMin: WORK_CAP_MIN + 1 }] }]) {
    assert.throws(() => promiseOf(null, freshRun(CLI_RUN, bad), NOW_MS), TypeError, JSON.stringify(bad));
  }
  const edge = promiseOf(null, freshRun(CLI_RUN, { p80Ms: NOW_MS + YEAR_AHEAD_MS, workLeftMin: WORK_CAP_MIN }), NOW_MS);
  assert.deepEqual(promiseOf(edge, freshRun(CLI_RUN), NOW_MS + 1), edge);
  assert.throws(() => promiseDiff({ workMin: WORK_CAP_MIN + 1 }, { workLeftMin: 1 }, 0, [], []), TypeError);
  assert.throws(() => diff(WORK_CAP_MIN + 1, 1, ROWS), TypeError);
});

test('promiseDiff: row ids match ignoring case, as in the table: P17 at the promise is p17 now, not an added and a dropped row', () => {
  const d = promiseDiff({ workMin: 80 }, { workLeftMin: 110 }, 0, [{ id: 'p17', likelyMin: 70 }, { id: 'b', likelyMin: 40 }], [{ id: 'P17', likelyMin: 40 }, { id: 'b', likelyMin: 40 }]);
  assert.deepEqual(d, { min: 30, reasons: [{ kind: 'over-usual', min: 30, ids: ['p17'] }] });
  assert.throws(() => diff(0, 10, [{ id: 'a', likelyMin: 1 }, { id: 'A', likelyMin: 1 }]), TypeError, 'a and A are one id repeated');
  assert.equal(promiseOf({ ...made, rows: [{ id: 'a', likelyMin: 1 }, { id: 'A', likelyMin: 1 }] }, freshRun({ ...CLI_RUN, cli: false }), LATER_MS), null);
});
