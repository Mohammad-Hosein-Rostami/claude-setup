// Purpose: read and check a road file `road-<id>.json` (spec-stages section 3): a big job as fixed steps of 1-5 lanes each.
// Exports: readRoad(path) -> { road, problems, warnings, sha256 }, checkRoad(value) -> { problems, warnings }, roadRows(road, baseTip),
//   rowIds(road, step, lane), uiMatrixProblems(road, isUiPath), MAX_LANES_PER_STEP, ROAD_ID, LANE_NAME, MAX_ROW_ID_CHARS, pathsOverlap(a, b).
// Rules: road id `^[a-z][a-z0-9-]{0,7}$`; repo absolute (POSIX or a drive path); every step holds 1..MAX_LANES_PER_STEP lanes; lane names
//   `^[a-z0-9][a-z0-9-]{0,23}$`, unique, not `check`, not ending `-land`; every row id at most MAX_ROW_ID_CHARS; no file shared by two lanes
//   of a step unless the step lists it in `appendOnly` (a folder and a file in it overlap, as build's checkArgs says); `needs` names only
//   lanes of earlier steps; branches, files and the base pass fixed patterns before they reach build args or argv (P5). A step with
//   `form: "build"` reads as `agents` with the warning `step <N>: build form retired: runs as agents` (an omitted form is `agents`).
// Rows (one row per lane): roadRows writes per lane its lane row only (its landing is that row's done evidence) and per step a check
//   row. rowIds still names the `-land` close row so the rows of older roads, which have one, read as before (road-state.mjs
//   landingRowId); the close id stays within MAX_ROW_ID_CHARS so such a road keeps its ids. `closeSize` is read for those roads only.
// Done means (lead.md, architect.md): every lane needs a non-empty `checkpoints` list, the commands the lead runs itself before
//   accepting the lane, each with the exit it must return. No tool runs them; any item shape reads (a text, the old object shape).
// Guidance fields (owner decision CR7; optional, nothing runs them): `suite`, `threatModel`, a lane's `acceptanceTests`, `principles`,
//   `keepGreen`. When present they only need their plain shape: texts, a list of `{id, question}` (id `P<n>` or `F<n>`,
//   unique in the lane, a question of 10+ characters). `appendOnly` holds repo-relative paths.
// Invariants: pure except readRoad's one bounded read; never throws for bad input (a problem line instead). readRoad hashes the very bytes
//   it parsed, so `road.mjs join --road-sha256` judges the file the lead hashed, not a file changed between two reads.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_LANES_PER_STEP = 5; // the owner's hard cap (spec-stages section 4); agent-model-guard.mjs holds the same 5
export const ROAD_ID = /^[a-z][a-z0-9-]{0,7}$/;
export const LANE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_ROW_ID_CHARS = 40;
const MAX_ROAD_BYTES = 1024 * 1024;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SAFE_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0\r\n]{1,300}$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]{0,1000}$/;
const SIZES = new Set(['S', 'M', 'L']);
const FORMS = new Set(['build', 'agents']);
const MIN_QUESTION_CHARS = 10;
const MIN_MATRIX_REASON_CHARS = 15;
const PRINCIPLE_ID = /^[PF]\d{1,3}$/;

/** True when two repo-relative paths are the same or one is a folder holding the other. */
export function pathsOverlap(first, second) {
  const [a, b] = [first, second].map((path) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''));
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The lane row, close row (old form only: roads written before one row per lane) and check row ids of a lane in step `step` (1-based). */
export const rowIds = (road, step, lane) => ({ lane: `${road}.s${step}.${lane}`, close: `${road}.s${step}.${lane}-land`, check: `${road}.s${step}.check` });

const isText = (value) => typeof value === 'string' && value.trim() !== '';

