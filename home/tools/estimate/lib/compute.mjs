// The finish formula: work items + usage-limit windows -> when the whole job is finished (build part, then the closing phase).
// Exports: computeEstimate(items, windows, now) -> result | refusal; MIN_DONE_ITEMS; MIN_BAND_ITEMS; STALE_AFTER_MS.
// Invariants: pure; times are epoch ms, durations hours. Rate band: per done row (done - started - window overlap) / points,
// plus per running row (now - started - overlap) / points when it is above the lowest done rate (a lower bound on that row's
// real rate, so it may only raise the band; a row started a minute ago carries no information); nearest-rank p25..p75 from MIN_BAND_ITEMS values,
// else min..max. Build part B(r) = max(sum of remaining / lanes, largest remaining) over open build and rework rows, remaining =
// max(0, points x r - elapsed). Lanes = sum of done durations / their union (windows removed), clamped to 1..open build rows.
// Finish = now + [B(low) + max(0, closing low - E), B(high) + max(0, closing high - E)], the closing phase measured from this
// table's deliveries (history.mjs) and always in series after the build part; E = the closing time already run (0 while a
// build row is open).
// A refusal is `{ refused: true, reason, needed, measured, now, missing, future, noTime, overrun }` and carries no finish time:
// reason 'table' (too few measured rows, a done row without started, a time later than now, a done row with no working time)
// or 'overrun' (no build row open and the closing has already run as long as its high end).
import { closingElapsedHours, closingRange, closingStart, findDeliveries, overlapMs, reopenSummary } from './history.mjs';
import { mergeIntervals } from './limits.mjs';

export const MIN_DONE_ITEMS = 5;
export const MIN_BAND_ITEMS = 10;
const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
export const STALE_AFTER_MS = HOURS_PER_DAY * HOUR_MS;
const PERCENTILES = { p25: 0.25, p50: 0.5, p75: 0.75 };

const lengthMs = (intervals) => intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
const workingMs = (start, end, windows) => end - start - overlapMs([{ start, end }], windows);

/** Nearest-rank percentile of an ascending list. */
const nearestRank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

const isMeasured = (item) => item.done !== null && item.started !== null && item.evidence !== '';
const isOpenBuild = (item) => item.done === null && item.kind !== 'close';
const rowLabel = (item) => `${item.id} (line ${item.line})`;

function refusal(now, fields) {
  return { refused: true, reason: 'table', needed: MIN_DONE_ITEMS, measured: 0, now, missing: [], future: [], noTime: [], overrun: null, ...fields };
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
    const durationMs = workingMs(item.started, item.done, windows);
    return { item, durationMs, rate: durationMs / HOUR_MS / item.points };
  });
}

/** The h/point band: done rates plus running rows' lower bounds above the lowest done rate; min..max below MIN_BAND_ITEMS values, else p25-p75. */
function rateBand(done, allRunningRates) {
  const lowestDone = Math.min(...done.map((d) => d.rate));
  const runningRates = allRunningRates.filter((rate) => rate > lowestDone);
  const rates = [...done.map((d) => d.rate), ...runningRates].sort((a, b) => a - b);
  const rate = Object.fromEntries(Object.entries(PERCENTILES).map(([name, p]) => [name, nearestRank(rates, p)]));
  const band = rates.length >= MIN_BAND_ITEMS;
  return { ...rate, low: band ? rate.p25 : rates[0], high: band ? rate.p75 : rates.at(-1), band: band ? 'p25-p75' : 'min-max', done: done.length, running: runningRates.length };
}

/** Where the done items sit in time: first start, last done, span and active union (limit windows removed). */
function timeline(measured, windows) {
  const union = mergeIntervals(measured.map((i) => ({ start: i.started, end: i.done })));
  const first = Math.min(...measured.map((i) => i.started));
  const last = Math.max(...measured.map((i) => i.done));
  return { first, last, span: [{ start: first, end: last }], activeMs: lengthMs(union) - overlapMs(union, windows) };
}

/**
 * The build part in hours for the low and high rate: open build and rework rows, running time subtracted, never below the
 * largest row. pastRate = ids of running rows that have run at least as long as the band's slowest rate allows for them.
 */
