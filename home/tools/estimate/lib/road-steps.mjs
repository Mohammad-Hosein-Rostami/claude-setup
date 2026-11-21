// Estimates per step of a road (spec-stages section 7): the road and step from row ids `<road>.s<N>.<rest>` (a `close:` or other
// `word:` prefix allowed), the current step, the step shares of the one Total, and the numbers the result and the status line get.
// Exports: roadStepOf(id) -> { road, step } | null, roadOf(items) -> road | null, stepShares(totalMin, stepMeans) -> { [step]: min },
// withRoad(result, road, stepMeans) -> result (adds `road` and `progress.road`); ROAD_ROW.
// Rules: the road is the one of the first open road row in table order; M = its highest step number; a step is closed when its
// check row (`<road>.s<N>.check...`) is done, or, with no check row, when every row of it is done; the current step is the lowest
// step not closed. Open rows of a closed step, and open work rows with no step while a road runs, count in the current step (the
// second kind is named in a Check line, so nothing vanishes). The Total is the forecast's own median of the road-wide sums; each step
// line is the step's share of it by the mean of its summed draws, rounded so the lines add up to the Total exactly: a step's share
// is not its own median (step medians added up come out early).
// Invariants: pure (no I/O, no clock); `progress.road` holds numbers only (R60: the road's id, step counts, minutes, the step's
// likely and 85% clocks in epoch ms, one line per step); text is made by report.mjs, the status line and `/where`.
export const ROAD_ROW = /^(?:[a-z]+:)?([A-Za-z0-9][\w-]{0,39})\.s(\d{1,3})\.(.+)$/i;
const CHECK_REST = /^check\b/i;
const MS_PER_MIN = 60_000;

const isWorkRow = (item) => item.kind !== 'deliver';

/** @returns {{ road: string, step: number, check: boolean } | null} the road and step a row id names, or null */
export function roadStepOf(id) {
  const match = ROAD_ROW.exec(String(id ?? ''));
  if (!match) return null;
  const step = Number(match[2]);
  return step > 0 ? { road: match[1].toLowerCase(), step, check: CHECK_REST.test(match[3]) } : null;
}

/** Whether every check row of `step` is done (true), none exists (null), or one is open (false). */
function checkDone(rows) {
  const checks = rows.filter((row) => row.at.check);
  return checks.length === 0 ? null : checks.every((row) => row.item.done !== null);
}

/**
 * @param {object[]} items parser items (work rows and deliver rows)
 * @returns {null | { road: string, steps: number, current: number, stepOf: Map<string, number>, unstepped: string[],
 *   rowsOf: Map<number, { id: string, done: boolean }[]> }} stepOf maps every open work row to the step it counts in
 */
export function roadOf(items) {
  const work = items.filter(isWorkRow).map((item) => ({ item, at: roadStepOf(item.id) }));
  const first = work.find(({ item, at }) => at !== null && item.done === null);
  if (!first) return null;
  const mine = work.filter(({ at }) => at?.road === first.at.road);
  const steps = Math.max(...mine.map(({ at }) => at.step));
  const rowsOf = new Map(Array.from({ length: steps }, (_, k) => [k + 1, []]));
  for (const row of mine) rowsOf.get(row.at.step).push(row);
  const closed = (step) => checkDone(rowsOf.get(step)) ?? rowsOf.get(step).every(({ item }) => item.done !== null);
  let current = 1;
  while (current < steps && closed(current)) current += 1;
  const stepOf = new Map();
  const unstepped = [];
  for (const { item, at } of work.filter(({ item }) => item.done === null)) {
    const own = at?.road === first.at.road ? at.step : null;
    if (own === null) unstepped.push(item.id);
    stepOf.set(item.id, own === null || own < current ? current : own);
  }
  const listed = new Map([...rowsOf].map(([step, rows]) => [step, rows.map(({ item }) => ({ id: item.id, done: item.done !== null }))]));
  return { road: first.at.road, steps, current, stepOf, unstepped, rowsOf: listed };
}

/**
 * The Total split over the steps by their means, in whole minutes that add up to the Total (largest remainder).
 * @param {number} totalMin the Total (minutes)
 * @param {Record<number, number>} stepMeans the mean of each step's summed draws
 * @returns {Record<number, number>} minutes per step
 */
export function stepShares(totalMin, stepMeans) {
  const steps = Object.keys(stepMeans).map(Number).sort((a, b) => a - b);
  const sum = steps.reduce((acc, step) => acc + stepMeans[step], 0);
  const total = Math.max(0, Math.round(totalMin));
  if (steps.length === 0 || !(sum > 0)) return Object.fromEntries(steps.map((step, k) => [step, k === 0 ? total : 0]));
  const exact = steps.map((step) => ({ step, value: (total * stepMeans[step]) / sum }));
  const shares = Object.fromEntries(exact.map(({ step, value }) => [step, Math.floor(value)]));
  let left = total - Object.values(shares).reduce((acc, value) => acc + value, 0);
  for (const { step } of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1) || a.step - b.step)) {
    if (left <= 0) break;
    shares[step] += 1;
    left -= 1;
  }
  return shares;
}

/**
 * Adds the road to a finish result: `road` (the step lines' numbers) and `progress.road` (numbers only, for the status line).
 * @param {object} result estimateFile's finish result (commit.leftMin is the Total)
 * @param {ReturnType<typeof roadOf>} road the road, or null (the result is returned unchanged)
 * @param {Record<number, number> | undefined} stepMeans the forecast's per-step means
 * @returns {object} the result
 */
export function withRoad(result, road, stepMeans) {
  if (road === null || !stepMeans) return result;
  const shares = stepShares(result.commit.leftMin, stepMeans);
  const steps = Array.from({ length: road.steps }, (_, k) => {
    const step = k + 1;
    const rows = road.rowsOf.get(step);
    const state = step < road.current ? 'done' : step === road.current ? 'now' : 'next';
    return { step, state, leftMin: shares[step] ?? 0, rowsDone: rows.filter((row) => row.done).length, rowsTotal: rows.length };
  });
  const now = steps[road.current - 1];
  const share = result.commit.leftMin > 0 ? now.leftMin / result.commit.leftMin : 0;
  const roadView = {
    name: road.road, step: road.current, steps: road.steps, lines: steps, totalMin: Math.round(result.commit.leftMin),
    stepsLeft: steps.filter((line) => line.state !== 'done').length,
    stepClockMs: result.nowMs + now.leftMin * MS_PER_MIN,
    stepP85Ms: result.nowMs + (now.leftMin + Math.max(0, result.work.p85 - result.work.p50) * share) * MS_PER_MIN,
  };
  // The step clocks and every step line ride along as numbers, so the status line and `/where` read the cache alone.
  const progressRoad = {
    name: road.road, step: road.current, steps: road.steps, rowsDone: now.rowsDone, rowsTotal: now.rowsTotal, leftMin: now.leftMin,
    clockMs: roadView.stepClockMs, p85Ms: roadView.stepP85Ms, totalMin: roadView.totalMin,
    lines: steps.map(({ step, state, leftMin, rowsDone, rowsTotal }) => ({ step, state, leftMin, rowsDone, rowsTotal })),
  };
  const checks = road.unstepped.length === 0 ? result.checks : [...result.checks, { kind: 'unstepped', ids: road.unstepped, step: road.current }];
  return { ...result, road: roadView, checks, progress: result.progress && { ...result.progress, road: progressRoad } };
}
