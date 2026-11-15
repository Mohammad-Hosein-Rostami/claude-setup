// Calibration of the finish estimate: scores logged estimates against the delivery that ended their job, turns the recent
// scores into range factors, and counts the track record.
// Exports: scoreEntries(entries, items, now) -> entries; calibrationFactors(entries, phase?) -> {low, high, scored}; phaseOf(result);
// trackRecord(entries) -> {scored, inside, late, early, medianLate}; applyFactors(result, factors) -> result;
// logEntry(statusPath, result, items, printed) -> entry; MIN_SCORED; FACTOR_WINDOW; TARGET_INSIDE.
// Invariants: pure. A log entry holds ids and numbers only (never item text, prompts or transcript content):
// {v, at, status, open, points, closing, phase, raw: [low, high] hours, printed: [low, high] ISO}; scoring adds actual (ISO, or
// "void" when every id left the table), inside (printed low <= actual <= printed high) and ratio ([hours to the delivery /
// raw low, ... / raw high], null where raw is 0). Factors use raw ratios and the track record uses printed ranges, so the
// adjustment never feeds back into its own inputs. Two factor sets, by phase: 'job' (the first cycle: build, then closing) and
// 'round' (a follow-up round after a delivery). One set would let each kind move the other's ends: in the 14-15 Nov
// replay the lowest low ratio was a round's (0.77; first cycles 1.68 and up), the rounds' high ratios 0.11-0.66 against 0.87-1.03.
import { findDeliveries } from './history.mjs';

const HOUR_MS = 3_600_000;
// From this many scored estimates on, the range is adjusted (spec open point: judgment; 13 estimates over 2 projects cannot pick it).
export const MIN_SCORED = 5;
export const FACTOR_WINDOW = 10; // the factors come from this many most recent scored estimates
export const TARGET_INSIDE = { inside: 8, of: 10 }; // the aim the factors serve: 8 of 10 deliveries inside the printed range
const HIGH_PERCENTILE = 0.9;
const LOW_PERCENTILE = 0.1;
const MEDIAN = 0.5;
const RATIO_DECIMALS = 3;
const RAW_DECIMALS = 2;
const VOID = 'void';

const nearestRank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const isoMinutes = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
const round = (value, decimals) => Number(value.toFixed(decimals));
const isScored = (entry) => typeof entry.actual === 'string' && entry.actual !== VOID;

/** The entry scored at the first delivery at or after it with all its remaining ids done; unchanged when there is none yet. */
function scoreOne(entry, deliveries, byId) {
  const at = Date.parse(entry.at);
  const kept = entry.open.filter((id) => byId.has(id));
  if (entry.open.length > 0 && kept.length === 0) return { ...entry, actual: VOID };
  const delivery = deliveries.find((d) => d >= at && kept.every((id) => byId.get(id).done !== null && byId.get(id).done <= d));
  if (delivery === undefined) return entry;
  const hours = (delivery - at) / HOUR_MS;
  const [low, high] = entry.printed.map(Date.parse);
  return { ...entry, actual: isoSeconds(delivery), inside: low <= delivery && delivery <= high, ratio: entry.raw.map((raw) => (raw > 0 ? round(hours / raw, RATIO_DECIMALS) : null)) };
}

/**
 * Scores every unscored entry whose job has been delivered (see the header); scored or void entries stay as they are.
 * @param {object[]} entries log entries of one STATUS.md, oldest first.
 * @param {object[]} items the table as it is now (parsed, with kind).
 * @param {number} now epoch ms.
 * @returns {object[]} the entries, scored where possible.
 */
export function scoreEntries(entries, items, now) {
  const deliveries = findDeliveries(items, [], now).map((d) => d.at);
  const byId = new Map(items.map((item) => [item.id, item]));
  return entries.map((entry) => (entry.actual === undefined ? scoreOne(entry, deliveries, byId) : entry));
}

/** The factor set an estimate belongs to: 'round' inside a follow-up round, else 'job'. */
export const phaseOf = (result) => (result.followUp === undefined ? 'job' : 'round');

/**
 * The range factors of one phase from its last FACTOR_WINDOW scored entries: high = max(1, p90 of ratio high), low = min(1,
 * p10 of ratio low), nearest rank, nulls left out; both 1 below MIN_SCORED scored entries.
 * @param {object[]} entries log entries; one without `phase` (written before rounds existed) is a 'job'.
 * @param {'job' | 'round'} [phase] which set; default 'job'.
 * @returns {{low: number, high: number, scored: number}} scored = how many entries of that phase are scored in all.
 */
export function calibrationFactors(entries, phase = 'job') {
  const scored = entries.filter((e) => isScored(e) && (e.phase ?? 'job') === phase);
  if (scored.length < MIN_SCORED) return { low: 1, high: 1, scored: scored.length };
  const recent = scored.slice(-FACTOR_WINDOW);
  const sortedRatios = (index) => recent.map((e) => e.ratio?.[index]).filter((r) => typeof r === 'number').sort((a, b) => a - b);
  const lows = sortedRatios(0);
  const highs = sortedRatios(1);
  return {
    low: lows.length > 0 ? Math.min(1, nearestRank(lows, LOW_PERCENTILE)) : 1,
    high: highs.length > 0 ? Math.max(1, nearestRank(highs, HIGH_PERCENTILE)) : 1,
    scored: scored.length,
  };
}

/**
 * How the printed ranges did: inside, late (delivered after the printed high end) and early; medianLate = the median of
 * (hours to the delivery / hours to the printed high end) over the late ones, null when none was late.
 * @returns {{scored: number, inside: number, late: number, early: number, medianLate: number | null}}
 */
export function trackRecord(entries) {
  const scored = entries.filter(isScored);
  const lateBy = [];
  let early = 0;
  for (const entry of scored) {
    const [at, actual, low, high] = [entry.at, entry.actual, ...entry.printed].map(Date.parse);
    if (actual > high) lateBy.push((actual - at) / (high - at));
    else if (actual < low) early += 1;
  }
  const sorted = lateBy.sort((a, b) => a - b);
  return { scored: scored.length, inside: scored.length - sorted.length - early, late: sorted.length, early, medianLate: sorted.length > 0 ? nearestRank(sorted, MEDIAN) : null };
}

/** The result with its finish range scaled: now + [raw low x factors.low, raw high x factors.high]; raw stays as computed. */
export function applyFactors(result, factors) {
  const now = result.computedAt;
  return { ...result, factors, finish: { lowMs: now + result.raw.low * factors.low * HOUR_MS, highMs: now + result.raw.high * factors.high * HOUR_MS } };
}

/**
 * The log line of a printed finish: ids and numbers only.
 * @param {string} statusPath absolute STATUS.md path.
 * @param {object} result the printed result (with finish and raw).
 * @param {object[]} items the table, for the ids of the open rows.
 * @param {{low: number, high: number}} printed the printed range ends, epoch ms.
 * @returns {object} the entry.
 */
export function logEntry(statusPath, result, items, printed) {
  return {
    v: 1,
    at: isoSeconds(result.computedAt),
    status: statusPath,
    open: items.filter((i) => i.done === null).map((i) => i.id),
    points: result.openPoints,
    closing: result.closing.measured >= 2 ? 'measured' : 'default',
    phase: phaseOf(result),
    raw: [round(result.raw.low, RAW_DECIMALS), round(result.raw.high, RAW_DECIMALS)],
    printed: [isoMinutes(printed.low), isoMinutes(printed.high)],
  };
}
