// Calibration of the finish estimate: scores logged estimates against the delivery that ended their job, turns the recent
// scores into range factors, and counts the track record.
// Exports: scoreEntries(entries, items, now) -> entries; calibrationFactors(entries, phase?) -> {low, high, scored}; phaseOf(result);
// trackRecord(entries, phase?) -> {scored, inside, late, early, medianLate, rewritten}; applyFactors(result, factors) -> result;
// logEntry(statusPath, result, items, printed) -> entry; isRepeat(entries, entry) -> boolean; MIN_SCORED; FACTOR_WINDOW; TARGET_INSIDE.
// Invariants: pure. A not-before prediction (a round or closing phase past its range: a low end only, see compute.mjs) is logged
// with `printed` and `raw` high = null and called low-only; it is scored inside when the delivery is not before the printed low
// end, counted apart in the track record (`lowOnly`, `lowOnlyInside`) and feeds neither factor: its low end is the open rows'
// size floor, not the low end of a range. A log entry holds ids and numbers only (never item text, prompts or transcript content):
// {v, at, status, open, started (each open row's started to the minute, or null), sizes, points, closing, phase,
// raw: [low, high] hours, printed: [low, high] ISO (high null when low-only)}; scoring drops ids gone from the table and adds actual (ISO; "void" when
// every id is gone; "rewritten" when a kept row carries another started than it had, to the minute, a row unstarted then
// excepted when it started after the entry: ids are reused and the log never expires), inside (printed low <= actual <= printed high) and ratio ([hours to the delivery /
// raw low, ... / raw high], null where raw is 0). Factors use raw ratios and the track record uses printed ranges, so the
// adjustment never feeds back into its own inputs. Two factor sets, by phase: 'job' (the first cycle: build, then closing) and
// 'round' (a follow-up round after a delivery). One set would let each kind move the other's ends: in the 14-15 Nov
// replay the lowest low ratio was a round's (0.77; first cycles 1.68 and up), the rounds' high ratios 0.11-0.66 against 0.87-1.03.
import { DELIVERY_TOLERANCE_MS, MIN_MEASURED_RANGE, findDeliveries } from './history.mjs';

const HOUR_MS = 3_600_000;
// From this many distinct scored deliveries on, the range is adjusted (one delivery can score several estimates, which say
// nearly the same thing; spec open point: judgment, 13 estimates over 2 projects cannot pick it).
export const MIN_SCORED = 5;
export const FACTOR_WINDOW = 10; // the factors come from this many most recent scored estimates
export const TARGET_INSIDE = { inside: 8, of: 10 }; // the aim the factors serve: 8 of 10 deliveries inside the printed range
const HIGH_PERCENTILE = 0.9;
const LOW_PERCENTILE = 0.1;
const MEDIAN = 0.5;
const RATIO_DECIMALS = 3;
const RAW_DECIMALS = 2;
const MINUTE_MS = 60_000;
// A run with the same phase and open rows as the last entry is logged again only after this long (runs a clock tick apart
// predict the same thing; counting each would let one delivery score many correlated estimates).
export const RELOG_AFTER_MS = 60 * MINUTE_MS;
// Entries that are never scored: "rewritten" (see the header) and "void" (all ids gone, written before "rewritten" existed).
const DROPPED = new Set(['rewritten', 'void']);
const REWRITTEN = 'rewritten';
const VOID = 'void';

const nearestRank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const isoMinutes = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
const round = (value, decimals) => Number(value.toFixed(decimals));
const isScored = (entry) => typeof entry.actual === 'string' && !DROPPED.has(entry.actual);
const phaseOfEntry = (entry) => entry.phase ?? 'job';
const isLowOnly = (entry) => entry.printed?.[1] === null;
const isRanged = (entry) => !isLowOnly(entry);
const distinctDeliveries = (scored) => new Set(scored.map((e) => e.actual)).size;

const toMinute = (ms) => Math.floor(ms / MINUTE_MS);

