// Purpose: the smart check's learning step (spec r9-smart-check 7; round 2, 11.2-11.4): a readable logistic regression per check kind,
//   trained on the ledger once a kind has MIN_LABELLED labelled changes, that predicts "the next heavier level finds something the
//   planned level misses"; plus the 20% exploration pick. The model may only raise a level, never lower one.
// Exports: featuresOf(facts), trainModels(rows, dir), loadModels(dir), modelRaises(models, kind, features), explorePick(rows, random),
//   MIN_LABELLED, EXPLORE_SHARE.
// Invariants: rules are the floor: modelRaises answers only "raise" or "keep"; pinned checks and security are never in its reach; a kind
//   with two escapes in 30 days is rule-only until the next training (round 2, 11.4). Training is deterministic (fixed steps, zero
//   start), reads only the ledger and writes only <dir>/model.json; a bad or missing model file means rules only.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIN_LABELLED = 200; // labelled changes per kind before a model is trusted (round 2, 11.2: about 200)
export const EXPLORE_SHARE = 0.2; // owner, 2026-11-21: exploration share 20%
const FEATURES = ['added', 'deleted', 'files', 'dirs', 'newFiles', 'exportsChanged', 'newImports', 'risky', 'cssLayout', 'cssGlobal', 'hooks', 'global'];
const STEPS = 400;
const RATE = 0.1;
const L2 = 0.01;
const RAISE_AT = 0.5;
const GUARD_DAYS = 30;
const GUARD_ESCAPES = 2;
const DAY_MS = 86_400_000;
const LOG_SCALE = new Set(['added', 'deleted', 'files', 'dirs']);
const NEVER_MODELLED = new Set(['security']);
const EXPLORABLE = ['types', 'lint', 'build', 'tests', 'review', 'visual'];

/** The model features of one change (counts on a log scale, flags as 0/1). */
export function featuresOf(facts) {
  const raw = {
    added: facts.stats.added, deleted: facts.stats.deleted, files: facts.stats.files, dirs: facts.stats.dirs, newFiles: facts.stats.newFiles,
    exportsChanged: facts.code.exportsChanged.length, newImports: facts.code.newImports.length, risky: facts.riskyClasses.length,
    cssLayout: facts.css.layout.length > 0 ? 1 : 0, cssGlobal: facts.css.scope === 'global' ? 1 : 0, hooks: facts.triggers.hooks.length > 0 ? 1 : 0,
    global: facts.triggers.global.length > 0 ? 1 : 0,
  };
  return FEATURES.map((name) => (LOG_SCALE.has(name) ? Math.log1p(raw[name]) : Math.min(raw[name], 5)));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const score = (model, x) => sigmoid(model.bias + model.weights.reduce((sum, w, i) => sum + w * (x[i] ?? 0), 0));

/** Gradient descent on the log loss with an L2 penalty. */
function fit(samples) {
  const model = { weights: FEATURES.map(() => 0), bias: 0 };
  for (let step = 0; step < STEPS; step += 1) {
    const grad = FEATURES.map(() => 0);
    let gradBias = 0;
    for (const { x, y } of samples) {
      const error = score(model, x) - y;
      x.forEach((value, i) => { grad[i] += error * value; });
      gradBias += error;
    }
    model.weights = model.weights.map((w, i) => w - RATE * (grad[i] / samples.length + L2 * w));
    model.bias -= RATE * (gradBias / samples.length);
  }
  return model;
}

/** Labelled samples of one kind: the change's features and 1 when a heavier level found what the planned level missed. */
function samplesOf(rows, kind) {
  const positive = new Set(rows.filter((row) => row.type === 'truth' && row.check === kind && (row.truth === 'escape' || (row.truth === 'catch' && row.source !== 'planned'))).map((row) => row.change));
  const labelled = new Set(rows.filter((row) => row.type === 'truth' && row.check === kind).map((row) => row.change));
  const seen = new Set();
  return rows.filter((row) => row.type === 'run' && row.check === kind && Array.isArray(row.features) && labelled.has(row.change) && !seen.has(row.change) && seen.add(row.change))
    .map((row) => ({ x: row.features, y: positive.has(row.change) ? 1 : 0, ts: row.ts }));
}

/**
 * Trains one model per kind with enough labels and writes <dir>/model.json; the newest week is held out to measure recall.
 * @param {object[]} rows the ledger
 * @param {string} dir the state folder
 * @returns {string} a readable summary: per kind the sample count, held-out recall and the coefficients
 */
export function trainModels(rows, dir) {
  const kinds = {};
  const lines = [];
  const weekAgo = Date.now() - 7 * DAY_MS;
  for (const kind of EXPLORABLE) {
    const samples = samplesOf(rows, kind);
    if (samples.length < MIN_LABELLED) { lines.push(`${kind}: ${samples.length}/${MIN_LABELLED} labelled changes: rules only`); continue; }
    const train = samples.filter((s) => Date.parse(s.ts) < weekAgo);
    const held = samples.filter((s) => Date.parse(s.ts) >= weekAgo && s.y === 1);
    const model = fit(train.length ? train : samples);
    const recall = held.length ? held.filter((s) => score(model, s.x) >= RAISE_AT).length / held.length : null;
    kinds[kind] = { ...model, features: FEATURES, n: samples.length, recall };
    lines.push(`${kind}: n=${samples.length}, held-out recall ${recall === null ? 'n/a' : recall.toFixed(2)}, bias ${model.bias.toFixed(2)}, ${FEATURES.map((f, i) => `${f} ${model.weights[i].toFixed(2)}`).join(', ')}`);
  }
  writeFileSync(join(dir, 'model.json'), `${JSON.stringify({ trainedAt: new Date().toISOString(), kinds })}\n`, { mode: 0o600 });
  return lines.join('\n');
}

/** The trained models, or {} (rules only) when there is none or it cannot be read. */
export function loadModels(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));
    return parsed && typeof parsed.kinds === 'object' ? parsed.kinds : {};
  } catch {
    return {};
  }
}

/** Kinds with GUARD_ESCAPES escapes within GUARD_DAYS: the model is off for them (round 2, 11.4). */
export function guardedKinds(rows, nowMs = Date.now()) {
  const since = nowMs - GUARD_DAYS * DAY_MS;
  const counts = {};
  for (const row of rows) if (row.type === 'truth' && row.truth === 'escape' && Date.parse(row.ts) >= since) counts[row.check] = (counts[row.check] ?? 0) + 1;
  return new Set(Object.keys(counts).filter((kind) => counts[kind] >= GUARD_ESCAPES));
}

/** True when the model of `kind` says to raise its level for these features. */
export function modelRaises(models, kind, features, guarded = new Set()) {
  const model = models[kind];
  if (!model || NEVER_MODELLED.has(kind) || guarded.has(kind) || !Array.isArray(model.weights)) return false;
  return score(model, features) >= RAISE_AT;
}

/**
 * The exploration pick of one change: in EXPLORE_SHARE of changes, one explorable kind (at random) runs one level heavier.
 * @param {{check: string, level: string, by: string}[]} rows the plan rows
 * @param {() => number} random a [0, 1) source (Math.random; tests pass a fixed one)
 * @returns {string | null} the kind to raise, or null
 */
export function explorePick(rows, random = Math.random) {
  if (random() >= EXPLORE_SHARE) return null;
  const candidates = rows.filter((row) => EXPLORABLE.includes(row.check) && row.level !== 'full' && row.by === 'rule' && !/^no .* (in this repo|changed|reached)/.test(row.reason));
  return candidates.length ? candidates[Math.floor(random() * candidates.length)].check : null;
}
