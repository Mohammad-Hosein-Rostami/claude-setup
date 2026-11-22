// Tests for home/tools/estimate/lib/commitment.mjs: the first / hold / move decision with its stored cause, the hold band, the
// kept first budget and latest later cause, scoring at the hand-over, the widening factor and the track record (current model
// only). Expected values are hand arithmetic on the estimator design 3.8-3.9 and spec R18 E2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ID, band, firstCommitmentOf, nextCommitment, scoreLog, trackRecord, widening } from '../home/tools/estimate/lib/commitment.mjs';

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