function laneProblems(lane, where, roadId, step) {
  const problems = [];
  if (!LANE_NAME.test(String(lane?.name)) || lane.name === 'check' || lane.name.endsWith('-land')) problems.push(`${where}: name must match ${LANE_NAME}, not be "check" and not end in -land`);
  else if (rowIds(roadId, step, lane.name).close.length > MAX_ROW_ID_CHARS) problems.push(`${where}: row id ${rowIds(roadId, step, lane.name).close} is over ${MAX_ROW_ID_CHARS} chars`);
  if (!isText(lane?.item)) problems.push(`${where}: item must be a text`);
  if (!SIZES.has(lane?.size)) problems.push(`${where}: size must be S, M or L`);
  if (lane?.closeSize !== undefined && !SIZES.has(lane.closeSize)) problems.push(`${where}: closeSize must be S, M or L`);
  if (!BRANCH.test(String(lane?.branch))) problems.push(`${where}: branch must match ${BRANCH}`);
  if (!Array.isArray(lane?.files) || lane.files.length === 0 || !lane.files.every((file) => typeof file === 'string' && SAFE_PATH.test(file))) problems.push(`${where}: files must be a non-empty list of repo-relative paths`);
  if (lane?.acceptanceTests !== undefined && typeof lane.acceptanceTests !== 'boolean') problems.push(`${where}: acceptanceTests must be true or false`);
  if (!isText(lane?.implementer?.model) || !isText(lane?.implementer?.effort)) problems.push(`${where}: implementer needs model and effort`);
  if (lane?.needs !== undefined && !(Array.isArray(lane.needs) && lane.needs.every((name) => typeof name === 'string'))) problems.push(`${where}: needs must be a list of lane names`);
  return problems;
}

const isPathList = (list) => Array.isArray(list) && list.every((file) => typeof file === 'string' && SAFE_PATH.test(file));

/** Design questions of a lane are plain guidance: optional, and only their shape is read. */
function principleProblems(lane, where) {
  const list = lane?.principles;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`${where}: principles must be a list of {id, question}`];
  const problems = [];
  list.forEach((principle, index) => {
    if (!PRINCIPLE_ID.test(String(principle?.id))) problems.push(`${where}: principles[${index}] id ${JSON.stringify(principle?.id)} must be P<n> or F<n>`);
    if (typeof principle?.question !== 'string' || principle.question.trim().length < MIN_QUESTION_CHARS) problems.push(`${where}: principle ${principle?.id} needs a question of ${MIN_QUESTION_CHARS}+ characters`);
    if (list.findIndex((other) => other?.id === principle?.id) !== index) problems.push(`${where}: principle id ${principle?.id} is used twice`);
  });
  return problems;
}

/** The contract part of a lane: its Done means (`checkpoints`, required), the optional principles and keepGreen, and the matrix shape. */
function contractProblems(lane, where) {
  const problems = principleProblems(lane, where);
  if (!Array.isArray(lane?.checkpoints) || lane.checkpoints.length === 0) {
    problems.push(`${where}: checkpoints must be a non-empty list: the lane's Done means, the commands the lead runs before accepting it`);
  }
  if (lane?.keepGreen !== undefined && !isText(lane.keepGreen)) problems.push(`${where}: keepGreen must be a text`);
  if (lane?.matrix !== undefined && !isText(lane.matrix)) problems.push(`${where}: matrix must be a path or "none: <reason>"`);
  return problems;
}

const matrixUsable = (matrix) => typeof matrix === 'string' && (matrix.startsWith('none:') ? matrix.slice('none:'.length).trim().length >= MIN_MATRIX_REASON_CHARS : matrix.trim() !== '');

/**
 * Problem lines for lanes that list a UI file (by the given predicate) or run a ui-implementer and have no usable `matrix`.
 * @param {object} road a checked road
 * @param {(path: string) => boolean} isUiPath the UI-file definition of ui-proof
 * @returns {string[]}
 */
export function uiMatrixProblems(road, isUiPath) {
  return road.steps.flatMap((step, at) => step.lanes.filter((lane) => !matrixUsable(lane.matrix) && (lane.implementer.agentType === 'ui-implementer' || lane.files.some((file) => isUiPath(file))))
    .map((lane) => `step ${at + 1} lane ${lane.name}: a lane with a UI file or a ui-implementer needs matrix: a coverage matrix path, or "none: <reason of ${MIN_MATRIX_REASON_CHARS}+ characters>"`));
}

