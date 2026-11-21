// The scores of the backtest beyond its design thresholds (R68, research2/estimate.md P2): per-job miss of the shown time, the
// signed bias, the hit rate of the 85% clock, a naive baseline, the first estimate of each job apart from the later ones, and the
// review and judge rows by effort.
// Exports: scoreLines(replays, tables) -> string[] (the lines backtest.mjs prints under `Scores:`); jobSizeClass(items) -> 'S'|'M'|'L'.
// Inputs: each replay is { table, job: { minutes, size }, instants: [{ shownMin, shown85Min, actual, workedMin, jobMin }] } for the instants
// that gave a time, in time order; each table is { name, jobs: [{ minutes, size }], items } (items with their `cost`, and `effort` when the table has one). A job's size class is its largest row
// size; the naive baseline shows, at each instant, the median work of the other tables' jobs of that class minus the work done.
// Invariants: pure; work in minutes; nothing is fitted here (constants wait for about 40 scored jobs, spec-p5 `r9-estimate`).
import { nearestRank } from './forecast.mjs';

/** A job is close when its median miss is within this many minutes or this share of its work (spec-p5 `r9-estimate` acceptance). */
const CLOSE_MIN = 60;
const CLOSE_SHARE = 0.3;
/** Jobs over this much work are scored apart: the backtest found them early, the short ones late (section 5). */
const LONG_JOB_MIN = 360;
const SIZES = ['S', 'M', 'L'];

const median = (values) => (values.length === 0 ? Number.NaN : nearestRank([...values].sort((a, b) => a - b), 0.5));
const round = (value) => (Number.isFinite(value) ? String(Math.round(value)) : 'n/a');
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : 'n/a');
const miss = (instant, shown) => Math.abs(shown - instant.actual);
const isClose = (missMin, jobMin) => missMin <= CLOSE_MIN || missMin <= CLOSE_SHARE * jobMin;

/** @returns {'S'|'M'|'L'} the largest row size among the given items */
export const jobSizeClass = (items) => [...SIZES].reverse().find((size) => items.some((item) => item.size === size)) ?? 'S';

/** The median miss of each job for a way of showing the time, and how many jobs are close. */
function perJob(replays, shownOf) {
  const misses = replays.map((replay) => median(replay.instants.map((instant) => miss(instant, shownOf(instant, replay)))));
  const close = replays.filter((replay, k) => isClose(misses[k], replay.job.minutes)).length;
  return { median: median(misses.filter(Number.isFinite)), close, of: replays.length };
}

/** The naive shown work left: the median work of the other tables' jobs of the same class, minus the work done so far. */
function naiveOf(tables) {
  return (instant, replay) => {
    const others = tables.filter((table) => table.name !== replay.table).flatMap((table) => table.jobs).filter((job) => job.size === replay.job.size);
    return Math.max(0, median(others.map((job) => job.minutes)) - instant.workedMin);
  };
}

const logBias = (instants) => median(instants.filter((instant) => instant.actual > 0 && instant.shownMin > 0).map((instant) => Math.log(instant.shownMin / instant.actual)));

/** Review and judge rows (`close:`) by effort, with their count and median cost; tables without an effort column say so. */
function effortLines(tables) {
  const closeRows = tables.flatMap((table) => table.items.filter((item) => item.kind === 'close' && item.cost > 0));
  if (!closeRows.some((row) => typeof row.effort === 'string')) return ['  review and judge rows by effort: no effort column in these tables yet'];
  const efforts = [...new Set(closeRows.map((row) => row.effort ?? 'unknown'))].sort();
  return efforts.map((effort) => {
    const rows = closeRows.filter((row) => (row.effort ?? 'unknown') === effort);
    return `  review and judge rows at ${effort}: ${rows.length} rows, median ${round(median(rows.map((row) => row.cost)))} min`;
  });
}

/**
 * @param {object[]} replays see the header; replays with no timed instant are skipped
 * @param {object[]} tables see the header
 * @returns {string[]} the score lines
 */
export function scoreLines(replays, tables) {
  const scored = replays.filter((replay) => replay.instants.length > 0);
  const instants = scored.flatMap((replay) => replay.instants);
  const shown = perJob(scored, (instant) => instant.shownMin);
  const naive = perJob(scored, naiveOf(tables));
  const firsts = scored.map((replay) => replay.instants[0]);
  const laters = scored.flatMap((replay) => replay.instants.slice(1));
  const long = instants.filter((instant) => instant.jobMin > LONG_JOB_MIN);
  const hits = instants.filter((instant) => instant.actual <= instant.shown85Min).length;
  return [
    'Scores (shown time = the median clock):',
    `  per-job median miss ${round(shown.median)} min; ${shown.close} of ${shown.of} jobs within ${CLOSE_MIN} min or ${CLOSE_SHARE * 100}%`,
    `  naive baseline (median work of past jobs of the same size class): per-job median miss ${round(naive.median)} min; ${naive.close} of ${naive.of} jobs close`,
    `  signed bias, median log(shown/actual): all ${signed(logBias(instants))}; jobs over 6 h ${signed(logBias(long))}`,
    `  85% clock hit rate: ${hits} of ${instants.length} instants (${instants.length === 0 ? 'n/a' : Math.round((100 * hits) / instants.length)}%)`,
    `  first estimate per job: median miss ${round(median(firsts.map((instant) => miss(instant, instant.shownMin))))} min (${firsts.length}); later updates ${round(median(laters.map((instant) => miss(instant, instant.shownMin))))} min (${laters.length})`,
    ...effortLines(tables),
  ];
}
