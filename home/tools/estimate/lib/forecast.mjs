// The work-left forecast: a reference pool of finished rows and jobs, seeded runs over the open rows, and why no time can be given.
// Exports: nearestRank(sortedValues, share), referencePool(tables, seed),
// forecastWork(openRows, pool, seedText), refusalOf(openRows, pool, work).
// Model (estimator design 3.5-3.7): the class of a row is its size alone; one run draws, for each open row, a finished cost of its
// size longer than the row's elapsed share (minus that share), or any cost of its size when the row has run longer than all of them
// (a stale row). Growth (work not listed yet) is not in the total: on 15 replayed jobs it added +92 min of work per job that never
// came (backtest section 5, model c2b); the report states it on a line of its own. The runs are seeded from the table and its open ids, so the CLI and the
// status line give the same numbers for the same table state.
// Invariants: pure (no I/O, no clock). Work is in minutes. Pool costs are sorted ascending per size.
import { createHash } from 'node:crypto';

/** Runs per forecast: the 85th percentile of 2000 draws moves by under 1 % between seeds on the measured jobs (design 8.3, 3 seeds). */
const RUNS = 2000;
/** A size needs this many finished rows before its rows can be forecast (design 3.5; L had 7 on the measured tables). */
const MIN_CLASS_ROWS = 5;
/** Rows per size kept in the pool, newest by done time: all 146 measured rows fit; old rows leave without an age cliff (design 9). */
const CLASS_WINDOW_ROWS = 200;
/** Growth is pooled over the newest jobs until they hold this much work: 20 hours, minutes (design 3.4). The four
 *  measured tables hold 21.3 h, just over it, so the job that crosses 20 h is the last one taken. */
const GROWTH_WINDOW_MIN = 1200;
/** Growth at or above this share means most of the work is usually missing from the table: no time is given (design 3.7, U5). */
const MAX_GROWTH = 0.75;
/** A forecast median above this many times the longest finished job is past what the pool has seen (design 3.7). */
const HORIZON_FACTOR = 2;
const SIZES = ['S', 'M', 'L'];
const PERCENTILES = { p50: 0.5, p85: 0.85, p95: 0.95 };
const UINT32_RANGE = 2 ** 32;

/** @returns {number} the value at rank ceil(share x n) of an ascending list (the first value for a tiny share) */
export const nearestRank = (sortedValues, share) => sortedValues[Math.max(0, Math.ceil(share * sortedValues.length) - 1)];

const timeOf = (stamp) => (typeof stamp === 'number' ? stamp : Date.parse(stamp));
const newestFirst = (a, b) => timeOf(b) - timeOf(a);
const ascending = (a, b) => a - b;
const isReferenceRow = (row) => SIZES.includes(row?.size) && Number.isFinite(row.cost) && row.cost > 0 && Number.isFinite(timeOf(row.done));
const isJob = (job) => Number.isFinite(job?.minutes) && Number.isFinite(job.growthNum) && Number.isFinite(job.growthDen) && Number.isFinite(timeOf(job.at));

