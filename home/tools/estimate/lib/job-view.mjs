// The parts of an s1 finish result that are views of the forecast (estimate-spec R5, R6, R11, section 7): the road the `now` row
// shows, its current step's numbers with its lanes, every step line, the pauses summed by reason and the Check facts of rows that
// stalled or roads that wait in the queue.
// Exports: nowRoadOf(rows, names), roadView(road, runRoad, pick, nowMs), pauseSummary(pauses), stalledChecks(ids, rows, facts),
// queuedChecks(queued).
// Rules: the `now` road is the one with the newest started or done row (R6; the first in table order on a tie); a step line of
// model s1 carries the minutes from now until that step ends (`leftMin` and `p80Min`), not a share of a total: steps run one after
// another, so the last step's end is the road's. Lanes landed (section 7's bar): a step with old-form `-land` rows counts those,
// else its lane rows (one row per lane, road-state.mjs laneLanded).
// Invariants: pure (no I/O, no clock); numbers only, the text is made by report.mjs and the status line.
import { kindOf } from './kinds.mjs';

const MS_PER_MIN = 60_000;
const newestStampOf = (item) => Math.max(item.started ?? -Infinity, item.done ?? -Infinity);

/**
 * @param {object[]} rows the job's rows (job-rows.mjs jobScope items)
 * @param {string[]} names the roads the forecast planned (forecastRuns roads)
 * @param {(id: string) => string | undefined} roadOfId the road a row id names (road-steps.mjs roadStepOf)
 * @returns {string | null} the road of the newest started or done row among them, null when there is none
 */
export function nowRoadOf(rows, names, roadOfId) {
  let best = null;
  let bestMs = -Infinity;
  for (const item of rows) {
    const road = roadOfId(item.id);
    if (road === undefined || !names.includes(road)) continue;
    const ms = newestStampOf(item);
    if (best === null || ms > bestMs) {
      best = road;
      bestMs = ms;
    }
  }
  return best ?? names[0] ?? null;
}

/** Lanes landed of all lanes of one step's rows (see the header). */
function lanesOf(rows) {
  const lands = rows.filter((row) => kindOf(row.item) === 'land');
  const lanes = lands.length > 0 ? lands : rows.filter((row) => kindOf(row.item) === 'lane');
  return { lanesDone: lanes.filter((row) => row.done).length, lanesTotal: lanes.length };
}

/**
 * One road's step numbers for the result (report.mjs `result.road`), the status line (`progress.road`) and the cache (`v2.step`).
 * @param {{ road: string, steps: number, current: number, rowsOf: Map<number, { id: string, done: boolean, item: object }[]> }} road
 *   road-steps.mjs roadsOf entry
 * @param {{ current: number, steps: Record<number, { p50: number, p80: number }> }} runRoad forecastRuns' road
 * @param {{ p50: number, p80: number }} pick the current step's range (throughput.mjs stepRange)
 * @param {number} nowMs now, epoch ms
 * @returns {{ view: object, progressRoad: object, step: object }} minutes from now, clocks unrounded (job-rows.mjs rounds)
 */
export function roadView(road, runRoad, pick, nowMs) {
  const current = runRoad.current;
  const endOf = (step) => (step === current ? pick : runRoad.steps[step] ?? null);
  const lines = Array.from({ length: road.steps }, (_, k) => {
    const step = k + 1;
    const rows = road.rowsOf.get(step) ?? [];
    const state = step < current ? 'done' : step === current ? 'now' : 'next';
    const end = state === 'done' ? null : endOf(step);
    return { step, state, leftMin: end?.p50 ?? 0, p80Min: end?.p80 ?? 0, rowsDone: rows.filter((row) => row.done).length, rowsTotal: rows.length };
  });
  const now = lines[current - 1];
  const totalMin = lines.reduce((max, line) => Math.max(max, line.leftMin), 0);
  const clockMs = nowMs + pick.p50 * MS_PER_MIN;
  const p85Ms = nowMs + pick.p80 * MS_PER_MIN;
  const stepsLeft = lines.filter((line) => line.state !== 'done').length;
  const lanes = lanesOf(road.rowsOf.get(current) ?? []);
  return {
    view: { name: road.road, step: current, steps: road.steps, lines, totalMin, stepsLeft, stepClockMs: clockMs, stepP85Ms: p85Ms },
    progressRoad: { name: road.road, step: current, steps: road.steps, rowsDone: now.rowsDone, rowsTotal: now.rowsTotal, leftMin: pick.p50, clockMs, p85Ms, totalMin, lines },
    step: { road: road.road, step: current, steps: road.steps, ...lanes, p50: pick.p50, p80: pick.p80 },
  };
}

/**
 * @param {{ fromMs: number, toMs: number, reason: string }[]} pauses pauses.mjs pausesOf
 * @returns {{ min: number, byReason: Record<string, number>, list: object[] }} minutes in all and per reason (E3: they move the clocks)
 */
export function pauseSummary(pauses) {
  const byReason = {};
  let min = 0;
  for (const pause of pauses) {
    const length = (pause.toMs - pause.fromMs) / MS_PER_MIN;
    byReason[pause.reason] = (byReason[pause.reason] ?? 0) + length;
    min += length;
  }
  return { min, byReason, list: pauses };
}

/**
 * The Check facts of the rows that stalled (R5): each counts as one fresh run of its kind (its pool's median), never more.
 * @param {string[]} ids forecastRuns' stalled ids
 * @param {object[]} rows the job's rows
 * @param {{ rowAgents: Map<string, { lastActiveMs: number }>, elapsedOf: (item: object) => number, countedOf: (kind: string) => number }} facts
 * @returns {{ kind: 'stalled', id: string, rowKind: string, startedMs: number, elapsedMin: number, agentQuietSinceMs: number | null, countedMin: number }[]}
 *   longest open first
 */
export function stalledChecks(ids, rows, { rowAgents, elapsedOf, countedOf }) {
  return rows.filter((item) => ids.includes(item.id)).map((item) => {
    const rowKind = kindOf(item);
    return { kind: 'stalled', id: item.id, rowKind, startedMs: item.started, elapsedMin: elapsedOf(item), agentQuietSinceMs: rowAgents.get(item.id)?.lastActiveMs ?? null, countedMin: countedOf(rowKind) };
  }).sort((a, b) => b.elapsedMin - a.elapsedMin);
}

/** @returns {{ kind: 'queued', road: string, rows: number }[]} R15: one Check fact per road left out of the job */
export const queuedChecks = (queued) => queued.map(({ road, rows }) => ({ kind: 'queued', road, rows }));
