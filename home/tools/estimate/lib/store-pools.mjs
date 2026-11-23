// What model s1 learns from the store and the repo's seed (estimate-spec R2, section 5b): the agent runs that make the kind pools,
// with the seed runs a store table already holds left out, and the scored steps that refit the conformal margin.
// Exports: seedTablesInStore(seedRuns, tables) -> string[], poolRuns(tables, seedRuns) -> { k, runMin }[], scoredSteps(tables),
// recordSteps(stored, now, closedAtOf, clock) (the table's step records), scoredPromiseLog(log, promise, items, intervals) and
// promiseRecord(log) (the promises scored at their hand-over).
// Dedupe (README "Backtest and seed"): the store already holds the frozen tables once their rows carry `k` and `runMin`, so a
// seed table `tN` is in the store when one store table has, for every run of `tN`, a row of the same kind `k` whose done minute
// (epoch) minus the run's `doneMin` is one and the same shift; then every run of `tN` leaves the pool (freeze-data.mjs
// seedRunsWithout, the held-out rule's own helper). The key is the kind and the done minute, never `runMin` (the store measures
// its own run minutes). A table with no run, or a store with no s1 row, matches nothing: the seed then counts whole.
// Invariants: pure (no I/O, no clock); store rows without `k`/`runMin` (written before s1) feed no pool (kinds.mjs kindPools
// filters them) and match no seed run; malformed entries are skipped, never trusted.
import { seedRunsWithout } from './freeze-data.mjs';
import { workedMinutes } from './worked.mjs';

const MS_PER_MIN = 60_000;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const doneMinuteOf = (row) => Math.floor(Date.parse(row.done) / MS_PER_MIN);

/** Per kind, the set of done minutes of one store table's s1 rows. */
function doneMinutesByKind(table) {
  const byKind = new Map();
  for (const row of Array.isArray(table?.rows) ? table.rows : []) {
    if (!isPlainObject(row) || typeof row.k !== 'string' || typeof row.done !== 'string') continue;
    const minute = doneMinuteOf(row);
    if (!Number.isFinite(minute)) continue;
    if (!byKind.has(row.k)) byKind.set(row.k, new Set());
    byKind.get(row.k).add(minute);
  }
  return byKind;
}

/** True when every run has a row of its kind at its doneMin + one shift in the table (the first run proposes each shift). */
function holdsAll(runs, byKind) {
  const [first, ...rest] = runs;
  for (const minute of byKind.get(first.k) ?? []) {
    const shift = minute - first.doneMin;
    if (rest.every((run) => byKind.get(run.k)?.has(run.doneMin + shift) === true)) return true;
  }
  return false;
}

/**
 * @param {{ t: string, k: string, doneMin: number }[]} seedRuns readSeedRuns rows
 * @param {object[]} tables the store tables (readAllTables), the current table's fresh rows included
 * @returns {string[]} the seed tables (`tN`) one store table already holds, in seed order
 */
export function seedTablesInStore(seedRuns, tables) {
  const byTable = new Map();
  for (const run of seedRuns) {
    if (!byTable.has(run.t)) byTable.set(run.t, []);
    byTable.get(run.t).push(run);
  }
  const stores = tables.map(doneMinutesByKind).filter((byKind) => byKind.size > 0);
  return [...byTable].filter(([, runs]) => stores.some((byKind) => holdsAll(runs, byKind))).map(([name]) => name);
}

/**
 * The runs the kind pools are made of: every store table's s1 rows and the seed runs no store table holds.
 * @param {object[]} tables the store tables, the current table's fresh rows included
 * @param {{ t: string, k: string, runMin: number, doneMin: number }[]} seedRuns readSeedRuns rows
 * @returns {{ k: string, runMin: number }[]} for kinds.mjs kindPools
 */
export function poolRuns(tables, seedRuns) {
  const stored = tables.flatMap((table) => (Array.isArray(table?.rows) ? table.rows : []))
    .filter((row) => isPlainObject(row) && typeof row.k === 'string' && Number.isFinite(row.runMin))
    .map((row) => ({ k: row.k, runMin: row.runMin }));
  const kept = seedTablesInStore(seedRuns, tables).reduce((runs, name) => seedRunsWithout(runs, name), seedRuns);
  return [...stored, ...kept.map((run) => ({ k: run.k, runMin: run.runMin }))];
}

