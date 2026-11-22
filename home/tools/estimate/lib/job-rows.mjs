// Two views of the current job's rows that the estimate adds to its result: the rows carried over a hand-over (left out of the
// forecast, named in a Check line) and the numbers the status line cache stores per job and per open row.
// Exports: carriedIds(items, added, lastHandOver) -> string[]; lateFacts(commit, intervals, nowMin, leftMin) -> the late inputs of
// jobNumbers; jobNumbers(job, medians, finish, rowLeft) -> numbers; MAX_CACHE_ROWS.
// Carried (backtest section 7 item 1 (i)): an open work row first seen before the last hand-over that has not started since. Such
// rows still counted after a hand-over and added +89 min per job on 15 replayed jobs. Without a first-seen record (no store, an old
// table) a row is never carried: nothing is dropped on a guess. A road row (`<road>.s<N>.`) is never carried: a road lists every
// step's rows at its start (spec-stages section 7).
// Invariants: pure (no I/O, no clock). Times are epoch ms, work in minutes.
import { firstCommitmentOf } from './commitment.mjs';
import { expectedMinutes } from './progress.mjs';
import { roadStepOf } from './road-steps.mjs';
import { workedMinutes } from './worked.mjs';

/** Open rows kept in the cache numbers, started rows first: a cache entry stays well under its byte cap on a table of hundreds of rows. */
export const MAX_CACHE_ROWS = 64;
/** A job runs late once the shown budget is this many minutes over its first one: a smaller overrun is the 5-minute clock grid and
 *  the hold band's wobble, not news (spec R18 U4 default). */
const LATE_MIN = 10;
const MS_PER_MIN = 60_000;
const TENTHS = 10;
const tenths = (minutes) => Math.round(minutes * TENTHS) / TENTHS;
const isOpenWorkRow = (item) => item.kind !== 'deliver' && item.done === null;
const floorToMinuteMs = (ms) => Math.floor(ms / MS_PER_MIN) * MS_PER_MIN;

/**
 * @param {object[]} items parser items
 * @param {Record<string, string>} added the store's first-seen times (ISO) per row id; {} without a store
 * @param {number | null} lastHandOver the last hand-over (epoch ms), null when none
 * @returns {string[]} ids of the carried rows, in item order
 */
export function carriedIds(items, added, lastHandOver) {
  if (lastHandOver === null) return [];
  return items.filter((item) => {
    if (!isOpenWorkRow(item) || !Object.hasOwn(added, item.id) || roadStepOf(item.id) !== null) return false;
    const seenMs = floorToMinuteMs(Date.parse(added[item.id]));
    return seenMs < lastHandOver && (item.started === null || item.started <= lastHandOver);
  }).map((item) => item.id);
}

/**
 * The job's first budget and how far the shown budget runs over it.
 * @param {object} commit the shown commitment (commitment.mjs)
 * @param {[number, number][]} intervals working intervals (epoch minutes)
 * @param {number} nowMin now, epoch minutes
 * @param {number} leftMin the shown budget left
 * @returns {{ firstBudgetMin: number | null, overFirstMin: number | null, laterCause: { cause: string, ids: string[] } | null }}
 *   overFirstMin = minutes worked since the first commitment + leftMin - the first budget; all null when the first is unknown
 */
export function lateFacts(commit, intervals, nowMin, leftMin) {
  const first = firstCommitmentOf(commit);
  if (first === null) return { firstBudgetMin: null, overFirstMin: null, laterCause: null };
  const overFirstMin = workedMinutes(intervals, Date.parse(first.at) / MS_PER_MIN, nowMin) + leftMin - first.budgetMin;
  return { firstBudgetMin: first.budgetMin, overFirstMin, laterCause: commit.laterCause ?? null };
}

/** The late cause for the cache: its ids cut to MAX_CACHE_ROWS (a 300-row job stays under the cache's byte cap), count = all of them. */
const cachedCause = (laterCause) => (laterCause === null ? null : { cause: laterCause.cause, ids: laterCause.ids.slice(0, MAX_CACHE_ROWS), count: laterCause.ids.length });

/**
 * The numbers of the status line cache (display design section 8, R60; spec R18): the shown finish, the work left and done, the row
 * counts, how late the job runs against its first commitment and why, and, per open row, its expected minutes (the size's pool
 * median), its own median minutes left and its start.
 * @param {{ workedMin: number, rows: { id: string, size: string, done: boolean, elapsedMin: number, startedMs: number | null }[] }} job the current job
 * @param {{ S?: number, M?: number, L?: number }} medians the pool's class medians
 * @param {{ finishMs: number | null, leftMin: number | null, p85Ms?: number | null, firstBudgetMin?: number | null,
 *   overFirstMin?: number | null, laterCause?: { cause: string, ids: string[] } | null }} finish the shown clock and the budget left
 *   (null on a refusal); firstBudgetMin the job's first budget, overFirstMin the minutes the shown budget runs over it, laterCause
 *   the cause of the latest later move (all null or missing when unknown)
 * @param {Record<string, number>} [rowLeft] forecastWork's median minutes left per open row ({} on a refusal)
 * @returns {{ finishMs: number | null, p85Ms: number | null, leftMin: number | null, workedMin: number, rowsDone: number, rowsTotal: number,
 *   firstBudgetMin: number | null, lateMin: number | null, lateCause: { cause: string, ids: string[], count: number } | null,
 *   rows: { id: string, expectMin: number, leftMin: number, startedMs: number | null }[] }} lateMin from LATE_MIN minutes over the
 *   first budget, else null (lateCause too); a row's leftMin is its forecast median in tenths of a minute, else (a refusal) its
 *   expected minutes less its elapsed share, at least 0
 */
export function jobNumbers(job, medians, finish, rowLeft = {}) {
  const open = job.rows.filter((row) => !row.done)
    .sort((a, b) => (a.startedMs === null) - (b.startedMs === null))
    .slice(0, MAX_CACHE_ROWS);
  const overFirstMin = finish.overFirstMin ?? null;
  const lateMin = overFirstMin !== null && overFirstMin >= LATE_MIN ? overFirstMin : null;
  const leftOf = (row, expectMin) => tenths(Object.hasOwn(rowLeft, row.id) ? rowLeft[row.id] : Math.max(0, expectMin - (row.elapsedMin ?? 0)));
  return {
    finishMs: finish.finishMs,
    p85Ms: finish.p85Ms ?? null,
    leftMin: finish.leftMin,
    workedMin: job.workedMin,
    rowsDone: job.rows.filter((row) => row.done).length,
    rowsTotal: job.rows.length,
    firstBudgetMin: finish.firstBudgetMin ?? null,
    lateMin,
    lateCause: lateMin === null ? null : cachedCause(finish.laterCause ?? null),
    rows: open.map((row) => {
      const expectMin = expectedMinutes(row.size, medians);
      return { id: row.id, expectMin, leftMin: leftOf(row, expectMin), startedMs: row.startedMs };
    }),
  };
}
