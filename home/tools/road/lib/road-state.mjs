// Purpose: where a road stands, from the STATUS.md rows (spec-stages sections 3-5): the current step, its lanes, held and carried lanes, the
//   road-start tip and landed ranges written in the rows.
// Exports: stepState(road, items), roadStartTip(road, items), landedLine(evidence), laneLanded(rows, roadId, step, laneName),
//   landingRowId(rows, roadId, step, laneName), isOldFormRoad(rows, roadId), correctionRows(rows, id), isReworkRow(row), reviewedLine(evidence),
//   isUiLane(lane, isUiPath), earlyLanes(road, items, state, { budget, isUiPath, isOnBase }), needsNotOnBase(road, items, laneName, isOnBase),
//   inFlightBranches(roads, items), MAX_LANES_PER_RUN.
// Rules: a row is done when its done cell is set (parseWorkItems). Current step = the lowest step whose check row is not done; none open:
//   `done`. A road is old form when STATUS.md holds a close row of it (`<road>.s<N>.<name>-land`, not a `rework:` row: roads whose rows
//   were written before one row per lane); then every lane's landing row is its close row `<lane row>-land`, and a lane without one has not
//   landed. Else (new form) the landing row is the lane row itself, where land-lane writes the landing as the done evidence. A lane is
//   landed (laneLanded, the one landed rule of stepState, the gate and the board) when its landing row is done and is not a `rework:` row
//   (a fix row never lands a lane); in the new form the done cell is not enough (it may have been set when the build ended): the row, or
//   its `<id>.landed` correction row, must also hold a `landed <to> on <base>` line. A lane is held while a
//   lane it needs (default: every lane of the earlier steps) is not landed. Carried = lanes of earlier steps (check row done) not landed;
//   they come first and count toward the 5, after the started lanes of later steps (started early: their agents run, so they keep
//   their slots and fewer current lanes are listed). State `gate` when every lane of the step has landed and nothing is carried, else `build`.
//   `writers` = the smallest of the lane count plus their test lanes, the budget and 5.
// Early lanes (owner FR2: fill up to 5 agents): a lane of a step after the current one starts early when its row exists, it has not
//   landed, it is no UI lane, it has a `needs` list (omitted = every earlier lane: it waits) naming only lanes of earlier steps, all
//   landed by its row and on the base in git (needsNotOnBase: the landed `<to>` is an ancestor of the base tip, `isOnBase`; a row alone
//   is never trusted), and none of its files overlaps (road-file.mjs filesShare) a not-landed lane of a lower step (carried included), a started lane, or an
//   early lane already chosen (`appendOnly` exempts files only between lanes of the same step). Started lanes come first and are never
//   dropped for the count; the others fill `min(budget, 5) - lanes - started early lanes` slots in step and lane order, so lanes plus
//   early stay within min(budget, 5) whenever the started early lanes fit in it. Every other
//   not-landed later lane is `waiting` with the reason. Needs and files come only from the road file; a started row never skips a check.
// Invariants: pure; row ids follow road-file.mjs rowIds; laneLanded is for planning and counting: the gate still checks the landed line
//   of the landing row against git.
import { MAX_LANES_PER_STEP, filesShare, rowIds } from './road-file.mjs';

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

const isStarted = (rows, entry) => rows.get(entry.ids.lane.toLowerCase())?.started != null || rows.get(entry.ids.close.toLowerCase())?.started != null;
/**
 * The lanes in flight of the given roads (roads that share one STATUS.md): a lane row (or close row) started, the lane not landed.
 * @param {object[]} roads checked roads
 * @param {object[]} items parseWorkItems(...).items of their STATUS.md
 * @returns {Map<string, string>} branch -> lane row id
 */
export function inFlightBranches(roads, items) {
  const rows = byId(items);
  const flying = new Map();
  for (const road of roads) {
    for (const entry of laneEntries(road)) if (isStarted(rows, entry) && !laneLanded(rows, road.road, entry.step, entry.lane.name)) flying.set(entry.lane.branch, entry.ids.lane);
  }
  return flying;
}

const landedNames = (rows, road, all) => new Set(all.filter((entry) => laneLanded(rows, road.road, entry.step, entry.lane.name)).map((entry) => entry.lane.name));

