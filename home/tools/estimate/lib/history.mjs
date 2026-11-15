// The job history of one work items table: when earlier jobs were delivered, how long their closing phase took, how long
// the open job's closing has already run, and how often the owner reopened a delivery.
// Exports: findDeliveries(items, windows, now) -> {at, closingStart, tailHours}[]; closingRange(deliveries) -> {low, high, measured};
// closingStart(items, deliveries, now) -> {at, item}; closingElapsedHours(items, deliveries, windows, now) -> hours;
// reopenSummary(items, deliveries, now) -> summary | null; overlapMs(a, b); DELIVERY_GAP_MS; DEFAULT_CLOSING_HOURS; CLOSING_HISTORY.
// Invariants: pure; times are epoch ms, results in hours. Rows are classed by `kind` (see items.mjs): `close` rows are the
// closing phase (review, fix rounds, recheck, landing), `rework` rows are owner corrections, the rest is build work.
// A delivery D is the done time of a close row when every row started before D is done by D, no row starts in
// [D, D + DELIVERY_GAP_MS), and that gap has passed (D + DELIVERY_GAP_MS <= now). Usage-limit windows are taken out of closing tails and of the elapsed closing time.

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
// Real deliveries in the two measured tables (14-15 Nov) were followed by 19 and 470 quiet minutes, every other quiet moment
// by 0-1 minutes; so a closing chain paused this long with nothing running reads as a delivery.
export const DELIVERY_GAP_MS = 10 * MINUTE_MS;
// Closing phase in hours when this table has fewer than 2 finished jobs: the measured tails 1.48, 2.40 and 2.43 h
// (two projects, 14-15 Nov) rounded outward. Labelled "default, not yet measured here" in the output.
export const DEFAULT_CLOSING_HOURS = { low: 1.4, high: 2.5 };
export const CLOSING_HISTORY = 5; // the closing range is the min..max of this many most recent tails
const MIN_MEASURED_TAILS = 2; // below this the default range is used, widened to include a single tail

/** Total length (ms) of the overlap between two lists of disjoint intervals {start, end}. */
export function overlapMs(a, b) {
  let total = 0;
  for (const x of a) for (const y of b) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return total;
}

const workingHours = (start, end, windows) => (end - start - overlapMs([{ start, end }], windows)) / HOUR_MS;
const isClose = (item) => item.kind === 'close';

/** True when D is a delivery: the gap after it has passed, nothing was in flight at D and nothing started within the gap. */
function isDelivery(items, at, now) {
  if (at + DELIVERY_GAP_MS > now) return false;
  const settled = items.every((i) => i.started === null || i.started >= at || (i.done !== null && i.done <= at));
  const quietAfter = items.every((i) => i.started === null || i.started < at || i.started >= at + DELIVERY_GAP_MS);
  return settled && quietAfter;
}

/**
 * Where the closing phase of the job between two deliveries began: the latest done of a non-close row after `after`
 * (up to `until`), else the first start after `after`, else `until`.
 * @returns {{at: number, item: object | null, how: 'done' | 'started' | 'none'}}
 */
function closingStartBetween(items, after, until) {
  const built = items.filter((i) => !isClose(i) && i.done !== null && i.done > after && i.done <= until).sort((a, b) => b.done - a.done);
  if (built.length > 0) return { at: built[0].done, item: built[0], how: 'done' };
  const started = items.filter((i) => i.started !== null && i.started > after && i.started <= until).sort((a, b) => a.started - b.started);
  if (started.length > 0) return { at: started[0].started, item: started[0], how: 'started' };
  return { at: until, item: null, how: 'none' };
}

/**
 * The deliveries of the table, oldest first, each with the length of its closing tail.
 * @param {object[]} items parsed work items with `kind`.
 * @param {{start: number, end: number}[]} windows usage-limit windows, taken out of each tail.
 * @param {number} now epoch ms; a close row done later, or less than DELIVERY_GAP_MS before it, is not a delivery.
 * @returns {{at: number, closingStart: number, tailHours: number}[]} at = delivery time, closingStart = where its closing began.
 */
