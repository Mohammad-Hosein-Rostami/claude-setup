// The current step's range (estimate-spec section 5b, "the pick"): the likely time is the mean of s1 (slots.mjs) and a throughput
// Monte Carlo, the 80% time is s1's plus a split-conformal margin.
// Exports: DEFAULT_MARGIN_MIN, MIN_SCORED_STEPS, throughputForecast(items, count, nowMs, seedText), stepRange(s1, thru, marginMin),
// conformalMargin(scored).
// Measured on the held-out Desap day: the pick's step error 15 min against s1's 21 and throughput's 18, its 80% time held 77 % of
// steps (s1 73 %, throughput alone 50 %: sharp but too narrow, and no answer before the first landing). Later steps and the job use
// s1 alone. Throughput (Vacanti-style): agent rows done per 10-min bin over the last 180 min; a run draws bins at random until
// `count` rows are done. The margin is the 80th percentile of (truth - s1's 80% time) over scored steps: 27 min fitted on the
// frozen round4 steps, refitted from the store once 20 steps of model s1 are scored.
// Invariants: pure (no I/O, no clock); minutes from now; the same items, count, now and seedText give the same numbers; the margin
// is never negative and the 80% time never before the likely one.
import { nearestRank } from './forecast.mjs';
import { AGENT_KINDS, MIN_RUN_MIN, kindOf } from './kinds.mjs';
import { RUNS, seededRandom } from './slots.mjs';

/** The conformal margin before MIN_SCORED_STEPS steps are scored: fitted on the frozen round4 training steps (spec 5b). */
export const DEFAULT_MARGIN_MIN = 27;
/** Scored steps needed before the store's own margin replaces DEFAULT_MARGIN_MIN (spec section 4). */
export const MIN_SCORED_STEPS = 20;
const BIN_MIN = 10;
const WINDOW_MIN = 180;
const BINS = WINDOW_MIN / BIN_MIN;
/** A run stops after this many bins (100 days of 10 min): only reached when the step holds thousands of rows. */
const MAX_BINS_PER_RUN = 14_400;
const MEDIAN = 0.5;
const P80 = 0.8;
const MS_PER_MIN = 60_000;

/** A done agent row that was a run: the pools' lower bound (R14), so a row started and done in one minute (stamped after the
 *  fact, bookkeeping) is no throughput. The pools' 240 min upper bound is in working minutes, which an item does not carry; a
 *  row that took long still finished, so it counts. */
const isFinishedRun = (item) => item.done !== null && item.done !== undefined && item.started !== null && item.started !== undefined
  && (item.done - item.started) / MS_PER_MIN >= MIN_RUN_MIN && AGENT_KINDS.includes(kindOf(item));

/** Agent rows done per bin, bin 0 being the 10 min up to now: (now - 10 min, now]. */
function doneBins(items, nowMs) {
  const bins = new Array(BINS).fill(0);
  for (const item of items) {
    if (!isFinishedRun(item)) continue;
    const agoMin = (nowMs - item.done) / MS_PER_MIN;
    if (agoMin < 0 || agoMin >= WINDOW_MIN) continue;
    bins[Math.max(0, Math.ceil(agoMin / BIN_MIN) - 1)] += 1;
  }
  return bins;
}

/**
 * Minutes until `count` more agent rows are done, by throughput (see the header).
 * @param {object[]} items parser items (items.mjs); lead rows (gate, land, deliver) are not throughput
 * @param {number} count the rows to finish (forecastRuns' `currentRows` for the current step)
 * @param {number} nowMs epoch ms of now
 * @param {string} seedText the table state the numbers stand for (the same as forecastRuns')
 * @returns {{ p50: number, p80: number } | null} null when no agent row was done in the last 180 min (F7: use s1 alone, never a
 *   zero throughput); { 0, 0 } for no row left
 * @throws {TypeError} on a malformed argument
 */
export function throughputForecast(items, count, nowMs, seedText) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array of parser items');
  if (!Number.isFinite(count) || !Number.isFinite(nowMs) || typeof seedText !== 'string') throw new TypeError('count and nowMs must be numbers, seedText a string');
  const bins = doneBins(items, nowMs);
  if (bins.every((done) => done === 0)) return null;
  if (count <= 0) return { p50: 0, p80: 0 };
  const random = seededRandom(`${seedText}|throughput`);
  const times = new Float64Array(RUNS).map(() => {
    let done = 0;
    let drawn = 0;
    while (done < count && drawn < MAX_BINS_PER_RUN) {
      done += bins[Math.floor(random() * BINS)];
      drawn += 1;
    }
    return drawn * BIN_MIN;
  });
  times.sort();
  return { p50: nearestRank(times, MEDIAN), p80: nearestRank(times, P80) };
}

const isRange = (range) => Number.isFinite(range?.p50) && Number.isFinite(range?.p80);

/**
 * The current step's range, the pick of spec 5b.
 * @param {{ p50: number, p80: number }} s1 forecastRuns' current step
 * @param {{ p50: number, p80: number } | null} thru throughputForecast's result (null: s1 alone)
 * @param {number} marginMin conformalMargin's result (a negative one counts as 0)
 * @returns {{ p50: number, p80: number }} p50 = mean(s1.p50, thru.p50), p80 = max(p50, s1.p80 + margin)
 * @throws {TypeError} when s1 or a non-null thru is not a range, or the margin is not a number
 */
export function stepRange(s1, thru, marginMin) {
  if (!isRange(s1) || (thru !== null && !isRange(thru)) || !Number.isFinite(marginMin)) throw new TypeError('stepRange needs ranges { p50, p80 } and a margin in minutes');
  const p50 = thru === null ? s1.p50 : (s1.p50 + thru.p50) / 2;
  return { p50, p80: Math.max(p50, s1.p80 + Math.max(0, marginMin)) };
}

/**
 * The split-conformal margin of s1's 80% time.
 * @param {{ truthMin: number, p80Min: number }[]} scored scored steps of model s1 (entries without two numbers are left out)
 * @returns {number} the 80th percentile of truthMin - p80Min, at least 0; DEFAULT_MARGIN_MIN below MIN_SCORED_STEPS entries
 * @throws {TypeError} when scored is not an array
 */
export function conformalMargin(scored) {
  if (!Array.isArray(scored)) throw new TypeError('scored must be an array of { truthMin, p80Min }');
  const misses = scored
    .filter((entry) => Number.isFinite(entry?.truthMin) && Number.isFinite(entry?.p80Min))
    .map((entry) => entry.truthMin - entry.p80Min)
    .sort((a, b) => a - b);
  if (misses.length < MIN_SCORED_STEPS) return DEFAULT_MARGIN_MIN;
  return Math.max(0, nearestRank(misses, P80));
}
