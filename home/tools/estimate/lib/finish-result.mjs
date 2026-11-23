// The finish result of model s1 and the store change every run makes (estimate-spec sections 4-7, 12): split out of from-files.mjs,
// which reads the inputs and picks the state.
// Exports: forecastSeedText(id, openRows), runMinOf(item, intervals), promiseJobKey(id, lastHandOver), settle(statusPath, items,
// facts, options, change), finishResult(items, scope, facts, options).
// Flow of a finish: the slots (measuredSlots, with the stall context), the s1 runs of the job's rows (forecastRuns, with each
// row's agent), the `now` road's current step by the pick (stepRange of s1 and throughput, plus the conformal margin of the
// store's scored steps), then under the table lock the store change and the promise (promiseOf), then the pauses since the
// promise with their reasons and the promise's difference in working minutes (promiseDiff: a pause is never lateness, E3).
// The job's range is s1's, never shorter than its current step's pick (a job cannot end before its current step).
// Job (owner question 2 of the spec is still open): a promise belongs to the job after the last hand-over (promiseJobKey), the
// boundary the c3 commitment had; answer (a) "a hand-over only checks the promise" changes promiseJobKey alone.
// Invariants: the change passed to settle is quick (no scan, no simulation: the table lock is taken as abandoned after 0.5 s);
// the numbers round every clock once (job-rows.mjs); a held row (parked, waiting) leaves every work number.
import { cappedLog, promiseDiff, promiseOf, scoreLog } from './commitment.mjs';
import { nearestRank } from './forecast.mjs';
import { jobNumbers, likelyLeftMin, promiseRows } from './job-rows.mjs';
import { nowRoadOf, pauseSummary, queuedChecks, roadView, stalledChecks } from './job-view.mjs';
import { AGENT_KINDS, kindOf, rowState } from './kinds.mjs';
import { pausesOf } from './pauses.mjs';
import { progressOf } from './progress.mjs';
import { roadStepOf, roadsOf } from './road-steps.mjs';
import { DEFAULT_SLOTS, forecastRuns, measuredSlots } from './slots.mjs';
import { promiseRecord, recordSteps, scoredPromiseLog } from './store-pools.mjs';
import { updateTable } from './table-store.mjs';
import { conformalMargin, stepRange, throughputForecast } from './throughput.mjs';
import { elapsedShares, workedMinutes } from './worked.mjs';

const MS_PER_MIN = 60_000;
const MEDIAN = 0.5;
/** Working minutes of the job with no started row before a Check line asks for starts (design 3.2, 3.10). */
const UNTRACKED_CHECK_MIN = 30;
const SIZES = ['S', 'M', 'L'];
const iso = (ms) => new Date(ms).toISOString();
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The forecast's seed text: the table and its open ids, so the same table state draws the same runs everywhere (design 3.6). */
export const forecastSeedText = (id, openRows) => `${id}|${openRows.map((row) => row.id).sort().join(',')}`;

/** A done row's run: its working minutes from start to done (0 without a start), as the seed runs measure them (freeze-data.mjs). */
export const runMinOf = (item, intervals) => (item.started === null || item.done === null ? 0 : workedMinutes(intervals, item.started / MS_PER_MIN, item.done / MS_PER_MIN));

/** The promise's job key (commitment.mjs promiseOf): the table and its last hand-over, so each hand-over starts a job (see the header). */
export const promiseJobKey = (id, lastHandOver) => `${id}|${lastHandOver === null ? 'first' : iso(lastHandOver)}`;

/** The stored table in the new shape (F1): fresh rows and jobs, no c3 commit, the old c3 entries and the promise scored. */
function baseTable(table, items, facts) {
  const log = cappedLog(scoredPromiseLog(scoreLog(Array.isArray(table.log) ? table.log : [], items, facts.intervals), table.promise ?? null, items, facts.intervals));
  return { ...table, rows: facts.own.rows, jobs: facts.own.jobs, commit: null, log, promise: table.promise ?? null, steps: Array.isArray(table.steps) ? table.steps : [], waitSeen: isPlainObject(table.waitSeen) ? table.waitSeen : {} };
}

/**
 * Runs `change` on the stored table under its lock when recording; else (or when the lock is busy) on the table as read.
 * @param {(table: object, locked: boolean) => object} change gets the table in the new shape and whether it runs under the lock
 * @returns {{ table: object, recorded: boolean }}
 */
export function settle(statusPath, items, facts, options, change) {
  if (options.record) {
    const stored = updateTable(options.stateDir, statusPath, (table) => change(baseTable(table, items, facts), true));
    if (stored !== undefined) return { table: stored, recorded: true };
  }
  return { table: change(baseTable(facts.stored ?? { commit: null, log: [] }, items, facts), false), recorded: false };
}

