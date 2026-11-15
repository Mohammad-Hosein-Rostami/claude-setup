// The job history of one work items table: when earlier jobs were delivered, how long their closing phase took, how long
// the open job's closing has already run, the follow-up rounds after deliveries, and how often the owner reopened a delivery.
// Exports: findDeliveries(items, windows, now) -> {at, closingStart, tailHours}[]; closingRange(deliveries) -> {low, high, measured};
// followUpRounds(items, deliveries, windows) -> {start, at, hours}[]; followUpRange(rounds) -> {low, high, measured};
// openRound(items, deliveries, now) -> {deliveryAt, start, startRow} | null; hasDeliverRows(items) -> boolean;
// DEFAULT_FOLLOW_UP_HOURS; MIN_MEASURED_RANGE;
// closingStart(items, deliveries, now) -> {at, item}; closingElapsedHours(items, deliveries, windows, now) -> hours;
// reopenSummary(items, deliveries, now) -> summary | null; overlapMs(a, b); DELIVERY_GAP_MS; DEFAULT_CLOSING_HOURS; CLOSING_HISTORY.
// Invariants: pure; times are epoch ms, results in hours. Rows are classed by `kind` (see items.mjs): `close` rows are the
// closing phase (review, fix rounds, recheck, landing), `rework` rows are owner corrections, the rest is build work.
// With `deliver` rows in the table, a delivery is the done time of a deliver row, and nothing else is. Without them it is
// guessed from a pause: a delivery D is the done time of a close row when every row started before D is done by D, no row starts in
// [D, D + DELIVERY_GAP_MS), and that gap has passed (D + DELIVERY_GAP_MS <= now). Usage-limit windows are taken out of closing tails and of the elapsed closing time.
// A follow-up round is the work after a delivery: from the first row started after it to the next delivery (any kind of row;
// it is not a new closing phase).

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
// Real deliveries in the two measured tables (14-15 Nov) were followed by 19 and 470 quiet minutes, every other quiet moment
// by 0-1 minutes; so a closing chain paused this long with nothing running reads as a delivery.
export const DELIVERY_GAP_MS = 10 * MINUTE_MS;
// Closing phase in hours when this table has fewer than 2 finished jobs: the measured tails 1.48, 2.40 and 2.43 h
// (two projects, 14-15 Nov) rounded outward. Labelled "default, not yet measured here" in the output.
export const DEFAULT_CLOSING_HOURS = { low: 1.4, high: 2.5 };
export const CLOSING_HISTORY = 5; // the closing range is the min..max of this many most recent tails
// A closing or round range is measured from this many finished jobs or rounds; below it the default is used, widened to
// include a single one.
export const MIN_MEASURED_RANGE = 2;
// Follow-up round in hours when this table has fewer than 2 finished rounds: the spread of the only three rounds measured
// (15 Nov), rounded outward like the closing default; wide because three is few. Restructure 11:25Z -> 11:54Z = 0.48 h (live
// table); auth 06:20Z -> 08:10Z = 1.83 h and auth rework 08:29Z -> 11:03Z = 2.57 h, still open (14-15 Nov analysis).
export const DEFAULT_FOLLOW_UP_HOURS = { low: 0.4, high: 2.6 };

/** Total length (ms) of the overlap between two lists of disjoint intervals {start, end}. */
export function overlapMs(a, b) {
  let total = 0;
  for (const x of a) for (const y of b) total += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return total;
}

const workingHours = (start, end, windows) => (end - start - overlapMs([{ start, end }], windows)) / HOUR_MS;
// Rows of the closing phase: review, fix rounds, recheck, landing (`close`) and the hand-over itself (`deliver`).
const isClose = (item) => item.kind === 'close' || item.kind === 'deliver';

/** True when the table marks its deliveries with `deliver:` rows; the pause rule is then off. */
export const hasDeliverRows = (items) => items.some((i) => i.kind === 'deliver');

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
 * @param {number} now epoch ms; a row done later is not a delivery, nor (pause rule) a close row done less than DELIVERY_GAP_MS before it.
 * @returns {{at: number, closingStart: number, tailHours: number}[]} at = delivery time, closingStart = where its closing began.
 */
export function findDeliveries(items, windows, now) {
  const explicit = hasDeliverRows(items);
  const kind = explicit ? 'deliver' : 'close';
  const candidates = [...new Set(items.filter((i) => i.kind === kind && i.done !== null && i.done <= now).map((i) => i.done))].sort((a, b) => a - b);
  const times = explicit ? candidates : candidates.filter((at) => isDelivery(items, at, now));
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
  return measuredRange(deliveries.map((d) => d.tailHours), DEFAULT_CLOSING_HOURS);
}

/** min..max of the last CLOSING_HISTORY values when at least 2 exist, else the default widened to include them. */
function measuredRange(allValues, fallback) {
  const values = allValues.slice(-CLOSING_HISTORY);
  if (values.length >= MIN_MEASURED_RANGE) return { low: Math.min(...values), high: Math.max(...values), measured: values.length };
  return { low: Math.min(fallback.low, ...values), high: Math.max(fallback.high, ...values), measured: values.length };
}

/**
 * The finished follow-up rounds, oldest first: for each delivery after the first, the first row started after the previous
 * delivery up to that delivery.
 * @param {object[]} items parsed work items.
 * @param {{at: number}[]} deliveries from findDeliveries, oldest first.
 * @param {{start: number, end: number}[]} windows usage-limit windows, taken out of each round.
 * @returns {{start: number, at: number, hours: number}[]}
 */
export function followUpRounds(items, deliveries, windows) {
  return deliveries.slice(1).flatMap((delivery, k) => {
    const starts = items.filter((i) => i.started !== null && i.started > deliveries[k].at && i.started <= delivery.at).map((i) => i.started);
    if (starts.length === 0) return [];
    const start = Math.min(...starts);
    return [{ start, at: delivery.at, hours: workingHours(start, delivery.at, windows) }];
  });
}

/**
 * The follow-up round length: min..max of the last CLOSING_HISTORY finished rounds when at least 2 exist, else
 * DEFAULT_FOLLOW_UP_HOURS widened to include a single round.
 * @param {{hours: number}[]} rounds from followUpRounds, oldest first.
 * @returns {{low: number, high: number, measured: number}} hours; measured = how many rounds were used.
 */
export function followUpRange(rounds) {
  return measuredRange(rounds.map((r) => r.hours), DEFAULT_FOLLOW_UP_HOURS);
}

/**
 * The follow-up round in progress: the table has a delivery and a row started after the last one, or a row still open. It
 * starts at the first row started after the last delivery, or now when none has started yet.
 * @returns {{deliveryAt: number, start: number, startRow: string | null} | null} null in the first cycle, or when nothing
 *   happened after the last delivery.
 */
export function openRound(items, deliveries, now) {
  const last = deliveries.at(-1);
  if (last === undefined) return null;
  const first = items.filter((i) => i.started !== null && i.started > last.at).sort((a, b) => a.started - b.started)[0];
  if (first === undefined && items.every((i) => i.done !== null)) return null;
  return { deliveryAt: last.at, start: first?.started ?? now, startRow: first?.id ?? null };
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
