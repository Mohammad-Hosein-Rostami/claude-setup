// Working time of a table: which minutes were worked, what each done row cost, how long each open row has run, and the handed-over
// jobs with the parts of their growth (the share of the remaining work that was not in the table yet).
// Exports: IDLE_GAP_MIN, workingIntervals(runs, nowMin), workedMinutes(intervals, fromMin, toMin), rowCosts(items, intervals),
// elapsedShares(items, intervals, nowMin), handedOverJobs(items, costs, intervals, added).
// Invariants: pure (no I/O, no clock). Intervals and runs are [startMin, endMin) pairs of epoch minutes, sorted, apart from each other.
// Items are parser items ({ id, kind, started, done } with epoch-ms stamps or null); a work row is any row whose kind is not 'deliver',
// and a deliver row's done time is a hand-over. Costs and shares are in minutes; the costs of the done rows add up to the minutes
// in which at least one of them ran.

/** Minutes of silence still counted as work: a foreground command or a think writes nothing for a while. Working hours at
 *  5 / 10 / 15 / 30 minutes moved by at most 2.3 h of 12 on the four measured tables (design 3.1), so 10 is not a fitted value. */
export const IDLE_GAP_MIN = 10;
const MS_PER_MIN = 60_000;

const toMin = (ms) => ms / MS_PER_MIN;
const isWorkRow = (item) => item.kind !== 'deliver';
const isStartedWorkRow = (item) => isWorkRow(item) && item.started !== null;
const handOverTimes = (items) => items.filter((item) => item.kind === 'deliver' && item.done !== null).map((item) => item.done).sort((a, b) => a - b);

/** Calls visit(minute) for every whole working minute in [fromMin, toMin). */
function eachWorkedMinute(intervals, fromMin, toMin, visit) {
  for (const [start, end] of intervals) {
    for (let minute = Math.max(start, Math.ceil(fromMin)); minute < Math.min(end, toMin); minute += 1) visit(minute);
  }
}

/**
 * The working intervals at `now`: active minutes up to now, joined across silences of at most IDLE_GAP_MIN minutes. Tail rule: when
 * now is at most IDLE_GAP_MIN minutes after the last interval's end, that interval ends at now (the work may still be running).
 * @param {[number, number][]} runs active minutes as sorted [startMin, endMin) runs
 * @param {number} nowMin the epoch minute of now
 * @returns {[number, number][]} new intervals; the runs are not changed
 */
export function workingIntervals(runs, nowMin) {
  const intervals = [];
  for (const [start, end] of runs) {
    if (start > nowMin) break;
    const cutEnd = Math.min(end, nowMin + 1);
    const last = intervals.at(-1);
    if (last !== undefined && start - last[1] <= IDLE_GAP_MIN) last[1] = Math.max(last[1], cutEnd);
    else intervals.push([start, cutEnd]);
  }
  const last = intervals.at(-1);
  if (last !== undefined && nowMin - last[1] <= IDLE_GAP_MIN) last[1] = nowMin;
  return intervals;
}

/** @returns {number} the working minutes between fromMin and toMin (0 when toMin is not after fromMin) */
export function workedMinutes(intervals, fromMin, toMin) {
  return intervals.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, toMin) - Math.max(start, fromMin)), 0);
}

/**
 * Each done work row's cost: every working minute is split evenly among the done rows running in it (started <= m < done). Open
 * rows take no share, so a parked row cannot lower a done row's cost (design 3.2).
 * @returns {Map<string, number>} id -> minutes, for every done work row with a started stamp, in item order (0 when no minute fell inside)
 */
export function rowCosts(items, intervals) {
  const done = items.filter((item) => isStartedWorkRow(item) && item.done !== null);
  const costs = new Map(done.map((item) => [item.id, 0]));
  if (done.length === 0) return costs;
  const fromMin = Math.min(...done.map((item) => toMin(item.started)));
  const toMinute = Math.max(...done.map((item) => toMin(item.done)));
  eachWorkedMinute(intervals, fromMin, toMinute, (minute) => {
    const running = done.filter((item) => toMin(item.started) <= minute && minute < toMin(item.done));
    for (const item of running) costs.set(item.id, costs.get(item.id) + 1 / running.length);
  });
  return costs;
}