/** When a road's step closed (its gate rows' last done, else its rows' last done), null while it is open or unknown. */
function closedAtOf(allRoads) {
  return (road, step) => {
    const entry = allRoads.get(road);
    if (entry === undefined || (entry.current !== null && entry.current <= step)) return null;
    const rows = entry.rowsOf.get(step) ?? [];
    const gates = rows.filter((row) => roadStepOf(row.id)?.check === true);
    let closed = null;
    for (const row of gates.length > 0 ? gates : rows) if (row.item.done !== null && (closed === null || row.item.done > closed)) closed = row.item.done;
    return closed;
  };
}

/** The `now` road's current step: s1's range and the pick (stepRange), with its view; null without a road. */
function roadPartOf(items, scope, runs, facts, seedText) {
  const name = nowRoadOf(scope.items, Object.keys(runs.roads), (id) => roadStepOf(id)?.road);
  if (name === null) return null;
  const runRoad = runs.roads[name];
  const s1 = runRoad.steps[runRoad.current];
  const thru = throughputForecast(items, runRoad.currentRows, facts.nowMs, seedText);
  const pick = stepRange(s1, thru, conformalMargin(facts.scored));
  return { ...roadView(roadsOf(scope.items, rowState).get(name), runRoad, pick, facts.nowMs), s1 };
}

/** The forecast of the job's rows: slots, runs, the road part and the job's range. */
function forecastOf(items, scope, facts) {
  const context = { pools: facts.pools, intervals: facts.intervals, rowAgents: facts.rowAgents, nowMs: facts.nowMs };
  const slots = measuredSlots(items, facts.nowMs, context) ?? DEFAULT_SLOTS;
  const seedText = forecastSeedText(facts.id, scope.items.filter((item) => item.done === null));
  const runs = forecastRuns(scope.items, { ...context, slots, seedText });
  const road = roadPartOf(items, scope, runs, facts, seedText);
  const job = road === null ? runs.job : { p50: Math.max(runs.job.p50, road.step.p50), p80: Math.max(runs.job.p80, road.step.p80) };
  return { slots, runs, road, job };
}

/** The job's rows that count (not parked, not waiting) with the numbers' per-row fields. */
function rowNumbers(rows, helpers) {
  return rows.filter((item) => ['open', 'done'].includes(rowState(item))).map((item) => {
    const kind = kindOf(item);
    const pool = AGENT_KINDS.includes(kind) ? helpers.poolOf(kind) : null;
    const expectMin = pool === null ? 0 : nearestRank(pool, MEDIAN);
    const leftMin = item.done !== null || pool === null ? 0 : likelyLeftMin(pool, helpers.elapsedOf(item));
    return { id: item.id, size: item.size, done: item.done !== null, expectMin, leftMin, elapsedMin: helpers.elapsedOf(item), startedMs: item.started };
  });
}

/** The earliest start of the job's rows after the last hand-over (epoch ms), null before any. */
function jobStartOf(rows, lastHandOver) {
  let start = null;
  for (const item of rows) if (item.started !== null && (lastHandOver === null || item.started > lastHandOver) && (start === null || item.started < start)) start = item.started;
  return start;
}

/** The Check facts: stalled rows (R5), untracked work, queued roads (R15). */
function checksOf(items, scope, forecast, facts, helpers) {
  const { untrackedMin } = elapsedShares(items, facts.intervals, facts.nowMs / MS_PER_MIN);
  return [
    ...stalledChecks(forecast.runs.stalled, scope.items, { rowAgents: facts.rowAgents, elapsedOf: helpers.elapsedOf, countedOf: (kind) => nearestRank(helpers.poolOf(kind), MEDIAN) }),
    ...(untrackedMin >= UNTRACKED_CHECK_MIN ? [{ kind: 'untracked', minutes: untrackedMin }] : []),
    ...queuedChecks(scope.queued),
  ];
}

/** The promise, its difference and the pauses since it, after the store change. */
function promiseFacts(table, facts, forecast, rowsNow, jobStartMs) {
  const promise = table.promise;
  const nowMin = facts.nowMs / MS_PER_MIN;
  const workedSinceMin = promise === null ? 0 : workedMinutes(facts.intervals, promise.atMs / MS_PER_MIN, nowMin);
  const diff = promise === null ? null : promiseDiff(promise, { workLeftMin: forecast.job.p80 }, workedSinceMin, rowsNow, promise.rows);
  const waits = Object.entries(table.waitSeen).map(([, at]) => ({ fromMs: Date.parse(at), toMs: facts.nowMs }));
  const sinceMs = promise?.atMs ?? jobStartMs ?? facts.nowMs;
  const pauses = pauseSummary(pausesOf(facts.runs, [...facts.asks, ...waits], facts.limits, sinceMs, facts.nowMs));
  return { promise, workedSinceMin, diff, pauses };
}

