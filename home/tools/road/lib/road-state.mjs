// Purpose: where a road stands, from the STATUS.md rows (spec-stages sections 3-5): the current step, its lanes, held and carried lanes, the
//   road-start tip and landed ranges written in the rows.
// Exports: stepState(road, items), roadStartTip(road, items), landedLine(evidence), laneLanded(rows, roadId, step, laneName),
//   landingRowId(rows, roadId, step, laneName), isOldFormRoad(rows, roadId), correctionRows(rows, id), isReworkRow(row), reviewedLine(evidence),
//   isUiLane(lane, isUiPath), MAX_LANES_PER_RUN.
// Rules: a row is done when its done cell is set (parseWorkItems). Current step = the lowest step whose check row is not done; none open:
//   `done`. A road is old form when STATUS.md holds a close row of it (`<road>.s<N>.<name>-land`, not a `rework:` row: roads whose rows
//   were written before one row per lane); then every lane's landing row is its close row `<lane row>-land`, and a lane without one has not
//   landed. Else (new form) the landing row is the lane row itself, where land-lane writes the landing as the done evidence. A lane is
//   landed (laneLanded, the one landed rule of stepState, the gate and the board) when its landing row is done and is not a `rework:` row
//   (a fix row never lands a lane); in the new form the done cell is not enough (it may have been set when the build ended): the row, or
//   its `<id>.landed` correction row, must also hold a `landed <to> on <base>` line. A lane is held while a
//   lane it needs (default: every lane of the earlier steps) is not landed. Carried = lanes of earlier steps (check row done) not landed;
//   they come first and count toward the 5. State `gate` when every lane of the step has landed and nothing is carried, else `build`.
//   `writers` = the smallest of the lane count plus their test lanes, the budget and 5.
// Invariants: pure; row ids follow road-file.mjs rowIds; laneLanded is for planning and counting: the gate still checks the landed line
//   of the landing row against git.
import { MAX_LANES_PER_STEP, rowIds } from './road-file.mjs';

export const MAX_LANES_PER_RUN = MAX_LANES_PER_STEP;
const LANDED = /\blanded ([0-9a-f]{7,40}) on (\S+?)(?: from ([0-9a-f]{7,40}))?(?=[\s,;)]|$)/;
const REVIEWED = /\breviewed ([0-9a-f]{7,40}) clean\b/;
const START_TIP = /, base ([0-9a-f]{40})\b/;
const LAND_SUFFIX = '-land';
const OLD_CLOSE_ID = /^[a-z][a-z0-9-]*\.s\d+\.[a-z0-9-]+-land$/;
const REWORK_ITEM = /^\s*rework:/i;

/** `{ to, base, from }` of a landing row's `landed <to> on <base> from <from>` evidence (from: null when missing), or null. */
export function landedLine(evidence) {
  const match = LANDED.exec(String(evidence ?? ''));
  return match === null ? null : { to: match[1], base: match[2], from: match[3] ?? null };
}

/** The sha of a lane row's `reviewed <sha> clean` evidence, or null. */
export const reviewedLine = (evidence) => REVIEWED.exec(String(evidence ?? ''))?.[1] ?? null;

const byId = (items) => new Map(items.map((item) => [item.id.toLowerCase(), item]));
const isDone = (rows, id) => rows.get(id.toLowerCase())?.done != null;

/** True for a `rework:` row (a fix row): it never records a lane's landing, whatever its id. */
export const isReworkRow = (row) => REWORK_ITEM.test(String(row?.item ?? ''));

/**
 * True when STATUS.md holds an old-form close row of the road: a done or open `<road>.s<N>.<name>-land` row that is not a rework row.
 * @param {Map<string, { id: string, item: string }>} rows the STATUS.md rows keyed by lower-case id
 * @param {string} roadId the road id
 * @returns {boolean}
 */
export function isOldFormRoad(rows, roadId) {
  const prefix = `${roadId.toLowerCase()}.s`;
  return [...rows].some(([key, row]) => key.startsWith(prefix) && OLD_CLOSE_ID.test(key) && !isReworkRow(row));
}

