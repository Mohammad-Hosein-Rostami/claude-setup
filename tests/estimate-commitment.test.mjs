// Tests for home/tools/estimate/lib/commitment.mjs: the first / hold / move decision with its stored cause, scoring at the
// hand-over, the widening factor and the track record. Expected values are hand arithmetic on the estimator design 3.8-3.9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ID, nextCommitment, scoreLog, trackRecord, widening } from '../home/tools/estimate/lib/commitment.mjs';

const BASE_MIN = Date.parse('2026-11-16T10:00Z') / 60_000;
const isoAt = (minute) => new Date((BASE_MIN + minute) * 60_000).toISOString();
const msAt = (minute) => (BASE_MIN + minute) * 60_000;
const FRESH = { p50: 40, raw85: 80, p85: 80, p95: 120, g: 0.4, kappa: 1 };
const context = (openIds, slowRowId = null) => ({ nowMin: BASE_MIN + 30, openIds, slowRowId });
const held = { at: isoAt(0), budgetMin: 90, ids: ['a', 'b'], moved: null };

test('nextCommitment: with no commitment the first one is the fresh p50 from now, logged as first with the model id', () => {
  const { commit, entry } = nextCommitment(null, FRESH, null, context(['a', 'b']));
  assert.deepEqual(commit, { at: isoAt(30), budgetMin: 40, ids: ['a', 'b'], moved: null });
  assert.deepEqual(entry, { at: isoAt(30), ids: ['a', 'b'], p50: 40, raw85: 80, p85: 80, p95: 120, g: 0.4, kappa: 1, first: true, cause: null, model: MODEL_ID });
});

test('nextCommitment holds while the budget left covers the fresh p50, keeping a stored move', () => {
  const movedEarlier = { ...held, moved: { at: isoAt(0), wasClock: isoAt(20), cause: 'pace', ids: [] } };
  const result = nextCommitment(movedEarlier, FRESH, 40, context(['a', 'b', 'c']));
  assert.equal(result.commit, movedEarlier);
  assert.equal(result.entry, null);
});

test('nextCommitment moves later when more than 5 min less is left than the fresh p50; added rows are the cause first', () => {
  const { commit, entry } = nextCommitment(held, FRESH, 30, context(['a', 'b', 'c', 'd'], 'a'));
  assert.deepEqual(commit, { at: isoAt(30), budgetMin: 40, ids: ['a', 'b', 'c', 'd'], moved: { at: isoAt(30), wasClock: isoAt(60), cause: 'rows-added', ids: ['c', 'd'] } });
  assert.equal(entry.first, false);
  assert.equal(entry.cause, 'rows-added');
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

const scoredFirst = (ratio, met = true) => ({ first: true, raw85: 1, model: MODEL_ID, scored: { ratio, met } });

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
