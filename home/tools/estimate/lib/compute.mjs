// The estimate formula: work items + usage-limit windows -> a range of agent-hours, running time and calendar days.
// Exports: computeEstimate(items, windows, now) -> result | { missing, measured, needed }; MIN_DONE_ITEMS.
// Invariants: pure; times are epoch ms. Per done item d = (done - started) minus limit-window overlap, r = d / points (hours
// per point); R = nearest-rank p25/p50/p75 of r; agent-hours = open points x R (in-flight rows count whole); measured
// lanes L = sum(d) / active union; lanes used = min(L, open rows); calendar days = running time / active share / 24.
import { mergeIntervals } from './limits.mjs';

export const MIN_DONE_ITEMS = 5;
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
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

function refusal(items, measured) {
  const missing = items.filter((i) => i.done !== null && i.started === null).map((i) => `${i.id} (line ${i.line})`);
  return { missing, measured: measured.length, needed: MIN_DONE_ITEMS };
}

function measureDone(measured, windows) {
  return measured.map((item) => {
    const own = [{ start: item.started, end: item.done }];
    const durationMs = item.done - item.started - overlapMs(own, windows);
    return { item, durationMs, rate: durationMs / HOUR_MS / item.points };
  });
}

function scaleRange(hours, factor) {
  return { low: hours.low * factor, median: hours.median * factor, high: hours.high * factor };
}

/**
 * Computes the estimate.
 * @param {object[]} items parsed work items (see parseWorkItems).
 * @param {{start: number, end: number}[]} windows merged usage-limit windows (empty when not measured).
 * @param {number} now epoch ms, recorded as computedAt only.
 * @returns {object} the result, or `{ missing, measured, needed }` when fewer than MIN_DONE_ITEMS items are measured.
 */
export function computeEstimate(items, windows, now) {
  const measured = items.filter(isMeasured);
  if (measured.length < MIN_DONE_ITEMS) return refusal(items, measured);

  const done = measureDone(measured, windows);
  const rates = done.map((d) => d.rate).sort((a, b) => a - b);
  const rate = Object.fromEntries(Object.entries(PERCENTILES).map(([name, p]) => [name, nearestRank(rates, p)]));

  const open = items.filter((i) => i.done === null);
  const openPoints = open.reduce((sum, i) => sum + i.points, 0);
  const agentHours = { low: openPoints * rate.p25, median: openPoints * rate.p50, high: openPoints * rate.p75 };

  const union = mergeIntervals(measured.map((i) => ({ start: i.started, end: i.done })));
  const activeMs = lengthMs(union) - overlapMs(union, windows);
  const spanStart = Math.min(...measured.map((i) => i.started));
  const spanEnd = Math.max(...measured.map((i) => i.done));
  const spanMs = spanEnd - spanStart;
  const span = [{ start: spanStart, end: spanEnd }];
  const idleMs = overlapMs(span, windows);

  const measuredLanes = activeMs > 0 ? done.reduce((sum, d) => sum + d.durationMs, 0) / activeMs : 1;
  const lanes = open.length > 0 ? Math.min(measuredLanes, open.length) : measuredLanes;
  const activeShare = spanMs > 0 && activeMs > 0 ? activeMs / spanMs : 1;
  const running = scaleRange(agentHours, 1 / lanes);

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
    limitIdle: spanMs > 0 ? idleMs / spanMs : 0,
    calendarDays: scaleRange(running, 1 / activeShare / HOURS_PER_DAY),
    rate,
    measured: measured.length,
    first: spanStart,
    last: spanEnd,
    windowsInSpan: { count: windows.filter((w) => overlapMs(span, [w]) > 0).length, hours: idleMs / HOUR_MS },
  };
}