/** The `<to>` sha a landed lane's row (or its one correction row) records, or null: not landed, or no landed line. */
function landedTip(rows, roadId, entry) {
  if (!laneLanded(rows, roadId, entry.step, entry.lane.name)) return null;
  const id = landingRowId(rows, roadId, entry.step, entry.lane.name);
  const own = landedLine(rows.get(id.toLowerCase())?.evidence);
  if (own !== null) return own.to;
  const corrections = correctionRows(rows, id);
  return corrections.length === 1 && corrections[0].done != null ? (landedLine(corrections[0].evidence)?.to ?? null) : null;
}

/**
 * The lanes a lane needs (its `needs` list from the road file; omitted = every lane of the earlier steps) that have not landed on the base
 * in git: no landed row, no landed `<to>` line, or a `<to>` that `isOnBase` does not confirm (a forged or stale row). A lane name the
 * road does not hold is returned as missing (fail closed).
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items of the road's STATUS.md
 * @param {string} laneName the lane whose needs are judged
 * @param {(sha: string) => boolean} isOnBase true when git shows the sha on the road's base (an ancestor of its tip)
 * @returns {string[]} the needed lane names not on the base, in road order; [] for a lane that needs nothing
 */
export function needsNotOnBase(road, items, laneName, isOnBase) {
  const rows = byId(items);
  const all = laneEntries(road);
  const entry = all.find((candidate) => candidate.lane.name === laneName);
  if (entry === undefined) return [laneName];
  const needs = Array.isArray(entry.lane.needs) ? entry.lane.needs : all.filter((other) => other.step < entry.step).map((other) => other.lane.name);
  return needs.filter((name) => {
    const needed = all.find((other) => other.lane.name === name && other.step < entry.step);
    const tip = needed === undefined ? null : landedTip(rows, road.road, needed);
    return tip === null || isOnBase(tip) !== true;
  });
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
  const landed = landedNames(rows, road, all);
  const carried = all.filter((entry) => entry.step < step && !landed.has(entry.lane.name));
  const held = [];
  const ready = [];
  for (const entry of all.filter((candidate) => candidate.step === step && !landed.has(candidate.lane.name))) {
    const needs = entry.lane.needs ?? all.filter((other) => other.step < step).map((other) => other.lane.name);
    const missing = needs.filter((name) => !landed.has(name));
    if (missing.length > 0) held.push({ name: entry.lane.name, why: `needs ${missing.join(', ')} landed first` });
    else ready.push(entry);
  }
  // Lanes of later steps that started early run already: they keep their slots, so fewer current lanes are listed (owner FR2: at most 5).
  const startedLater = all.filter((entry) => entry.step > step && !landed.has(entry.lane.name) && isStarted(rows, entry)).length;
  const lanes = [...carried, ...ready].slice(0, Math.max(0, MAX_LANES_PER_RUN - startedLater));
  const ownRows = all.filter((entry) => entry.step === step).flatMap((entry) => [entry.ids.lane, entry.ids.close]);
  const started = ownRows.some((id) => rows.get(id.toLowerCase())?.started != null);
  const state = carried.length === 0 && ready.length === 0 && held.length === 0 ? 'gate' : 'build';
  return { step, of, state, form: 'agents', lanes, held, carried: carried.map((entry) => entry.lane.name), started };
}

/** `{ file, with }` of the first file of the lane shared with one of `others` (files in `appendOnly` skipped for a same-step lane), or null. */
function sharedWith(entry, others, appendOnly) {
  for (const other of others) {
    const exempt = other.step === entry.step ? appendOnly : [];
    const file = entry.lane.files.find((own) => !exempt.includes(own) && (other.lane.files ?? [null]).some((theirs) => filesShare(own, theirs)));
    if (file !== undefined) return { file, with: other };
  }
  return null;
}

