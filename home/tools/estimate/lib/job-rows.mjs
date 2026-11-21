// Two views of the current job's rows that the estimate adds to its result: the rows carried over a hand-over (left out of the
// forecast, named in a Check line) and the numbers the status line cache stores per job and per open row.
// Exports: carriedIds(items, added, lastHandOver) -> string[]; jobNumbers(job, medians, finish) -> numbers; MAX_CACHE_ROWS.
// Carried (backtest section 7 item 1 (i)): an open work row first seen before the last hand-over that has not started since. Such
// rows still counted after a hand-over and added +89 min per job on 15 replayed jobs. Without a first-seen record (no store, an old
// table) a row is never carried: nothing is dropped on a guess. A road row (`<road>.s<N>.`) is never carried: a road lists every
// step's rows at its start (spec-stages section 7).
// Invariants: pure (no I/O, no clock). Times are epoch ms, work in minutes.
import { expectedMinutes } from './progress.mjs';
import { roadStepOf } from './road-steps.mjs';

/** Open rows kept in the cache numbers, started rows first: a cache entry stays well under its byte cap on a table of hundreds of rows. */
export const MAX_CACHE_ROWS = 64;
const MS_PER_MIN = 60_000;
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
 * The numbers of the status line cache (display design section 8, R60): the shown finish, the work left and done, the row counts
 * and, per open row, its expected minutes (the agent bar's `of 43 min`) and its start.
 * @param {{ workedMin: number, rows: { id: string, size: string, done: boolean, startedMs: number | null }[] }} job the current job
 * @param {{ S?: number, M?: number, L?: number }} medians the pool's class medians
 * @param {{ finishMs: number | null, leftMin: number | null, p85Ms?: number | null }} finish the shown clock and the median work left (null on a refusal)
 * @returns {{ finishMs: number | null, p85Ms: number | null, leftMin: number | null, workedMin: number, rowsDone: number, rowsTotal: number,
 *   rows: { id: string, expectMin: number, startedMs: number | null }[] }}
 */
export function jobNumbers(job, medians, finish) {
  const open = job.rows.filter((row) => !row.done)
    .sort((a, b) => (a.startedMs === null) - (b.startedMs === null))
    .slice(0, MAX_CACHE_ROWS);
  return {
    finishMs: finish.finishMs,
    p85Ms: finish.p85Ms ?? null,
    leftMin: finish.leftMin,
    workedMin: job.workedMin,
    rowsDone: job.rows.filter((row) => row.done).length,
    rowsTotal: job.rows.length,
    rows: open.map((row) => ({ id: row.id, expectMin: expectedMinutes(row.size, medians), startedMs: row.startedMs })),
  };
}
