// Purpose: read and check a road file `road-<id>.json` (spec-stages section 3): a big job as fixed steps of 1-5 lanes each.
// Exports: readRoad(path) -> { road, problems, warnings }, checkRoad(value) -> { problems, warnings }, roadRows(road, baseTip),
//   rowIds(road, step, lane), MAX_LANES_PER_STEP, ROAD_ID, LANE_NAME, MAX_ROW_ID_CHARS, pathsOverlap(a, b).
// Rules: road id `^[a-z][a-z0-9-]{0,7}$`; repo absolute (POSIX or a drive path); every step holds 1..MAX_LANES_PER_STEP lanes; lane names
//   `^[a-z0-9][a-z0-9-]{0,23}$`, unique, not `check`, not ending `-land`; every row id at most MAX_ROW_ID_CHARS; no file shared by two lanes
//   of a step unless the step lists it in `appendOnly` (a folder and a file in it overlap, as build's checkArgs says); `needs` names only
//   lanes of earlier steps; branches, files and the base pass fixed patterns before they reach build args or argv (P5). Warning (section 6):
//   two lanes of a step that name the same earlier lane in `needs`, or share an appendOnly contract file, while no earlier lane has a
//   checkpoint (the integration test the contract step lands).
// Invariants: pure except readRoad's one bounded read; never throws for bad input (a problem line instead).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_LANES_PER_STEP = 5; // the owner's hard cap (spec-stages section 4); build.js and agent-model-guard.mjs hold the same 5
export const ROAD_ID = /^[a-z][a-z0-9-]{0,7}$/;
export const LANE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_ROW_ID_CHARS = 40;
const MAX_ROAD_BYTES = 1024 * 1024;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SAFE_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0\r\n]{1,300}$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])[^\0\r\n]{0,1000}$/;
const SIZES = new Set(['S', 'M', 'L']);
const FORMS = new Set(['build', 'agents']);

/** True when two repo-relative paths are the same or one is a folder holding the other. */
export function pathsOverlap(first, second) {
  const [a, b] = [first, second].map((path) => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, ''));
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The lane row, close row and check row ids of a lane in step `step` (1-based). */
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
  if (typeof lane?.acceptanceTests !== 'boolean') problems.push(`${where}: acceptanceTests must be true or false`);
  if (!isText(lane?.implementer?.model) || !isText(lane?.implementer?.effort)) problems.push(`${where}: implementer needs model and effort`);
  if (lane?.needs !== undefined && !(Array.isArray(lane.needs) && lane.needs.every((name) => typeof name === 'string'))) problems.push(`${where}: needs must be a list of lane names`);
  return problems;
}

function stepProblems(step, at, roadId, earlier) {
  const where = `step ${at + 1}`;
  if (!Array.isArray(step?.lanes) || step.lanes.length === 0) return [`${where}: a step needs at least one lane`];
  const problems = step.lanes.length > MAX_LANES_PER_STEP ? [`${where}: ${step.lanes.length} lanes; a step holds at most ${MAX_LANES_PER_STEP}: split the step`] : [];
  if (step.form !== undefined && !FORMS.has(step.form)) problems.push(`${where}: form must be "build" or "agents"`);
  const appendOnly = Array.isArray(step.appendOnly) ? step.appendOnly : [];
  step.lanes.forEach((lane, index) => {
    problems.push(...laneProblems(lane, `${where} lane ${lane?.name ?? index + 1}`, roadId, at + 1));
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

/** Section 6: lanes of one step that share an earlier lane or a contract file need an integration test landed by an earlier lane. */
function contractWarnings(road) {
  const warnings = [];
  road.steps.forEach((step, at) => {
    const earlierChecks = road.steps.slice(0, at).some((earlier) => (earlier.lanes ?? []).some((lane) => (lane.checkpoints ?? []).length > 0));
    if (earlierChecks || (step.lanes ?? []).length < 2) return;
    const named = (step.lanes ?? []).flatMap((lane) => lane.needs ?? []);
    const sharedNeed = named.find((name, index) => named.indexOf(name) !== index);
    const sharedFile = (step.appendOnly ?? []).find((file) => step.lanes.filter((lane) => (lane.files ?? []).includes(file)).length > 1);
    if (sharedNeed || sharedFile) warnings.push(`step ${at + 1}: lanes share ${sharedNeed ? `lane ${sharedNeed}` : `file ${sharedFile}`} and no earlier lane lands an integration test (a checkpoint)`);
  });
  return warnings;
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
  for (const key of ['goal', 'suite', 'spec']) if (!isText(value[key])) problems.push(`${key} must be a text`);
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
  return { problems, warnings: problems.length === 0 ? contractWarnings(value) : [] };
}

/**
 * Reads and checks a road file.
 * @param {string} path the road file
 * @returns {{ road: object | null, problems: string[], warnings: string[] }} road is null when any problem was found
 */
export function readRoad(path) {
  let fd;
  let value;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ROAD_BYTES) return { road: null, problems: [`${path} is not a regular file of at most ${MAX_ROAD_BYTES} bytes`], warnings: [] };
    const buffer = Buffer.alloc(stat.size);
    value = JSON.parse(buffer.toString('utf8', 0, readSync(fd, buffer, 0, stat.size, 0)));
  } catch (error) {
    return { road: null, problems: [`${path}: ${error.message}`], warnings: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const { problems, warnings } = checkRoad(value);
  return { road: problems.length === 0 ? value : null, problems, warnings };
}

/**
 * Every row of the road (section 3): per lane its lane and close row, per step its check row; step 1's check item carries the base tip.
 * @param {object} road a checked road
 * @param {string} baseTip the road-start tip (full sha), written once into step 1's check item
 * @returns {{ id: string, item: string, size: 'S'|'M'|'L' }[]}
 */
export function roadRows(road, baseTip) {
  return road.steps.flatMap((step, at) => {
    const n = at + 1;
    const lanes = step.lanes.flatMap((lane) => {
      const ids = rowIds(road.road, n, lane.name);
      return [{ id: ids.lane, item: `build: ${lane.item}`, size: lane.size }, { id: ids.close, item: `close: review and land ${lane.name}`, size: lane.closeSize ?? 'M' }];
    });
    return [...lanes, { id: rowIds(road.road, n, 'x').check, item: `close: step ${n} checkpoint${n === 1 ? `, base ${baseTip}` : ''}`, size: 'S' }];
  });
}