/** The earliest started stamp (ms) of the current job: the work rows open or done after the last hand-over; null when none started. */
function currentJobStart(items) {
  const lastHandOver = handOverTimes(items).at(-1) ?? -Infinity;
  const current = items.filter((item) => isStartedWorkRow(item) && (item.done === null || item.done > lastHandOver));
  return current.length === 0 ? null : Math.min(...current.map((item) => item.started));
}

/**
 * Open rows' elapsed shares: every working minute before now is split among all started work rows running in it, done or open
 * (started <= m < done, or no done). A minute of the current job in which no row ran is untracked.
 * @param {object[]} items parser items as seen at now (a row done after now must be passed as open)
 * @param {[number, number][]} intervals working intervals at now
 * @param {number} nowMin the epoch minute of now
 * @returns {{ elapsed: Map<string, number>, untrackedMin: number }} elapsed: id -> minutes for every open work row (0 when not
 *   started), in item order; untrackedMin: minutes since the current job's first started row with no started row running
 */
export function elapsedShares(items, intervals, nowMin) {
  const open = items.filter((item) => isWorkRow(item) && item.done === null);
  const elapsed = new Map(open.map((item) => [item.id, 0]));
  const started = items.filter(isStartedWorkRow);
  const jobStart = currentJobStart(items);
  let untrackedMin = 0;
  if (started.length === 0) return { elapsed, untrackedMin };
  const fromMin = Math.min(...started.map((item) => toMin(item.started)));
  eachWorkedMinute(intervals, fromMin, nowMin, (minute) => {
    const running = started.filter((item) => toMin(item.started) <= minute && (item.done === null || minute < toMin(item.done)));
    if (running.length === 0 && jobStart !== null && minute >= toMin(jobStart)) untrackedMin += 1;
    for (const item of running) if (item.done === null) elapsed.set(item.id, elapsed.get(item.id) + 1 / running.length);
  });
  return { elapsed, untrackedMin };
}

/**
 * When a row was added to the table, for growth: its first-seen time when that is at or before its start, else its own start for a
 * `close:` row and the job's start for any other row (old tables have no first-seen record; design 3.4).
 */
function addedAt(item, jobStartMs, added) {
  const seen = added.get(item.id);
  if (seen !== undefined && seen <= item.started) return seen;
  return item.kind === 'close' ? item.started : jobStartMs;
}

/** One job's growth parts: over each working minute m of [start, H), num += cost of rows added after m, den += work left from m to H. */
function growthParts(rows, costs, intervals, jobStartMs, handOverMs, added) {
  const addedMin = rows.map((item) => ({ addedMin: toMin(addedAt(item, jobStartMs, added)), cost: costs.get(item.id) ?? 0 }));
  let growthNum = 0;
  let growthDen = 0;
  eachWorkedMinute(intervals, toMin(jobStartMs), toMin(handOverMs), (minute) => {
    growthNum += addedMin.filter((row) => row.addedMin > minute).reduce((sum, row) => sum + row.cost, 0);
    growthDen += workedMinutes(intervals, minute, toMin(handOverMs));
  });
  return { growthNum, growthDen };
}

/**
 * The handed-over jobs: job k is the done work rows with H(k-1) < done <= H(k), H being the deliver rows' done times; a hand-over
 * with no such row is ignored.
 * @param {object[]} items parser items
 * @param {Map<string, number>} costs from rowCosts
 * @param {[number, number][]} intervals working intervals
 * @param {Map<string, number>} added id -> first-seen time (epoch ms) of the row
 * @returns {{ at: number, ids: string[], minutes: number, growthNum: number, growthDen: number }[]} at = the hand-over (epoch ms),
 *   ids in item order, minutes = the sum of the rows' costs; oldest first
 */
export function handedOverJobs(items, costs, intervals, added) {
  const jobs = [];
  let previous = -Infinity;
  for (const handOverMs of handOverTimes(items)) {
    const rows = items.filter((item) => isStartedWorkRow(item) && item.done !== null && item.done > previous && item.done <= handOverMs);
    previous = handOverMs;
    if (rows.length === 0) continue;
    const jobStartMs = Math.min(...rows.map((item) => item.started));
    const minutes = rows.reduce((sum, item) => sum + (costs.get(item.id) ?? 0), 0);
    jobs.push({ at: handOverMs, ids: rows.map((item) => item.id), minutes, ...growthParts(rows, costs, intervals, jobStartMs, handOverMs, added) });
  }
  return jobs;
}
