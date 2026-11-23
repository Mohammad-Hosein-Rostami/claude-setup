// The current job's rows (estimate-spec R15, R8, R9) and the numbers the status line cache stores for it (R10, section 12).
// Exports: MAX_CACHE_ROWS, LATE_MIN, jobScope(items, lastHandOver), likelyLeftMin(pool, elapsedMin), promiseRows(rows, facts),
// roundUpMs(ms), jobNumbers(job, view).
// Scope (R15, the PC case: 26 of 27 rows were another session's paused road): the job is every non-road work row open now or done
// after the last hand-over, plus every row of each road with at least one row started (or done) after the last hand-over; any
// other road with open rows is queued (out of the job total and the promise, named once). A road joins the job when its first
// row starts. A parked row is out of every number (kinds.mjs rowState); a road whose open rows are all parked is not queued, it is
// parked. No row is carried over a hand-over any more (R8): rows nobody works on are parked (R3), not guessed from first sightings.
// Numbers v2 (spec section 12): every clock rounded up to 5 minutes here and nowhere else (R10); the R18 fields (finishMs, p85Ms,
// leftMin, rows ...) stay beside `v2` for one model change, filled from s1, so an old reader still draws the job.
// Invariants: pure (no I/O, no clock). Times are epoch ms, work in minutes.
import { nearestRank } from './forecast.mjs';
import { AGENT_KINDS, kindOf, rowState } from './kinds.mjs';
import { roadStepOf } from './road-steps.mjs';

/** Open rows kept in the cache numbers, started rows first: a cache entry stays well under its byte cap on a table of hundreds of rows. */
export const MAX_CACHE_ROWS = 64;
/** A job runs late once it is this many working minutes past its promise: a smaller difference is the 5-minute grid, not news. */
export const LATE_MIN = 10;
const MS_PER_MIN = 60_000;
/** R10: the numbers carry clocks rounded up to this grid (every real time zone's offset is a whole number of 5 minutes). */
const CLOCK_GRID_MS = 5 * MS_PER_MIN;
const TENTHS = 10;
const MEDIAN = 0.5;
/** The late reasons as the R18 readers name them (board/lib/work-row.mjs causeText): a row over usual is a slow row. */
const R18_CAUSE = { 'rows-added': 'rows-added', 'over-usual': 'slow-row', faster: 'ahead' };
const tenths = (minutes) => Math.round(minutes * TENTHS) / TENTHS;
const isWorkRow = (item) => item.kind !== 'deliver';
const afterHandOver = (ms, lastHandOver) => ms !== null && ms !== undefined && (lastHandOver === null || ms > lastHandOver);

/** @returns {number | null} ms rounded up to the 5-minute grid (R10), null stays null */
export const roundUpMs = (ms) => (Number.isFinite(ms) ? Math.ceil(ms / CLOCK_GRID_MS) * CLOCK_GRID_MS : null);

/**
 * The current job (R15).
 * @param {object[]} items parser items
 * @param {number | null} lastHandOver the last hand-over (epoch ms), null when none
 * @returns {{ items: object[], roads: string[], queued: { road: string, rows: number }[] }} items: the job's rows in table order
 *   (a joined road with all its rows, so its steps read right; deliver rows left out); roads: the joined roads; queued: the
 *   roads left out with their open, unparked rows
 */
export function jobScope(items, lastHandOver) {
  const work = items.filter(isWorkRow);
  const joined = new Set();
  const openOf = new Map();
  for (const item of work) {
    const road = roadStepOf(item.id)?.road;
    if (road === undefined) continue;
    if (afterHandOver(item.started, lastHandOver) || afterHandOver(item.done, lastHandOver)) joined.add(road);
    if (rowState(item) === 'open') openOf.set(road, (openOf.get(road) ?? 0) + 1);
  }
  const inJob = (item) => {
    const road = roadStepOf(item.id)?.road;
    return road === undefined ? item.done === null || afterHandOver(item.done, lastHandOver) : joined.has(road);
  };
  const queued = [...openOf].filter(([road]) => !joined.has(road)).map(([road, rows]) => ({ road, rows }));
  return { items: work.filter(inJob), roads: [...joined], queued };
}

/**
 * A row's likely working minutes left: the median of its kind's runs longer than what it has run, minus that; the pool's median
 * when none is longer (the row counts as one fresh run, R5).
 * @param {number[]} pool its kind's sorted run minutes (kindPools)
 * @param {number} elapsedMin the working (or its agent's active) minutes it has run, 0 when not started
 * @returns {number} minutes, at least 0
 */
export function likelyLeftMin(pool, elapsedMin) {
  const longer = pool.filter((value) => value > elapsedMin);
  return longer.length === 0 ? nearestRank(pool, MEDIAN) : Math.max(0, nearestRank(longer, MEDIAN) - elapsedMin);
}

