// The job facts of the board (spec-tui-2 "Seen in the screenshot" and stat 2): the road the session's job walks (its id, goal, the
// current step's title and its lanes landed of all) and the trend of the job's finish clock (how far it last moved, later or sooner).
// Run only by the detached board refresh (refresh.mjs), never by the status line.
// Exports: jobFacts({ session, cwd, cache, nowMs }) -> { road, trend, repoDir, cache }.
// Sources: the session's linked STATUS.md (estimate table-store link), else <cwd>/STATUS.md; its estimate cache entry (segment-cache.mjs
// readEntry: highMs, progress.road with the road id and current step, the same rule the estimate uses); the road file
// `road-<id>.json` beside the STATUS.md (tools/road road-file.mjs readRoad); the STATUS.md rows (estimate items.mjs parseWorkItems):
// a lane is landed when its landing row is done: the close row `<road>.s<N>.<lane>-land` when STATUS.md holds one (older roads), else
// the lane row `<road>.s<N>.<lane>` (one row per lane) (tools/road road-state.mjs laneLanded, the rule the road gate uses).
// Rules: the road is read again only when the STATUS.md or the road file changed (mtime and size); the trend is the last move of the
// finish clock (highMs) of at least MOVE_MIN, kept TREND_SHOWN_MS after the move; the first sighting is no move.
// Invariants: never throws (any failure gives null facts and keeps the cache); reads regular files only, without following a link or
// waiting on a FIFO (STATUS.md through hooks/lib/plain-file.mjs, at most MAX_STATUS_BYTES; the road file only after lstat says it is a
// regular file); text from files reaches the terminal only through the render's cleanText. The step title loses a leading
// `step N,` (the road files repeat it: review S2).
import { lstatSync } from 'node:fs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { dirname, join } from 'node:path';
import { parseWorkItems } from '../../estimate/lib/items.mjs';
import { cacheDir, readEntry } from '../../estimate/lib/segment-cache.mjs';
import { linkedStatusPath, stateDir } from '../../estimate/lib/table-store.mjs';
import { readRoad } from '../../road/lib/road-file.mjs';
import { laneLanded } from '../../road/lib/road-state.mjs';

const MS_PER_MIN = 60_000;
const MOVE_MIN = 5; // a smaller move is a pause being counted, not news
const TREND_SHOWN_MS = 60 * MS_PER_MIN;
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 60;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const ROAD_NAME = /^[a-z][a-z0-9-]{0,7}$/;
const STEP_PREFIX = /^\s*step\s*\d+\s*[,:.)-]?\s*/i;

const clean = (text) => String(text ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, MAX_TEXT_CHARS);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const stampOf = (path) => { const info = lstatSync(path, { throwIfNoEntry: false }); return info?.isFile() ? `${info.mtimeMs}:${info.size}` : null; };

/** The STATUS.md of the session's job: the one it linked, else the one in its folder; null when neither is a plain file. */
function statusPathOf(session, cwd) {
  const linked = linkedStatusPath(stateDir(), session);
  if (linked !== null) return linked;
  const own = typeof cwd === 'string' ? join(cwd, 'STATUS.md') : null;
  return own !== null && stampOf(own) !== null ? own : null;
}

/** The current step of a road from its file and the STATUS.md rows: title, lanes landed of all; null without a readable road. */
function roadFacts(statusPath, name, step) {
  const roadFile = join(dirname(statusPath), `road-${name}.json`);
  if (!lstatSync(roadFile, { throwIfNoEntry: false })?.isFile()) return null; // no FIFO or link for readRoad's plain open
  const { road } = readRoad(roadFile);
  const plan = road?.steps?.[step - 1];
  if (!plan) return null;
  const text = readPlainFile(statusPath, MAX_STATUS_BYTES);
  const rows = new Map(parseWorkItems(text).items.map((item) => [String(item.id).toLowerCase(), item]));
  const lanes = Array.isArray(plan.lanes) ? plan.lanes : [];
  const landed = lanes.filter((lane) => laneLanded(rows, road.road, step, lane.name)).length;
  return { goal: clean(road.goal), title: clean(String(plan.goal ?? '').replace(STEP_PREFIX, '')), lanesDone: landed, lanesTotal: lanes.length, repo: typeof road.repo === 'string' ? road.repo : null };
}

/** The road of the job (cached while the files are unchanged); null when the job walks no road. */
function roadOf(statusPath, progressRoad, old) {
  const name = progressRoad?.name;
  const step = progressRoad?.step;
  if (typeof name !== 'string' || !ROAD_NAME.test(name) || !Number.isInteger(step) || step < 1) return { road: null, key: null };
  const key = `${name}:${step}:${stampOf(statusPath)}:${stampOf(join(dirname(statusPath), `road-${name}.json`))}`;
  if (old?.roadKey === key) return { road: old.road ?? null, key };
  const facts = roadFacts(statusPath, name, step);
  return { road: { name, step, steps: Number.isInteger(progressRoad.steps) ? progressRoad.steps : null, ...facts }, key };
}

/** The finish clock's last move: { deltaMin, atMs } while younger than TREND_SHOWN_MS, else null; and the clock to compare next. */
function trendOf(highMs, old, nowMs) {
  const before = isNumber(old?.highMs) ? old.highMs : null;
  let trend = old?.trend ?? null;
  if (isNumber(highMs) && before !== null && Math.abs(highMs - before) >= MOVE_MIN * MS_PER_MIN) {
    trend = { deltaMin: Math.round((highMs - before) / MS_PER_MIN), atMs: nowMs };
  }
  if (trend !== null && !(nowMs - trend.atMs < TREND_SHOWN_MS)) trend = null;
  return { trend, highMs: isNumber(highMs) ? highMs : before };
}

/**
 * @param {{ session: string, cwd: string, cache: object | null, nowMs: number }} source the session, its folder, the last job cache
 * @returns {{ road: object | null, trend: { deltaMin: number, atMs: number } | null, repoDir: string | null, cache: object }} road =
 *   { name, step, steps, goal, title, lanesDone, lanesTotal, repo } (goal to repo null without a road file); repoDir = the road's
 *   repository (where the job's git lives when the session folder is not a repository)
 */
export function jobFacts({ session, cwd, cache, nowMs }) {
  try {
    const statusPath = statusPathOf(session, cwd);
    if (statusPath === null) return { road: null, trend: null, repoDir: null, cache: {} };
    const entry = readEntry(cacheDir(), statusPath);
    const old = cache?.path === statusPath ? cache : null;
    const { road, key } = roadOf(statusPath, entry?.progress?.road, old);
    const { trend, highMs } = trendOf(entry?.highMs, old, nowMs);
    return { road, trend, repoDir: road?.repo ?? null, cache: { path: statusPath, roadKey: key, road, highMs, trend } };
  } catch {
    return { road: null, trend: null, repoDir: null, cache: cache ?? {} };
  }
}