/** The growth of the newest jobs that together hold GROWTH_WINDOW_MIN of work (all of them while the pool holds less). */
function pooledGrowth(jobs) {
  let num = 0;
  let den = 0;
  let minutes = 0;
  for (const job of [...jobs].sort((a, b) => newestFirst(a.at, b.at))) {
    if (minutes >= GROWTH_WINDOW_MIN) break;
    num += job.growthNum;
    den += job.growthDen;
    minutes += job.minutes;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The reference pool: the rows and jobs of every table file, plus the seed's rows and jobs whose table has no file here and that no
 * table holds under another id (same size and done time for a row, same hand-over time for a job).
 * @param {{ id: string, rows: object[], jobs: object[] }[]} tables rows: { size, kind, done, cost }; jobs: { at, minutes, growthNum, growthDen }
 * @param {{ rows: object[], jobs: object[] }} seed the same shapes, each with the `table` id it came from
 * @returns {{ costs: { S: number[], M: number[], L: number[] }, growth: number, longestJobMin: number, rowCount: number, jobCount: number }}
 *   costs ascending, per size the CLASS_WINDOW_ROWS newest rows with a cost; growth as in pooledGrowth; longestJobMin 0 with no job
 */
export function referencePool(tables, seed) {
  const known = new Set(tables.map((table) => table.id));
  const liveRows = tables.flatMap((table) => table.rows);
  const liveJobs = tables.flatMap((table) => table.jobs);
  // A table id is a hash of the STATUS.md's real path, and the seed was written on the Mac: on another machine (the PC, another
  // home) the same STATUS.md has another id, so the id check alone counted its rows twice. A live row with the same size and done
  // minute, or a live job with the same hand-over time, is that same row or job: the live one is kept (its cost is this
  // machine's measure). Kept over re-keying the seed by a path relative to the repo or home: a STATUS.md need not be in a repo,
  // and changing the id would orphan every stored table. Two unrelated rows done in the same minute at the same size cost at most
  // one seed row.
  const liveRowKeys = new Set(liveRows.map((row) => `${row.size}|${timeOf(row.done)}`));
  const liveJobTimes = new Set(liveJobs.map((job) => timeOf(job.at)));
  const seedRows = seed.rows.filter((row) => !known.has(row.table) && !liveRowKeys.has(`${row.size}|${timeOf(row.done)}`));
  const seedJobs = seed.jobs.filter((job) => !known.has(job.table) && !liveJobTimes.has(timeOf(job.at)));
  const rows = [...liveRows, ...seedRows].filter(isReferenceRow);
  const jobs = [...liveJobs, ...seedJobs].filter(isJob);
  const costs = Object.fromEntries(SIZES.map((size) => [size, rows
    .filter((row) => row.size === size)
    .sort((a, b) => newestFirst(a.done, b.done))
    .slice(0, CLASS_WINDOW_ROWS)
    .map((row) => row.cost)
    .sort(ascending)]));
  return {
    costs,
    growth: pooledGrowth(jobs),
    longestJobMin: Math.max(0, ...jobs.map((job) => job.minutes)),
    rowCount: SIZES.reduce((sum, size) => sum + costs[size].length, 0),
    jobCount: jobs.length,
  };
}

/** mulberry32: a small seeded generator of numbers in [0, 1); no seeded generator exists in this repo. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

const seedOf = (seedText) => createHash('sha256').update(seedText).digest().readUInt32BE(0);
const pick = (values, random) => values[Math.floor(random() * values.length)];
const hasClass = (openRows, pool) => openRows.every((row) => (pool.costs[row.size]?.length ?? 0) >= MIN_CLASS_ROWS);

/**
 * The work left: RUNS seeded runs over the open rows (see the header).
 * @param {{ id: string, size: string, elapsed: number }[]} openRows elapsed = the row's elapsed share in minutes (0 when not started)
 * @param {ReturnType<typeof referencePool>} pool the reference pool
 * @param {string} seedText tableId + '|' + the open ids sorted and joined by ','
 * @returns {{ p50: number, p85: number, p95: number, stale: string[] } | null} minutes of listed work, before any widening; stale = rows past every
 *   finished row of their size, in row order; null when a size has fewer than MIN_CLASS_ROWS rows or growth is at MAX_GROWTH or above
 */
export function forecastWork(openRows, pool, seedText) {
  if (!hasClass(openRows, pool) || pool.growth >= MAX_GROWTH) return null;
  const draws = openRows.map((row) => {
    const sizeCosts = pool.costs[row.size];
    const longer = sizeCosts.filter((cost) => cost > row.elapsed).map((cost) => cost - row.elapsed);
    return { id: row.id, values: longer.length > 0 ? longer : sizeCosts, stale: longer.length === 0 };
  });
  const random = mulberry32(seedOf(seedText));
  const totals = Array.from({ length: RUNS }, () => draws.reduce((sum, draw) => sum + pick(draw.values, random), 0));
  totals.sort(ascending);
  const percentiles = Object.fromEntries(Object.entries(PERCENTILES).map(([name, share]) => [name, nearestRank(totals, share)]));
  return { ...percentiles, stale: draws.filter((draw) => draw.stale).map((draw) => draw.id) };
}

/**
 * Why no finish time can be given, first match wins: a size with too few pool rows, too much growth, a job past the horizon.
 * @param {{ size: string }[]} openRows the open rows
 * @param {ReturnType<typeof referencePool>} pool the reference pool
 * @param {{ p50: number } | null} work forecastWork's result (null skips the horizon check)
 * @returns {null | { reason: 'no-reference', size: string, rows: number, needed: number } | { reason: 'growth', growth: number }
 *   | { reason: 'horizon', longestJobMin: number, work: object }}
 */
export function refusalOf(openRows, pool, work) {
  const short = SIZES.find((size) => openRows.some((row) => row.size === size) && (pool.costs[size]?.length ?? 0) < MIN_CLASS_ROWS);
  if (short !== undefined) return { reason: 'no-reference', size: short, rows: pool.costs[short]?.length ?? 0, needed: MIN_CLASS_ROWS };
  if (pool.growth >= MAX_GROWTH) return { reason: 'growth', growth: pool.growth };
  if (work !== null && work.p50 > HORIZON_FACTOR * pool.longestJobMin) return { reason: 'horizon', longestJobMin: pool.longestJobMin, work };
  return null;
}