export function findDeliveries(items, windows, now) {
  const candidates = [...new Set(items.filter((i) => isClose(i) && i.done !== null && i.done <= now).map((i) => i.done))].sort((a, b) => a - b);
  const times = candidates.filter((at) => isDelivery(items, at, now));
  return times.map((at, k) => {
    const start = closingStartBetween(items, k === 0 ? -Infinity : times[k - 1], at).at;
    return { at, closingStart: start, tailHours: workingHours(start, at, windows) };
  });
}

/**
 * The closing phase length: min..max of the last CLOSING_HISTORY tails when at least 2 exist, else DEFAULT_CLOSING_HOURS
 * widened to include a single tail.
 * @param {{tailHours: number}[]} deliveries from findDeliveries, oldest first.
 * @returns {{low: number, high: number, measured: number}} hours; measured = how many tails were used (0 for the plain default).
 */
export function closingRange(deliveries) {
  const tails = deliveries.slice(-CLOSING_HISTORY).map((d) => d.tailHours);
  if (tails.length >= MIN_MEASURED_TAILS) return { low: Math.min(...tails), high: Math.max(...tails), measured: tails.length };
  return { low: Math.min(DEFAULT_CLOSING_HOURS.low, ...tails), high: Math.max(DEFAULT_CLOSING_HOURS.high, ...tails), measured: tails.length };
}

/**
 * Where the open job's closing phase began: the latest non-close done after the last delivery, else the first start after
 * it, else now. Meaningful only while no build or rework row is open.
 * @returns {{at: number, item: object | null, how: 'done' | 'started' | 'none'}}
 */
export function closingStart(items, deliveries, now) {
  return closingStartBetween(items, deliveries.at(-1)?.at ?? -Infinity, now);
}

/**
 * How long the open job's closing phase has run, in hours (usage-limit windows taken out); 0 while any build or rework
 * row is open, because the closing then still lies ahead.
 */
export function closingElapsedHours(items, deliveries, windows, now) {
  if (items.some((i) => !isClose(i) && i.done === null)) return 0;
  return workingHours(closingStart(items, deliveries, now).at, now, windows);
}

/**
 * How often a delivery was reopened by an owner correction: delivery k counts when a `rework` row starts after it and no
 * later than the next delivery (after the last delivery: up to now). Rework time = the next delivery (or now: "so far")
 * minus the first such start.
 * @returns {{deliveries: number, reopened: number, lowHours: number, highHours: number, open: boolean, reworkOpen: boolean} | null}
 *   null when the table has no delivery yet; open = the last delivery is reopened and not delivered again (its time runs to
 *   now); reworkOpen = a rework row started after the last delivery is still open.
 */
export function reopenSummary(items, deliveries, now) {
  if (deliveries.length === 0) return null;
  const reworks = deliveries.flatMap((delivery, k) => {
    const until = deliveries[k + 1]?.at ?? now;
    const starts = items.filter((i) => i.kind === 'rework' && i.started !== null && i.started > delivery.at && i.started <= until).map((i) => i.started);
    if (starts.length === 0) return [];
    return [{ hours: (until - Math.min(...starts)) / HOUR_MS, open: k === deliveries.length - 1 }];
  });
  const hours = reworks.map((r) => r.hours);
  return {
    deliveries: deliveries.length,
    reopened: reworks.length,
    lowHours: hours.length > 0 ? Math.min(...hours) : 0,
    highHours: hours.length > 0 ? Math.max(...hours) : 0,
    open: reworks.some((r) => r.open),
    reworkOpen: items.some((i) => i.kind === 'rework' && i.done === null && i.started !== null && i.started > deliveries.at(-1).at),
  };
}