/**
 * Each row of the job with its likely working minutes, for the promise and its difference (commitment.mjs promiseOf, promiseDiff):
 * a done row its own run, an open agent row what it ran plus its likely minutes left, a lead row 0; parked and waiting rows are out
 * of the work clock and left out.
 * @param {object[]} rows the job's rows (jobScope items)
 * @param {{ poolOf: (kind: string) => number[], elapsedOf: (item: object) => number, runOf: (item: object) => number }} facts
 * @returns {{ id: string, likelyMin: number }[]}
 */
export function promiseRows(rows, { poolOf, elapsedOf, runOf }) {
  return rows.flatMap((item) => {
    const state = rowState(item);
    if (state === 'parked' || state === 'waiting') return [];
    const kind = kindOf(item);
    if (state === 'done') return [{ id: item.id, likelyMin: runOf(item) }];
    if (!AGENT_KINDS.includes(kind)) return [{ id: item.id, likelyMin: 0 }];
    const elapsed = elapsedOf(item);
    return [{ id: item.id, likelyMin: elapsed + likelyLeftMin(poolOf(kind), elapsed) }];
  });
}

/** The R18 late cause of the promise difference's largest later reason (its ids cut to MAX_CACHE_ROWS, count = all of them). */
function lateCauseOf(diff) {
  const reason = diff?.reasons.find((each) => each.min > 0);
  return reason === undefined ? null : { cause: R18_CAUSE[reason.kind], ids: reason.ids.slice(0, MAX_CACHE_ROWS), count: reason.ids.length };
}

/** A range of minutes from now as the numbers carry it: minutes in tenths, clocks rounded up (R10). */
const rangeOf = (range, nowMs) => ({
  p50Min: tenths(range.p50), p80Min: tenths(range.p80),
  p50Ms: roundUpMs(nowMs + range.p50 * MS_PER_MIN), p80Ms: roundUpMs(nowMs + range.p80 * MS_PER_MIN),
});

/** The v2 diff: minutes and reasons with their ids cut to MAX_CACHE_ROWS (count = all). */
const cachedDiff = (diff) => (diff === null ? null : {
  min: tenths(diff.min),
  reasons: diff.reasons.map((reason) => ({ kind: reason.kind, min: tenths(reason.min), ids: reason.ids.slice(0, MAX_CACHE_ROWS), count: reason.ids.length })),
});

/**
 * The numbers of the status line cache (spec section 12, `numbers.v2`, plus the R18 fields for one model change).
 * @param {{ nowMs: number, workedMin: number, rows: { id: string, done: boolean, expectMin: number, leftMin: number, startedMs: number | null }[] }} job
 *   the job's unheld rows with their kind's median (expectMin) and likely minutes left
 * @param {{ job: { p50: number, p80: number }, step: object | null, waiting: number, parked: number, stalled: string[],
 *   promise: { atMs: number, p80Ms: number, workMin: number } | null, diff: object | null, pauses: { min: number, byReason: object } }} view
 *   step: { road, step, steps, lanesDone, lanesTotal, p50, p80 } (minutes from now) or null without a road
 * @returns {object} the numbers (see the header); JSON-safe, small (rows capped at MAX_CACHE_ROWS)
 */
export function jobNumbers(job, view) {
  const jobRange = rangeOf(view.job, job.nowMs);
  const step = view.step === null ? null : { road: view.step.road, step: view.step.step, steps: view.step.steps, lanesDone: view.step.lanesDone, lanesTotal: view.step.lanesTotal, ...rangeOf(view.step, job.nowMs) };
  const promise = view.promise === null ? null : { atMs: view.promise.atMs, p80Ms: roundUpMs(view.promise.p80Ms), movedMs: roundUpMs(view.promise.p80Ms + view.pauses.min * MS_PER_MIN) };
  const lateMin = view.diff !== null && view.diff.min >= LATE_MIN ? tenths(view.diff.min) : null;
  const open = job.rows.filter((row) => !row.done).sort((a, b) => (a.startedMs === null) - (b.startedMs === null)).slice(0, MAX_CACHE_ROWS);
  return {
    finishMs: jobRange.p50Ms, p85Ms: jobRange.p80Ms, leftMin: jobRange.p50Min, workedMin: tenths(job.workedMin),
    rowsDone: job.rows.filter((row) => row.done).length, rowsTotal: job.rows.length,
    firstBudgetMin: view.promise === null ? null : tenths(view.promise.workMin), lateMin, lateCause: lateMin === null ? null : lateCauseOf(view.diff),
    rows: open.map((row) => ({ id: row.id, expectMin: tenths(row.expectMin), leftMin: tenths(row.leftMin), startedMs: row.startedMs })),
    v2: {
      model: 's1', job: jobRange, step, waiting: view.waiting, parked: view.parked, stalled: view.stalled.slice(0, MAX_CACHE_ROWS),
      promise, diff: cachedDiff(view.diff),
      pauses: { min: tenths(view.pauses.min), byReason: Object.fromEntries(Object.entries(view.pauses.byReason).map(([reason, min]) => [reason, tenths(min)])) },
    },
  };
}