/** Why a later lane cannot start early on its own terms (row, UI, needs, files), or null. The slot count is judged by earlyLanes. */
function earlyBlock(entry, ctx) {
  const { lane } = entry;
  if (!ctx.rows.has(entry.ids.lane.toLowerCase())) return `no row ${entry.ids.lane} in STATUS.md: run rows first`;
  if (isUiLane(lane, ctx.isUiPath)) return 'a UI lane (matrix or UI file) waits for its step';
  if (!Array.isArray(lane.needs)) return 'no needs list: it needs every earlier lane, so it waits for its step';
  const unknown = lane.needs.filter((name) => !ctx.all.some((other) => other.step < entry.step && other.lane.name === name));
  if (unknown.length > 0) return `needs ${unknown.join(', ')}: not a lane of an earlier step`;
  const missing = lane.needs.filter((name) => !ctx.landed.has(name));
  if (missing.length > 0) return `needs ${missing.join(', ')} landed first`;
  const notInGit = lane.needs.length === 0 ? [] : needsNotOnBase(ctx.road, ctx.items, lane.name, ctx.isOnBase);
  if (notInGit.length > 0) return `needs ${notInGit.join(', ')} landed on ${ctx.road.base} in git first: git does not show the landing its row records`;
  if (!Array.isArray(lane.files) || lane.files.length === 0) return 'no files list';
  const blockers = ctx.open.filter((other) => other !== entry && (other.step < entry.step || ctx.started.has(other) || ctx.chosen.includes(other)));
  const shared = sharedWith(entry, blockers, ctx.appendOnly(entry.step));
  if (shared === null) return null;
  const { with: other } = shared;
  const kind = ctx.chosen.includes(other) ? 'early lane' : ctx.started.has(other) && other.step > entry.step ? 'started lane' : 'open lane';
  return `shares ${shared.file} with ${kind} ${other.lane.name} (step ${other.step}, not landed)`;
}

/**
 * The lanes of later steps that can start now to fill the free agent slots (owner FR2), and why each other later lane waits.
 * Pure: reads only the road (lane files and needs) and the rows; two runs at once give the same answer.
 * @param {object} road a checked road
 * @param {object[]} items parseWorkItems(...).items of the road's STATUS.md
 * @param {{ step: number, state: string, lanes: object[] }} state stepState(road, items)
 * @param {{ budget: number, isUiPath: (path: string) => boolean, isOnBase?: (sha: string) => boolean }} options budget: the lane budget
 *   (1-5); isUiPath: the UI-file rule; isOnBase: true when git shows a sha on the base (needsNotOnBase); without it no lane that needs
 *   another starts early
 * @returns {{ early: string[], waiting: { name: string, why: string }[] }} early: started lanes first, then step and lane order
 */
export function earlyLanes(road, items, state, { budget, isUiPath, isOnBase = () => false }) {
  if (state.state === 'done') return { early: [], waiting: [] };
  const rows = byId(items);
  const all = laneEntries(road);
  const landed = landedNames(rows, road, all);
  const open = all.filter((entry) => !landed.has(entry.lane.name));
  const later = open.filter((entry) => entry.step > state.step);
  const started = new Set(open.filter((entry) => isStarted(rows, entry)));
  const appendOnly = (step) => (Array.isArray(road.steps[step - 1].appendOnly) ? road.steps[step - 1].appendOnly : []);
  const ctx = { road, items, rows, all, landed, open, started, chosen: [], isUiPath, isOnBase, appendOnly };
  const startedLater = later.filter((entry) => started.has(entry)).length;
  // Started early lanes hold their slots first (never dropped), so only the rest is offered to new early lanes.
  let free = Math.min(Number.isInteger(budget) ? budget : 0, MAX_LANES_PER_RUN) - state.lanes.length - startedLater;
  const reasons = new Map();
  for (const entry of [...later.filter((candidate) => started.has(candidate)), ...later.filter((candidate) => !started.has(candidate))]) {
    const why = earlyBlock(entry, ctx) ?? (started.has(entry) || free > 0 ? null : `no free slot: budget ${budget}, ${state.lanes.length} current and ${ctx.chosen.length} early lanes`);
    if (why !== null) reasons.set(entry, why);
    else {
      ctx.chosen.push(entry);
      if (!started.has(entry)) free -= 1;
    }
  }
  return { early: ctx.chosen.map((entry) => entry.lane.name), waiting: later.filter((entry) => reasons.has(entry)).map((entry) => ({ name: entry.lane.name, why: reasons.get(entry) })) };
}