/**
 * The finish result (see the header and from-files.mjs).
 * @param {object[]} items every parser item of the table
 * @param {ReturnType<import('./job-rows.mjs').jobScope>} scope the current job (R15)
 * @param {object} facts from-files.mjs measure() with jobInputs (rowAgents, asks, limits) and nowMs
 * @param {object} options from-files.mjs's run options (statusPath, record, stateDir, cli, realClock, nowMin)
 * @returns {{ result: object, recorded: boolean }}
 */
export function finishResult(items, scope, facts, options) {
  const { nowMs } = facts;
  const forecast = forecastOf(items, scope, facts);
  const helpers = {
    poolOf: (kind) => (facts.pools[kind]?.length > 0 ? facts.pools[kind] : facts.pools.agent),
    elapsedOf: (item) => (item.started === null ? 0 : facts.rowAgents.get(item.id)?.activeMin ?? workedMinutes(facts.intervals, item.started / MS_PER_MIN, options.nowMin)),
    runOf: (item) => runMinOf(item, facts.intervals),
  };
  const rowsNow = promiseRows(scope.items, helpers);
  const fresh = { job: promiseJobKey(facts.id, facts.lastHandOver), p80Ms: nowMs + forecast.job.p80 * MS_PER_MIN, workLeftMin: forecast.job.p80, rows: rowsNow };
  const stepNow = forecast.road === null ? null : { road: forecast.road.step.road, step: forecast.road.step.step, p80Min: forecast.road.s1.p80 };
  const allRoads = roadsOf(items, rowState);
  const { table, recorded } = settle(options.statusPath, items, facts, options, (base, locked) => ({
    ...base,
    promise: promiseOf(base.promise, { ...fresh, run: { cli: options.cli, realClock: options.realClock, recorded: locked } }, nowMs),
    steps: recordSteps(base.steps, stepNow, closedAtOf(allRoads), { intervals: facts.intervals, nowMs }),
    waitSeen: Object.fromEntries(forecast.runs.waiting.map((row) => [row.id, typeof base.waitSeen[row.id] === 'string' ? base.waitSeen[row.id] : iso(nowMs)])),
  }));
  const jobStartMs = jobStartOf(scope.items, facts.lastHandOver);
  const told = promiseFacts(table, facts, forecast, rowsNow, jobStartMs);
  const rows = rowNumbers(scope.items, helpers);
  const workedMin = jobStartMs === null ? 0 : workedMinutes(facts.intervals, jobStartMs / MS_PER_MIN, options.nowMin);
  const waiting = forecast.runs.waiting.map((row) => ({ ...row, sinceMs: Date.parse(table.waitSeen[row.id] ?? '') || null }));
  const numbers = jobNumbers({ nowMs, workedMin, rows }, {
    job: forecast.job, step: forecast.road?.step ?? null, waiting: waiting.length, parked: forecast.runs.parked.length, stalled: forecast.runs.stalled,
    promise: told.promise, diff: told.diff, pauses: told.pauses,
  });
  const progress = progressOf({
    workedMin, p50LeftMin: forecast.job.p50, committedLeftMin: told.promise === null ? null : told.promise.workMin - told.workedSinceMin,
    rows, pool: { medians: {} }, moved: false, rowsAdded: told.diff?.reasons.some((reason) => reason.kind === 'rows-added' && reason.min > 0) ?? false,
  });
  const open = rows.filter((row) => !row.done && AGENT_KINDS.includes(kindOf(scope.items.find((item) => item.id === row.id))));
  return {
    result: {
      state: 'finish', model: 's1', nowMs,
      finish: { clockMs: numbers.finishMs, p85Ms: numbers.p85Ms, lateMs: numbers.p85Ms },
      commit: { atMs: told.promise?.atMs ?? nowMs, budgetMin: forecast.job.p50, leftMin: forecast.job.p50, pausedMin: told.pauses.min, moved: null },
      work: { p50: forecast.job.p50, p85: forecast.job.p80, p95: forecast.job.p80 },
      covers: { open: open.length, running: open.filter((row) => row.startedMs !== null).length, sizes: Object.fromEntries(SIZES.map((size) => [size, open.filter((row) => row.size === size).length])), growth: facts.growth },
      job: forecast.job, roads: forecast.runs.roads, slots: forecast.slots, stalled: forecast.runs.stalled, parked: forecast.runs.parked, waiting,
      queued: scope.queued, followups: forecast.runs.followups, promise: told.promise, diff: told.diff, pauses: told.pauses,
      band: null, record: promiseRecord(table.log), pool: { rows: facts.runCount, jobs: facts.jobCount },
      checks: checksOf(items, scope, forecast, facts, helpers),
      progress: forecast.road === null ? progress : { ...progress, road: forecast.road.progressRoad },
      numbers,
      ...(forecast.road === null ? {} : { road: forecast.road.view }),
    },
    recorded,
  };
}
