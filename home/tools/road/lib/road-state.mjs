// Purpose: where a road stands, from the STATUS.md rows (spec-stages sections 3-5): the current step, its lanes, held and carried lanes, the
//   build args for the next run, and the road-start tip and landed ranges written in the rows.
// Exports: stepState(road, items), buildArgs(road, state, statusFile, budget), roadStartTip(road, items), landedLine(evidence),
//   reviewedLine(evidence), isUiLane(lane, isUiPath), MAX_LANES_PER_RUN.
// Rules: a row is done when its done cell is set (parseWorkItems). Current step = the lowest step whose check row is not done; none open:
//   `done`. A lane is landed when its close row is done. A lane is held while a lane it needs (default: every lane of the earlier steps) is
//   not landed. Carried = lanes of earlier steps (check row done) whose close row is open; they come first and count toward the 5. State
//   `gate` when every lane of the step has landed and nothing is carried, else `build`. `writers` = the smallest of the lane count plus
//   their test lanes, the budget and 5.
// Invariants: pure; row ids follow road-file.mjs rowIds.
import { MAX_LANES_PER_STEP, rowIds } from './road-file.mjs';

export const MAX_LANES_PER_RUN = MAX_LANES_PER_STEP;
const LANDED = /\blanded ([0-9a-f]{7,40}) on (\S+?)(?: from ([0-9a-f]{7,40}))?(?=[\s,;)]|$)/;
const REVIEWED = /\breviewed ([0-9a-f]{7,40}) clean\b/;
const START_TIP = /, base ([0-9a-f]{40})\b/;

/** `{ to, base, from }` of a close row's `landed <to> on <base> from <from>` evidence (from: null when missing), or null. */
export function landedLine(evidence) {
  const match = LANDED.exec(String(evidence ?? ''));
  return match === null ? null : { to: match[1], base: match[2], from: match[3] ?? null };
}

/** The sha of a lane row's `reviewed <sha> clean` evidence, or null. */
export const reviewedLine = (evidence) => REVIEWED.exec(String(evidence ?? ''))?.[1] ?? null;

const byId = (items) => new Map(items.map((item) => [item.id.toLowerCase(), item]));
const isDone = (rows, id) => rows.get(id.toLowerCase())?.done != null;

/** The road-start tip written in step 1's check item, or null. */
export function roadStartTip(road, items) {
  return START_TIP.exec(byId(items).get(rowIds(road.road, 1, 'x').check.toLowerCase())?.item ?? '')?.[1] ?? null;
}

/** True when the lane lists a UI file or folder (by the given predicate) or a matrix: such a lane is never carried. */
export const isUiLane = (lane, isUiPath) => typeof lane.matrix === 'string' || (lane.files ?? []).some((file) => isUiPath(file));

function laneEntries(road) {
  return road.steps.flatMap((step, at) => step.lanes.map((lane) => ({ lane, step: at + 1, ids: rowIds(road.road, at + 1, lane.name) })));
}

/**
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items of the road's STATUS.md
 * @returns {{ step: number, of: number, state: 'build'|'gate'|'done', form: 'build'|'agents', lanes: object[], held: {name: string, why: string}[],
 *   carried: string[], started: boolean }}
 */
export function stepState(road, items) {
  const rows = byId(items);
  const of = road.steps.length;
  const index = road.steps.findIndex((_, at) => !isDone(rows, rowIds(road.road, at + 1, 'x').check));
  if (index === -1) return { step: of, of, state: 'done', form: 'build', lanes: [], held: [], carried: [], started: false };
  const step = index + 1;
  const all = laneEntries(road);
  const landed = new Set(all.filter((entry) => isDone(rows, entry.ids.close)).map((entry) => entry.lane.name));
  const carried = all.filter((entry) => entry.step < step && !landed.has(entry.lane.name));
  const held = [];
  const ready = [];
  for (const entry of all.filter((candidate) => candidate.step === step && !landed.has(candidate.lane.name))) {
    const needs = entry.lane.needs ?? all.filter((other) => other.step < step).map((other) => other.lane.name);
    const missing = needs.filter((name) => !landed.has(name));
    if (missing.length > 0) held.push({ name: entry.lane.name, why: `needs ${missing.join(', ')} landed first` });
    else ready.push(entry);
  }
  const lanes = [...carried, ...ready].slice(0, MAX_LANES_PER_RUN);
  const ownRows = all.filter((entry) => entry.step === step).flatMap((entry) => [entry.ids.lane, entry.ids.close]);
  const started = ownRows.some((id) => rows.get(id.toLowerCase())?.started != null);
  const state = carried.length === 0 && ready.length === 0 && held.length === 0 ? 'gate' : 'build';
  return { step, of, state, form: road.steps[index].form ?? 'build', lanes, held, carried: carried.map((entry) => entry.lane.name), started };
}

/**
 * The args of the build run for the state's lanes (no scriptsDir: the skill adds it).
 * @param {object} road a checked road
 * @param {ReturnType<typeof stepState>} state
 * @param {string} statusFile the road's STATUS.md
 * @param {number} budget the lead's lane budget, 1-5
 * @returns {{ base: string, repo: string, suite: string, writers: number, statusFile: string, lanes: object[], appendOnly?: string[], resume: boolean }}
 */
export function buildArgs(road, state, statusFile, budget) {
  const lanes = state.lanes.map(({ lane, ids }) => {
    const { name, item, size, closeSize, needs, ...build } = lane;
    return { ...build, row: ids.lane, closeRow: ids.close, spec: lane.spec ?? road.spec };
  });
  const testLanes = lanes.filter((lane) => lane.acceptanceTests).length;
  const appendOnly = road.steps[state.step - 1]?.appendOnly;
  return {
    base: road.base, repo: road.repo, suite: road.suite, writers: Math.min(lanes.length + testLanes, budget, MAX_LANES_PER_RUN), statusFile, lanes,
    ...(Array.isArray(appendOnly) ? { appendOnly } : {}), resume: state.started,
  };
}