function stepProblems(step, at, roadId, earlier) {
  const where = `step ${at + 1}`;
  if (!Array.isArray(step?.lanes) || step.lanes.length === 0) return [`${where}: a step needs at least one lane`];
  const problems = step.lanes.length > MAX_LANES_PER_STEP ? [`${where}: ${step.lanes.length} lanes; a step holds at most ${MAX_LANES_PER_STEP}: split the step`] : [];
  if (step.form !== undefined && !FORMS.has(step.form)) problems.push(`${where}: form must be "agents" ("build" is retired and still read as agents)`);
  if (step.appendOnly !== undefined && !isPathList(step.appendOnly)) problems.push(`${where}: appendOnly must be a list of repo-relative paths`);
  const appendOnly = Array.isArray(step.appendOnly) ? step.appendOnly : [];
  step.lanes.forEach((lane, index) => {
    problems.push(...laneProblems(lane, `${where} lane ${lane?.name ?? index + 1}`, roadId, at + 1));
    problems.push(...contractProblems(lane, `${where} lane ${lane?.name ?? index + 1}`));
    for (const need of lane?.needs ?? []) if (!earlier.has(need)) problems.push(`${where} lane ${lane.name}: needs ${need}, which is not a lane of an earlier step`);
  });
  for (let i = 0; i < step.lanes.length; i++) {
    for (let j = i + 1; j < step.lanes.length; j++) {
      const shared = (step.lanes[i]?.files ?? []).filter((file) => (step.lanes[j]?.files ?? []).some((other) => pathsOverlap(file, other)) && !appendOnly.includes(file));
      if (shared.length > 0) problems.push(`${where}: lanes ${step.lanes[i].name} and ${step.lanes[j].name} share ${shared.join(', ')}: split them or list it in appendOnly`);
    }
  }
  return problems;
}

/** `form: "build"` is retired with the Workflow tool: the file still reads, and the step runs as agents. */
function retiredFormWarnings(road) {
  return road.steps.flatMap((step, at) => (step.form === 'build' ? [`step ${at + 1}: build form retired: runs as agents`] : []));
}

/**
 * Checks a parsed road value.
 * @param {unknown} value the JSON value
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkRoad(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { problems: ['the road file must hold one JSON object'], warnings: [] };
  const problems = [];
  if (!ROAD_ID.test(String(value.road))) problems.push(`road must match ${ROAD_ID}`);
  for (const key of ['goal', 'spec']) if (!isText(value[key])) problems.push(`${key} must be a text`);
  for (const key of ['suite', 'threatModel']) if (value[key] !== undefined && !isText(value[key])) problems.push(`${key} must be a text when given`);
  if (!ABSOLUTE.test(String(value.repo))) problems.push('repo must be an absolute path');
  if (!BRANCH.test(String(value.base))) problems.push('base must be a branch name');
  if (value.questions !== undefined && !Array.isArray(value.questions)) problems.push('questions must be a list');
  if (!Array.isArray(value.steps) || value.steps.length === 0) return { problems: [...problems, 'steps must hold at least one step'], warnings: [] };
  const seen = new Set();
  value.steps.forEach((step, at) => {
    problems.push(...stepProblems(step, at, String(value.road), new Set(seen)));
    for (const lane of step?.lanes ?? []) {
      if (seen.has(lane?.name)) problems.push(`lane name ${lane.name} is used twice`);
      seen.add(lane?.name);
    }
  });
  return { problems, warnings: problems.length === 0 ? [...retiredFormWarnings(value)] : [] };
}

/**
 * Reads and checks a road file.
 * @param {string} path the road file
 * @returns {{ road: object | null, problems: string[], warnings: string[], sha256?: string }} road is null when any problem was found; sha256
 *   is the hash of the bytes that were parsed (missing when the file could not be read)
 */
export function readRoad(path) {
  let fd;
  let value;
  let sha256;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ROAD_BYTES) return { road: null, problems: [`${path} is not a regular file of at most ${MAX_ROAD_BYTES} bytes`], warnings: [] };
    const buffer = Buffer.alloc(stat.size);
    const bytes = buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0));
    sha256 = createHash('sha256').update(bytes).digest('hex');
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { road: null, problems: [`${path}: ${error.message}`], warnings: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const { problems, warnings } = checkRoad(value);
  return { road: problems.length === 0 ? value : null, problems, warnings, sha256 };
}

/**
 * Every row of the road (section 3): per lane its lane row (no close row: land-lane writes the landing as the lane row's done evidence),
 * per step its check row; step 1's check item carries the base tip.
 * @param {object} road a checked road
 * @param {string} baseTip the road-start tip (full sha), written once into step 1's check item
 * @returns {{ id: string, item: string, size: 'S'|'M'|'L' }[]}
 */
export function roadRows(road, baseTip) {
  return road.steps.flatMap((step, at) => {
    const n = at + 1;
    const lanes = step.lanes.map((lane) => ({ id: rowIds(road.road, n, lane.name).lane, item: `build: ${lane.item}`, size: lane.size }));
    return [...lanes, { id: rowIds(road.road, n, 'x').check, item: `close: step ${n} checkpoint${n === 1 ? `, base ${baseTip}` : ''}`, size: 'S' }];
  });
}
