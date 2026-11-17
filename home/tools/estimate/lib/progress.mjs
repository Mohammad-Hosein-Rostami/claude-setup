// The job's progress percent for the status line and the Finish block: how much of the job is done, never falling, never 100 until
// every row is done.
// Exports: progressOf(input) -> { pct, approx, rowsDone, rowsTotal, leftMin, tag }; classMedians(costsBySize) -> { S?, M?, L? }.
// Two paths. With a forecast: pct = floor(100 x worked / (worked + median left)). Without one (a refusal): each row has a weight (its
// size's pool median, else DEFAULT_WEIGHT_MIN), earned = the done rows' weights + for each open row its elapsed minutes up to 90% of
// its weight, total = all weights / (1 - growth); the result is flagged approx (shown with `~`). The percent uses the median of the
// forecast, the clock uses the 85% budget, so the percent can read higher than the clock suggests.
// Invariants: pure (no I/O, no clock). `heldPct` is the highest percent this job showed before; the result is never below it.
import { nearestRank } from './forecast.mjs';

/** Weights of a row of each size when the pool has no median for it: the pool's median finished costs S 3.3 / M 8.6 / L 43, rounded (spec U6). */
const DEFAULT_WEIGHT_MIN = { S: 3, M: 9, L: 40 };
/** An open row earns at most this share of its weight, so a long-running row never looks finished (spec U6). */
const RUNNING_CREDIT = 0.9;
/** Growth used when the pool's is unknown or at the refusal bound: the measured pool growth (estimator design 3.4). */
const FALLBACK_GROWTH = 0.416;
/** Pool growth at or above this is not trusted: forecast.mjs MAX_GROWTH. */
const MAX_GROWTH = 0.75;
/** A size has a median from this many finished rows: forecast.mjs MIN_CLASS_ROWS. */
const MIN_MEDIAN_ROWS = 5;
const MEDIAN_SHARE = 0.5;
const PERCENT = 100;
const CAP_UNTIL_DONE = 99;
const SIZES = ['S', 'M', 'L'];

/** @returns {{ S?: number, M?: number, L?: number }} the median finished cost of each size that has MIN_MEDIAN_ROWS rows; costs are ascending */
export function classMedians(costsBySize) {
  const medians = {};
  for (const size of SIZES) {
    if ((costsBySize[size]?.length ?? 0) >= MIN_MEDIAN_ROWS) medians[size] = nearestRank(costsBySize[size], MEDIAN_SHARE);
  }
  return medians;
}

function fallbackPercent(rows, pool) {
  const weightOf = (row) => pool.medians[row.size] ?? DEFAULT_WEIGHT_MIN[row.size];
  const growth = pool.growth !== null && pool.growth < MAX_GROWTH ? pool.growth : FALLBACK_GROWTH;
  const earned = rows.reduce((sum, row) => sum + (row.done ? weightOf(row) : Math.min(RUNNING_CREDIT * weightOf(row), row.elapsedMin)), 0);
  const total = rows.reduce((sum, row) => sum + weightOf(row), 0) / (1 - growth);
  return total > 0 ? Math.floor((PERCENT * earned) / total) : 0;
}

function forecastPercent(workedMin, p50LeftMin) {
  return workedMin + p50LeftMin > 0 ? Math.floor((PERCENT * workedMin) / (workedMin + p50LeftMin)) : 0;
}

/** Overdue (the committed time is used up) before rows added before moved: the one that needs the owner most is shown. */
function tagOf({ committedLeftMin, rowsAdded, moved }) {
  if (committedLeftMin !== null && committedLeftMin <= 0) return 'overdue';
  if (rowsAdded) return '+rows';
  return moved ? 'moved' : null;
}

/**
 * @param {{ workedMin: number, p50LeftMin: number | null, committedLeftMin: number | null, rows: { size: 'S'|'M'|'L', done: boolean, elapsedMin: number }[],
 *   pool: { medians: { S?: number, M?: number, L?: number }, growth: number | null }, heldPct: number | null, moved: boolean, rowsAdded: boolean }} input
 *   workedMin: working minutes of the job so far; p50LeftMin: the forecast's median work left (null: no forecast, use the weights);
 *   committedLeftMin: work left in the committed budget (null: no commitment); rows: the job's work rows; heldPct: the job's highest percent so far
 * @returns {{ pct: number, approx: boolean, rowsDone: number, rowsTotal: number, leftMin: number | null, tag: 'moved' | '+rows' | 'overdue' | null }}
 *   pct 0-99 while a row is open, 100 when every row is done; approx true on the weights path; leftMin = the median left (null on that path)
 */
export function progressOf({ workedMin, p50LeftMin, committedLeftMin, rows, pool, heldPct, moved, rowsAdded }) {
  const rowsDone = rows.filter((row) => row.done).length;
  const counts = { rowsDone, rowsTotal: rows.length };
  if (rows.length > 0 && rowsDone === rows.length) return { pct: PERCENT, approx: false, ...counts, leftMin: 0, tag: null };
  const approx = p50LeftMin === null;
  const raw = approx ? fallbackPercent(rows, pool) : forecastPercent(workedMin, p50LeftMin);
  const pct = Math.min(CAP_UNTIL_DONE, Math.max(heldPct ?? 0, raw));
  return { pct, approx, ...counts, leftMin: p50LeftMin, tag: tagOf({ committedLeftMin, rowsAdded, moved }) };
}