/** Step records kept per table, the newest; 20 scored steps refit the margin (throughput.mjs MIN_SCORED_STEPS), so 200 is ten refits. */
const MAX_STEP_RECORDS = 200;
/** Scored promises the record line counts (spec section 7 `Record: last 10 jobs`). */
const RECORD_JOBS = 10;
const isStepRecord = (entry) => isPlainObject(entry) && typeof entry.road === 'string' && Number.isInteger(entry.step)
  && Number.isFinite(entry.atMs) && Number.isFinite(entry.p80Min) && (entry.truthMin === null || Number.isFinite(entry.truthMin));

/**
 * The table's step records after this run (the conformal margin's data, section 5b): the `now` road's current step is recorded
 * once, with s1's own 80% minutes from the first run that saw it current; every open record is scored when its step closed
 * (truthMin = working minutes from the record to the close). Malformed stored entries are dropped.
 * @param {unknown} stored the table's `steps` (an old table has none)
 * @param {{ road: string, step: number, p80Min: number } | null} now the now road's current step and its s1 80% minutes, or null
 * @param {(road: string, step: number) => number | null} closedAtOf when the step closed (epoch ms), null while it is open
 * @param {{ intervals: [number, number][], nowMs: number }} clock working intervals (epoch minutes) and now
 * @returns {{ road: string, step: number, atMs: number, p80Min: number, truthMin: number | null }[]} at most MAX_STEP_RECORDS
 */
export function recordSteps(stored, now, closedAtOf, { intervals, nowMs }) {
  const records = (Array.isArray(stored) ? stored : []).filter(isStepRecord).map((entry) => {
    if (entry.truthMin !== null) return entry;
    const closedMs = closedAtOf(entry.road, entry.step);
    if (closedMs === null) return entry;
    return { ...entry, truthMin: workedMinutes(intervals, entry.atMs / MS_PER_MIN, closedMs / MS_PER_MIN) };
  });
  const seen = now !== null && records.some((entry) => entry.road === now.road && entry.step === now.step);
  const added = now === null || seen ? [] : [{ road: now.road, step: now.step, atMs: nowMs, p80Min: now.p80Min, truthMin: null }];
  return [...records, ...added].slice(-MAX_STEP_RECORDS);
}

/**
 * The log with the job's promise scored once its hand-over is done (R9: a deliver row scores the promise): met when the working
 * minutes from the promise to the hand-over are within the promised work (pauses never count, E3).
 * @param {object[]} log the table's log
 * @param {{ atMs: number, p80Ms: number, workMin: number } | null} promise the stored promise (commitment.mjs shape) or null
 * @param {object[]} items parser items
 * @param {[number, number][]} intervals working intervals (epoch minutes)
 * @returns {object[]} the log, with one `{ model: 's1', at, promise, scored }` entry added for a newly handed-over promise
 */
export function scoredPromiseLog(log, promise, items, intervals) {
  if (!isPlainObject(promise) || !Number.isFinite(promise.atMs) || !Number.isFinite(promise.workMin)) return log;
  const at = new Date(promise.atMs).toISOString();
  if (log.some((entry) => entry?.model === 's1' && entry.at === at)) return log;
  let handOverMs = null;
  for (const item of items) {
    if (item.kind === 'deliver' && item.done !== null && item.done >= promise.atMs && (handOverMs === null || item.done < handOverMs)) handOverMs = item.done;
  }
  if (handOverMs === null) return log;
  const workedMin = workedMinutes(intervals, promise.atMs / MS_PER_MIN, handOverMs / MS_PER_MIN);
  return [...log, { model: 's1', at, promise: { p80Ms: promise.p80Ms, workMin: promise.workMin }, scored: { met: workedMin <= promise.workMin, workedMin, handedOverMs: handOverMs } }];
}

/** @returns {{ met: number, of: number } | null} the last RECORD_JOBS scored s1 promises of the log, null when none is scored */
export function promiseRecord(log) {
  const scored = log.filter((entry) => entry?.model === 's1' && typeof entry.scored?.met === 'boolean').slice(-RECORD_JOBS);
  return scored.length === 0 ? null : { met: scored.filter((entry) => entry.scored.met).length, of: scored.length };
}

/**
 * @param {object[]} tables the store tables
 * @returns {{ truthMin: number, p80Min: number }[]} every scored step of model s1 of every table (throughput.mjs conformalMargin)
 */
export const scoredSteps = (tables) => tables.flatMap((table) => (Array.isArray(table?.steps) ? table.steps : []))
  .filter((step) => isPlainObject(step) && Number.isFinite(step.truthMin) && Number.isFinite(step.p80Min))
  .map((step) => ({ truthMin: step.truthMin, p80Min: step.p80Min }));