function buildPart(openBuild, rate, lanes, windows, now) {
  const elapsedHours = (i) => (i.started === null ? 0 : workingMs(i.started, now, windows) / HOUR_MS);
  const at = (r) => {
    const remaining = openBuild.map((i) => Math.max(0, i.points * r - elapsedHours(i)));
    return remaining.length === 0 ? 0 : Math.max(remaining.reduce((sum, h) => sum + h, 0) / lanes, ...remaining);
  };
  const pastRate = openBuild.filter((i) => i.started !== null && i.points * rate.high <= elapsedHours(i)).map((i) => i.id);
  return { low: at(rate.low), high: at(rate.high), ids: openBuild.map((i) => i.id), lanes, pastRate };
}

/** The delivered result when nothing is open and the last done row is the last delivery, else null. */
function deliveredResult(items, deliveries, now) {
  const last = deliveries.at(-1);
  if (items.some((i) => i.done === null) || last === undefined) return null;
  if (Math.max(...items.map((i) => i.done)) !== last.at) return null;
  return { computedAt: now, openItems: 0, delivered: last.at, reopen: reopenSummary(items, deliveries, now) };
}

/** Rates, lanes, the build part and the other result fields that come from the rows' own times. */
function measureRows(items, done, measured, windows, now) {
  const open = items.filter((i) => i.done === null);
  const running = open.filter((i) => i.started !== null);
  const rate = rateBand(done, running.map((i) => workingMs(i.started, now, windows) / HOUR_MS / i.points));
  const openBuild = open.filter(isOpenBuild);
  const time = timeline(measured, windows);
  const measuredLanes = done.reduce((sum, d) => sum + d.durationMs, 0) / time.activeMs;
  const lanes = Math.max(1, Math.min(measuredLanes, openBuild.length));
  const buildPoints = openBuild.reduce((sum, i) => sum + i.points, 0);
  return {
    openItems: open.length,
    openPoints: open.reduce((sum, i) => sum + i.points, 0),
    inFlight: running.length,
    agentHours: { low: buildPoints * rate.low, median: buildPoints * rate.p50, high: buildPoints * rate.high },
    build: buildPart(openBuild, rate, lanes, windows, now),
    measuredLanes,
    lanes,
    rate,
    first: time.first,
    last: time.last,
    windowsInSpan: { count: windows.filter((w) => overlapMs(time.span, [w]) > 0).length, hours: overlapMs(time.span, windows) / HOUR_MS },
  };
}

/**
 * Computes when the whole job is finished.
 * @param {object[]} items parsed work items with `kind` (see parseWorkItems).
 * @param {{start: number, end: number}[]} windows merged usage-limit windows (empty when not measured).
 * @param {number} now epoch ms: any started or done after it is a refusal.
 * @returns {object} the result (`finish {lowMs, highMs}`, `raw {low, high}` hours from now, `build`, `closing`, `reopen`, ...),
 *   a delivered result (`delivered`: epoch ms) when nothing is open after a delivery, or a refusal (`refused: true`).
 */
export function computeEstimate(items, windows, now) {
  const measured = items.filter(isMeasured);
  const early = tableRefusal(items, measured, now);
  if (early) return early;
  const done = measureDone(measured, windows);
  const noTime = done.filter((d) => !(d.durationMs > 0) || !Number.isFinite(d.rate)).map((d) => rowLabel(d.item));
  if (noTime.length > 0) return refusal(now, { measured: measured.length, noTime });

  const deliveries = findDeliveries(items, windows, now);
  const delivered = deliveredResult(items, deliveries, now);
  if (delivered) return delivered;
  const closing = closingRange(deliveries);
  const elapsed = closingElapsedHours(items, deliveries, windows, now);
  const rows = measureRows(items, done, measured, windows, now);
  if (rows.build.ids.length === 0 && elapsed >= closing.high) {
    const overrun = { hours: elapsed, start: closingStart(items, deliveries, now), closing };
    return refusal(now, { reason: 'overrun', measured: measured.length, overrun });
  }
  const raw = { low: rows.build.low + Math.max(0, closing.low - elapsed), high: rows.build.high + Math.max(0, closing.high - elapsed) };
  return {
    computedAt: now,
    ...rows,
    closing,
    closingElapsed: elapsed,
    raw,
    finish: { lowMs: now + raw.low * HOUR_MS, highMs: now + raw.high * HOUR_MS },
    reopen: reopenSummary(items, deliveries, now),
    measured: measured.length,
    newestEntry: Math.max(...items.flatMap((i) => [i.started, i.done]).filter((at) => at !== null)),
  };
}
