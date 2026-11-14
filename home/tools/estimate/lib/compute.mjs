// The estimate formula: work items + usage-limit windows -> a range of agent-hours, running time and calendar days.
// Exports: computeEstimate(items, windows, now) -> result | refusal; MIN_DONE_ITEMS; MIN_BAND_ITEMS; STALE_AFTER_MS.
// Invariants: pure; times are epoch ms. Per done item d = (done - started) minus limit-window overlap, r = d / points (hours
// per point); the range of r is the slowest and fastest item below MIN_BAND_ITEMS done items, else nearest-rank p25..p75;
// agent-hours = open points x that range (in-flight rows count whole); measured lanes L = sum(d) / active union; lanes
// used = min(L, open rows); calendar days = running time / active share / 24.
// A refusal is `{ refused: true, needed, measured, now, missing, future, noTime }`; it carries no estimate number. It is
// returned when too few items are measured, a done row has no started, a time is later than `now`, or a done item has no
// working time left (so a rate would be zero or not finite).
import { mergeIntervals } from './limits.mjs';

export const MIN_DONE_ITEMS = 5;
export const MIN_BAND_ITEMS = 10;
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
export const STALE_AFTER_MS = HOURS_PER_DAY * HOUR_MS;
const PERCENTILES = { p25: 0.25, p50: 0.5, p75: 0.75 };

/** Total length (ms) of the overlap between two lists of disjoint, sorted intervals. */
function overlapMs(a, b) {
  let total = 0;
  for (const x of a) for (const y of b) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return total;
}

const lengthMs = (intervals) => intervals.reduce((sum, i) => sum + (i.end - i.start), 0);

/** Nearest-rank percentile of an ascending list. */
const nearestRank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

const isMeasured = (item) => item.done !== null && item.started !== null && item.evidence !== '';
const rowLabel = (item) => `${item.id} (line ${item.line})`;

function refusal(now, fields) {
  return { refused: true, needed: MIN_DONE_ITEMS, measured: 0, now, missing: [], future: [], noTime: [], ...fields };
}

/** A refusal for what the table says (count, missing started, later than now), or null when the table is usable. */
function tableRefusal(items, measured, now) {
  const missing = items.filter((i) => i.done !== null && i.started === null).map(rowLabel);
  const future = items.flatMap((i) => [['started', i.started], ['done', i.done]]
    .filter(([, at]) => at !== null && at > now)
    .map(([cell, at]) => ({ row: rowLabel(i), cell, at })));
  if (missing.length === 0 && future.length === 0 && measured.length >= MIN_DONE_ITEMS) return null;
  return refusal(now, { measured: measured.length, missing, future });
}

function measureDone(measured, windows) {
  return measured.map((item) => {
    const own = [{ start: item.started, end: item.done }];
    const durationMs = item.done - item.started - overlapMs(own, windows);
    return { item, durationMs, rate: durationMs / HOUR_MS / item.points };
  });
}

/** The h/point range used for the estimate: slowest and fastest below MIN_BAND_ITEMS, else the p25-p75 band. */
function rateRange(done) {
  const rates = done.map((d) => d.rate).sort((a, b) => a - b);
  const rate = Object.fromEntries(Object.entries(PERCENTILES).map(([name, p]) => [name, nearestRank(rates, p)]));
  const band = rates.length >= MIN_BAND_ITEMS;
  return { ...rate, low: band ? rate.p25 : rates[0], high: band ? rate.p75 : rates.at(-1), band: band ? 'p25-p75' : 'fastest-slowest' };
}

function scaleRange(hours, factor) {
  return { low: hours.low * factor, median: hours.median * factor, high: hours.high * factor };
}

/** Where the done items sit in time: span, active union (limit windows removed) and the limit time inside the span. */
function timeline(measured, windows) {
  const union = mergeIntervals(measured.map((i) => ({ start: i.started, end: i.done })));
  const first = Math.min(...measured.map((i) => i.started));
  const last = Math.max(...measured.map((i) => i.done));
  const span = [{ start: first, end: last }];
  return { first, last, spanMs: last - first, activeMs: lengthMs(union) - overlapMs(union, windows), idleMs: overlapMs(span, windows), span };
}

/**
 * Computes the estimate.
 * @param {object[]} items parsed work items (see parseWorkItems).
 * @param {{start: number, end: number}[]} windows merged usage-limit windows (empty when not measured).
 * @param {number} now epoch ms: any started or done after it is a refusal.
 * @returns {object} the result, or a refusal (`refused: true`) naming what is missing.
 */
export function computeEstimate(items, windows, now) {
  const measured = items.filter(isMeasured);
  const early = tableRefusal(items, measured, now);
  if (early) return early;
  const done = measureDone(measured, windows);
  const noTime = done.filter((d) => !(d.durationMs > 0) || !Number.isFinite(d.rate)).map((d) => rowLabel(d.item));
  if (noTime.length > 0) return refusal(now, { measured: measured.length, noTime });

  const rate = rateRange(done);
  const open = items.filter((i) => i.done === null);
  const openPoints = open.reduce((sum, i) => sum + i.points, 0);
  const agentHours = { low: openPoints * rate.low, median: openPoints * rate.p50, high: openPoints * rate.high };
  const time = timeline(measured, windows);
  const measuredLanes = done.reduce((sum, d) => sum + d.durationMs, 0) / time.activeMs;
  const lanes = open.length > 0 ? Math.min(measuredLanes, open.length) : measuredLanes;
  const activeShare = time.spanMs > 0 && time.activeMs > 0 ? time.activeMs / time.spanMs : 1;
  const running = scaleRange(agentHours, 1 / lanes);
  const stamps = items.flatMap((i) => [i.started, i.done]).filter((at) => at !== null);

  return {
    computedAt: now,
    openItems: open.length,
    openPoints,
    inFlight: open.filter((i) => i.started !== null).length,
    agentHours,
    running,
    measuredLanes,
    lanes,
    activeShare,
    limitIdle: time.spanMs > 0 ? time.idleMs / time.spanMs : 0,
    calendarDays: scaleRange(running, 1 / activeShare / HOURS_PER_DAY),
    rate,
    measured: measured.length,
    first: time.first,
    last: time.last,
    newestEntry: Math.max(...stamps),
    windowsInSpan: { count: windows.filter((w) => overlapMs(time.span, [w]) > 0).length, hours: time.idleMs / HOUR_MS },
  };
}