/** True when a kept row still has the started the entry saw (to the minute), or was unstarted then and started later or not yet. */
function sameStart(seen, started, entryAt) {
  if (seen === null) return started === null || started >= entryAt;
  return started !== null && toMinute(started) === toMinute(Date.parse(seen));
}

/** The entry scored at the first delivery at or after it with all its kept rows done; void or rewritten as the header says. */
function scoreOne(entry, deliveries, byId) {
  const at = Date.parse(entry.at);
  const checked = Array.isArray(entry.started) && entry.started.length === entry.open.length; // entries before `started`: ids only
  const kept = entry.open.map((id, k) => ({ id, seen: checked ? entry.started[k] : undefined })).filter((r) => byId.has(r.id));
  if (entry.open.length > 0 && kept.length === 0) return { ...entry, actual: VOID };
  if (checked && !kept.every((r) => sameStart(r.seen, byId.get(r.id).started, at))) return { ...entry, actual: REWRITTEN };
  const doneBy = (id, d) => byId.get(id).done !== null && byId.get(id).done <= d + DELIVERY_TOLERANCE_MS;
  // a delivery time has minute precision: one stamped in the minute of the entry (printed to the second) is not before it
  const delivery = deliveries.find((d) => d >= toMinute(at) * MINUTE_MS && kept.every((r) => doneBy(r.id, d)));
  if (delivery === undefined) return entry;
  const hours = (delivery - at) / HOUR_MS;
  const [low, high] = entry.printed.map((printed) => (printed === null ? Infinity : Date.parse(printed)));
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

/** The factor set an estimate belongs to, from the table state: 'job' in the first cycle, 'round' in an open follow-up round, null with no estimate. */
export function phaseOf(result) {
  switch (result.state) {
    case 'first-cycle-building':
    case 'first-cycle-closing': return 'job';
    case 'round-open': return 'round';
    case 'delivered':
    case 'round-done-not-delivered': return null;
    default: throw new Error(`unknown table state ${result.state}`);
  }
}

/**
 * The range factors of one phase from its last FACTOR_WINDOW scored entries: high = max(1, p90 of ratio high), low = min(1,
 * p10 of ratio low), nearest rank, nulls left out; both 1 below MIN_SCORED distinct deliveries among the scored entries.
 * @param {object[]} entries log entries; one without `phase` (written before rounds existed) is a 'job'.
 * @param {'job' | 'round'} [phase] which set; default 'job'.
 * @returns {{low: number, high: number, scored: number, deliveries: number}} scored = how many entries of that phase are scored
 *   in all, deliveries = at how many distinct deliveries.
 */
export function calibrationFactors(entries, phase = 'job') {
  const scored = entries.filter((e) => isScored(e) && isRanged(e) && phaseOfEntry(e) === phase);
  const deliveries = distinctDeliveries(scored);
  if (deliveries < MIN_SCORED) return { low: 1, high: 1, scored: scored.length, deliveries };
  const recent = scored.slice(-FACTOR_WINDOW);
  const sortedRatios = (index) => recent.map((e) => e.ratio?.[index]).filter((r) => typeof r === 'number').sort((a, b) => a - b);
  const lows = sortedRatios(0);
  const highs = sortedRatios(1);
  return {
    low: lows.length > 0 ? Math.min(1, nearestRank(lows, LOW_PERCENTILE)) : 1,
    high: highs.length > 0 ? Math.max(1, nearestRank(highs, HIGH_PERCENTILE)) : 1,
    scored: scored.length,
    deliveries,
  };
}

/**
 * How the printed ranges of one phase did: inside, late (delivered after the printed high end) and early; medianLate = the
 * median of (hours to the delivery / hours to the printed high end) over the late ones, null when none was late; rewritten =
 * entries dropped because their rows changed.
 * @param {object[]} entries log entries.
 * @param {'job' | 'round'} [phase] which phase; default 'job' (an entry without `phase` is a job).
 * @returns {{scored: number, inside: number, late: number, early: number, medianLate: number | null, rewritten: number, deliveries: number, lowOnly: number, lowOnlyInside: number}}
 *   scored, inside, late and early count ranges only; lowOnly = scored not-before predictions, lowOnlyInside = of them delivered not before the printed low end.
 */
export function trackRecord(entries, phase = 'job') {
  const ofPhase = entries.filter((e) => phaseOfEntry(e) === phase);
  const scored = ofPhase.filter((e) => isScored(e) && isRanged(e));
  const lowOnly = ofPhase.filter((e) => isScored(e) && isLowOnly(e));
  const lateBy = [];
  let early = 0;
  for (const entry of scored) {
    const [at, actual, low, high] = [entry.at, entry.actual, ...entry.printed].map(Date.parse);
    if (actual > high) lateBy.push((actual - at) / (high - at));
    else if (actual < low) early += 1;
  }
  const sorted = lateBy.sort((a, b) => a - b);
  const rewritten = ofPhase.filter((e) => DROPPED.has(e.actual)).length;
  return { scored: scored.length, inside: scored.length - sorted.length - early, late: sorted.length, early, medianLate: sorted.length > 0 ? nearestRank(sorted, MEDIAN) : null, rewritten, deliveries: distinctDeliveries(scored), lowOnly: lowOnly.length, lowOnlyInside: lowOnly.filter((e) => e.inside).length };
}

/** The result with its finish range scaled: now + [raw low x factors.low, raw high x factors.high]; raw stays as computed. A not-before result is not scaled. */
export function applyFactors(result, factors) {
  const now = result.computedAt;
  if (result.notBefore) return { ...result, factors };
  return { ...result, factors, finish: { lowMs: now + result.raw.low * factors.low * HOUR_MS, highMs: now + result.raw.high * factors.high * HOUR_MS } };
}

/**
 * The log line of a printed finish: ids and numbers only.
 * @param {string} statusPath absolute STATUS.md path.
 * @param {object} result the printed result (with finish and raw).
 * @param {object[]} items the table, for the ids of the open rows.
 * @param {{low: number, high: number | null}} printed the printed range ends, epoch ms (high null: a not-before prediction).
 * @returns {object} the entry.
 */
export function logEntry(statusPath, result, items, printed) {
  const open = items.filter((i) => i.done === null);
  return {
    v: 1,
    at: isoSeconds(result.computedAt),
    status: statusPath,
    open: open.map((i) => i.id),
    started: open.map((i) => (i.started === null ? null : isoMinutes(i.started))),
    sizes: open.map((i) => i.size),
    points: result.openPoints,
    closing: result.closing.measured >= MIN_MEASURED_RANGE ? 'measured' : 'default',
    phase: phaseOf(result),
    raw: [round(result.raw.low, RAW_DECIMALS), result.raw.high === null ? null : round(result.raw.high, RAW_DECIMALS)],
    printed: [isoMinutes(printed.low), printed.high === null ? null : isoMinutes(printed.high)],
  };
}

/** The open rows of an entry as comparable text: id, size and started of each, in id order. */
const rowsKey = (entry) => JSON.stringify(entry.open.map((id, k) => [id, entry.sizes?.[k] ?? null, entry.started?.[k] ?? null]).sort());

/**
 * True when the entry repeats the last logged entry: the same phase, the same kind (range or not-before), the same open rows (ids, sizes, started) and less than
 * RELOG_AFTER_MS since it. A repeat is not appended, so runs that differ only because the clock moved count once.
 * @param {object[]} entries the log, oldest first.
 * @param {object} entry the new entry from logEntry.
 */
export function isRepeat(entries, entry) {
  const last = entries.at(-1);
  if (last === undefined || phaseOfEntry(last) !== entry.phase) return false;
  return isLowOnly(last) === isLowOnly(entry) && rowsKey(last) === rowsKey(entry) && Date.parse(entry.at) - Date.parse(last.at) < RELOG_AFTER_MS;
}