/**
 * The correction rows of a landing row (STATUS done cells are never changed, so a landing row done without its landed line is corrected
 * by a `.landed` row). An old-form close row `<lane>-land` has two ids, `<lane>-land.landed` and `<lane>.landed` (row ids are at most 40
 * characters, so the long form may not fit). A new-form row (a lane row, a rework row) owns only `<id>.landed`: `<id>-land.landed` alone
 * may be another row's (the fix row `fix-land` of a lane `fix`), so it is never read alone; with the own one present the pair is ambiguous,
 * as in the old form. Lookups are case-insensitive; the rows found are returned in that order (two = ambiguous).
 * @param {Map<string, object>} rows the STATUS.md rows keyed by lower-case id
 * @param {string} id the landing row id
 * @returns {object[]}
 */
export function correctionRows(rows, id) {
  const low = id.toLowerCase();
  const oldClose = low.endsWith(LAND_SUFFIX) && !isReworkRow(rows.get(low));
  const lane = oldClose ? low.slice(0, -LAND_SUFFIX.length) : low;
  const own = rows.get(`${lane}.landed`);
  const found = [rows.get(`${lane}${LAND_SUFFIX}.landed`), own].filter((row) => row !== undefined);
  return oldClose || own !== undefined ? found : [];
}

/**
 * The id of the row that records a lane's landing: its close row in an old-form road (isOldFormRoad), else the lane row.
 * @param {Map<string, { id: string, done: number | string | null, evidence: string }>} rows the STATUS.md rows keyed by lower-case id (done: parseWorkItems ms)
 * @param {string} roadId the road id
 * @param {number} step 1-based step of the lane
 * @param {string} laneName the lane name (also `fix-<name>` for a fix row)
 * @returns {string} the row id as rowIds writes it
 */
export function landingRowId(rows, roadId, step, laneName) {
  const ids = rowIds(roadId, step, laneName);
  return isOldFormRoad(rows, roadId) ? ids.close : ids.lane;
}

const holdsLandedLine = (row) => row?.done != null && landedLine(row.evidence) !== null;

/**
 * Whether a lane has landed: its landing row (landingRowId) is done and not a rework row; in the new form the row or its own correction
 * row also holds a landed line. A missing row is not landed (fail closed).
 * @param {Map<string, { id: string, done: number | string | null, evidence: string }>} rows the STATUS.md rows keyed by lower-case id (done: parseWorkItems ms)
 * @param {string} roadId the road id
 * @param {number} step 1-based step of the lane
 * @param {string} laneName the lane name
 * @returns {boolean}
 */
export function laneLanded(rows, roadId, step, laneName) {
  const id = landingRowId(rows, roadId, step, laneName);
  const row = rows.get(id.toLowerCase());
  if (row?.done == null || isReworkRow(row)) return false;
  if (isOldFormRoad(rows, roadId)) return true; // an old close row is closed only by the landing: read as before
  const corrections = correctionRows(rows, id);
  return holdsLandedLine(row) || (corrections.length === 1 && holdsLandedLine(corrections[0]));
}

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
 * @returns {{ step: number, of: number, state: 'build'|'gate'|'done', form: 'agents', lanes: object[], held: {name: string, why: string}[],
 *   carried: string[], started: boolean }}
 */
export function stepState(road, items) {
  const rows = byId(items);
  const of = road.steps.length;
  const index = road.steps.findIndex((_, at) => !isDone(rows, rowIds(road.road, at + 1, 'x').check));
  if (index === -1) return { step: of, of, state: 'done', form: 'agents', lanes: [], held: [], carried: [], started: false };
  const step = index + 1;
  const all = laneEntries(road);
  const landed = new Set(all.filter((entry) => laneLanded(rows, road.road, entry.step, entry.lane.name)).map((entry) => entry.lane.name));
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
  return { step, of, state, form: 'agents', lanes, held, carried: carried.map((entry) => entry.lane.name), started };
}
