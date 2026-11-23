// Which subagent works on which open row (R13), how many active minutes it has given the row, and which rows went quiet (R5).
// Exports: rowAgents(items, agents, intervalsOf) -> Map, quietRows(items, byRow, context) -> quiet rows, QUIET_MIN, STALL_FLOOR_MIN.
// Inputs: parser items (items.mjs: { id, kind, started, done, evidence }, epoch-ms stamps); the board's agents of THIS session only
// (board/lib/agents.mjs sessionAgents: { id, name: the shown label, description: the whole description or null, row: the row of
// its writer launch record or null, startMs });
// intervalsOf(agentId) -> the agent's own active-minute runs [[startMin, endMin)] (transcript-facts.mjs over its transcript) or null.
// Rules:
// - Only an open, started row counts: not done, not a deliver row, not `parked:` or `waiting:` (R3, R4); a row of a paused road
//   that never started gets no agent, so another plan's rows never borrow this session's agents.
// - Match (R13, F1): the launch record's row is the tool's own fact and wins (a record naming a row that is not open maps to none;
//   one naming no row of the table, e.g. cut by the board, falls to the description). Else the whole description (the board's
//   `description`; null when too long to be whole) must name one row: by its id, or by `Lane <lane>` (with `road <id>` when
//   given) where the lane is the part after `<road>.s<N>.`. A description naming two lanes, two roads, two row ids, a road the
//   row is not of, or a bare lane that any other road also has (in any state) maps to no row: a wrong row would be worse than
//   none (the row then takes the 95th-percentile rule).
// - A row's active minutes: its agents' runs (several agents on one row, e.g. a restart after a stop, are joined) clipped to the
//   row's start, joined over silences of at most IDLE_GAP_MIN (worked.mjs, so they compare with the kind pools); its last
//   activity is the end of the last active minute; its agent id is the one active last.
// - Quiet (R5): an agent silent for QUIET_MIN working minutes of the job; with no agent, a row open longer than
//   max(its pool's 95th percentile, STALL_FLOOR_MIN) working minutes (F2: old sessions and other machines have no board agents).
// Invariants: pure (no I/O, no clock); malformed agents, runs or items are skipped, so they fall to the stricter fallback rule.
import { nearestRank } from './forecast.mjs';
import { ROAD_ROW } from './road-steps.mjs';
import { workedMinutes, workingIntervals } from './worked.mjs';

/** Working minutes without a transcript entry after which a row's agent counts as stopped (estimate spec R5). */
export const QUIET_MIN = 15;
/** The least open time, in working minutes, before a row with no agent counts as stalled (spec U1: 3 real lanes ran 52-86 min). */
export const STALL_FLOOR_MIN = 90;
const STALL_SHARE = 0.95;
const MS_PER_MIN = 60_000;
const OUT_OF_CLOCK = /^(parked|waiting):/i; // R3 and R4 evidence prefixes on an open row
const AGENT_ID = /^[A-Za-z0-9]{1,40}$/; // the board's transcript name rule (agents.mjs TRANSCRIPT)
const LANE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/; // road-file.mjs LANE_NAME
const ROAD_NAME = /^[a-z][a-z0-9-]{0,7}$/; // road-file.mjs road id
const WORD_BREAK = /[\s,;()[\]{}<>"'`*|!?]+/; // ids keep `.`, `-`, `_` and `:`
const TRAILING_MARKS = /[.:]+$/;

const toMin = (ms) => ms / MS_PER_MIN;
const isRun = (run) => Array.isArray(run) && run.length === 2 && run.every(Number.isFinite) && run[0] < run[1];
const laneOf = (id) => ROAD_ROW.exec(id);

/** True for an open, started work row that is on the clock (not parked, not waiting). */
function isOpenStarted(item) {
  return item !== null && typeof item === 'object' && typeof item.id === 'string' && item.kind !== 'deliver'
    && Number.isFinite(item.started) && item.done === null && !OUT_OF_CLOCK.test(String(item.evidence ?? '').trim());
}

/** The rows, lanes and roads a description names (F1 reads every one of them, not the first). */
function namesIn(description, idsByLower) {
  const words = String(description ?? '').split(WORD_BREAK).map((word) => word.replace(TRAILING_MARKS, '')).filter(Boolean);
  const ids = new Set();
  const lanes = new Set();
  const roads = new Set();
  words.forEach((word, at) => {
    const lower = word.toLowerCase();
    const dotted = laneOf(word);
    if (idsByLower.has(lower) || dotted !== null) ids.add(lower);
    if (dotted !== null) { roads.add(dotted[1].toLowerCase()); lanes.add(dotted[3].toLowerCase()); }
    const next = words[at + 1]?.toLowerCase();
    if (lower === 'lane' && next !== undefined && LANE_NAME.test(next)) lanes.add(next);
    if (lower === 'road' && next !== undefined && ROAD_NAME.test(next)) roads.add(next);
  });
  return { ids, lanes, roads };
}

/**
 * What the matching needs of the table: the open rows, every id (lower case), and per lane name the roads that have a row of it
 * in any state (R1: a lane is only unique when no other road has it, started or not, done or not).
 */
function tableOf(items) {
  const rows = items.filter((item) => typeof item?.id === 'string');
  const roadsOfLane = new Map();
  for (const item of rows) {
    const road = laneOf(item.id);
    if (road === null) continue;
    const lane = road[3].toLowerCase();
    roadsOfLane.set(lane, new Set([...(roadsOfLane.get(lane) ?? []), road[1].toLowerCase()]));
  }
  return { openRows: items.filter(isOpenStarted), idsByLower: new Set(rows.map((item) => item.id.toLowerCase())), roadsOfLane };
}

/** The one open row a description names, or null (none, or more than one). */
function rowOfDescription(description, table) {
  const { ids, lanes, roads } = namesIn(description, table.idsByLower);
  if (ids.size > 1 || lanes.size > 1 || roads.size > 1) return null;
  const [lane] = lanes;
  // A bare `Lane <lane>` must not borrow another plan's row of the same name, even when this road's row is not started yet.
  if (ids.size === 0 && roads.size === 0 && (table.roadsOfLane.get(lane)?.size ?? 0) > 1) return null;
  const fits = (item) => {
    const road = laneOf(item.id);
    if (lanes.size === 1 && road?.[3].toLowerCase() !== lane) return false;
    return roads.size === 0 || road?.[1].toLowerCase() === [...roads][0];
  };
  const named = ids.size === 1 ? table.openRows.filter((item) => ids.has(item.id.toLowerCase())) : lanes.size === 1 ? table.openRows : [];
  const found = named.filter(fits);
  return found.length === 1 ? found[0] : null;
}

/**
 * The open row an agent works on: its launch record's row when that names a row of this table (open or not), else the row its
 * whole description names. A record row naming no row of the table (the board cuts it to 24 characters, R4) tells nothing.
 * The description is the board's whole `description` (null when too long: no row); an entry without that field gives `name`.
 */
function rowOfAgent(agent, table) {
  const recorded = typeof agent.row === 'string' ? agent.row.trim().toLowerCase() : '';
  if (recorded !== '' && table.idsByLower.has(recorded)) return table.openRows.find((item) => item.id.toLowerCase() === recorded) ?? null;
  return rowOfDescription(Object.hasOwn(agent, 'description') ? agent.description : agent.name, table);
}

/** Sorted, merged copies of runs. */
function joinedRuns(runs) {
  const merged = [];
  for (const [start, end] of [...runs].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** One row's entry from its agents' runs (already validated and clipped to the row's start). */
function entryOf(claims) {
  const runs = joinedRuns(claims.flatMap((claim) => claim.runs));
  const lastEndMin = runs.at(-1)[1];
  const intervals = workingIntervals(runs, lastEndMin);
  const newest = claims.reduce((best, claim) => (claim.lastEndMin > best.lastEndMin ? claim : best));
  return { agentId: newest.agentId, activeMin: workedMinutes(intervals, -Infinity, Infinity), lastActiveMs: lastEndMin * MS_PER_MIN };
}

/**
 * Each open, started row's agent (R13).
 * @param {object[]} items parser items
 * @param {object[]} agents this session's board agents (sessionAgents().agents); never another session's
 * @param {(agentId: string) => [number, number][] | null} intervalsOf the agent's own active-minute runs, null when unknown
 * @returns {Map<string, { agentId: string, activeMin: number, lastActiveMs: number }>} row id -> its agent, active minutes since the
 *   row started, and the end of its last active minute (epoch ms); rows with no agent found are absent
 */
export function rowAgents(items, agents, intervalsOf) {
  const table = tableOf(items);
  const claimsByRow = new Map();
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object' || !AGENT_ID.test(String(agent.id))) continue;
    const row = rowOfAgent(agent, table);
    const runs = row === null ? null : intervalsOf(agent.id);
    if (!Array.isArray(runs) || !runs.every(isRun)) continue;
    const startMin = Math.floor(toMin(row.started));
    const clipped = runs.filter(([, end]) => end > startMin).map(([start, end]) => [Math.max(start, startMin), end]);
    if (clipped.length === 0) continue;
    const claim = { agentId: agent.id, runs: clipped, lastEndMin: Math.max(...clipped.map(([, end]) => end)) };
    claimsByRow.set(row.id, [...(claimsByRow.get(row.id) ?? []), claim]);
  }
  return new Map([...claimsByRow].map(([id, claims]) => [id, entryOf(claims)]));
}

/**
 * The open, started rows that went quiet (R5): each counts as one fresh run of its kind and gets a `Check:` line.
 * @param {object[]} items parser items
 * @param {Map<string, { agentId: string, lastActiveMs: number }>} byRow from rowAgents
 * @param {{ poolOf: (item: object) => number[], intervals: [number, number][], nowMs: number }} context poolOf: the row's kind
 *   pool, sorted minutes (kinds.mjs kindPools); intervals: the job's working intervals (worked.mjs); nowMs: now
 * @returns {{ id: string, agentId: string | null, sinceMs: number }[]} in item order; sinceMs: the agent's last activity, or the
 *   row's start when no agent was found
 */
export function quietRows(items, byRow, { poolOf, intervals, nowMs }) {
  const nowMin = toMin(nowMs);
  return items.filter(isOpenStarted).flatMap((item) => {
    const agent = byRow.get(item.id);
    if (agent !== undefined) {
      const silentMin = workedMinutes(intervals, toMin(agent.lastActiveMs), nowMin);
      return silentMin >= QUIET_MIN ? [{ id: item.id, agentId: agent.agentId, sinceMs: agent.lastActiveMs }] : [];
    }
    const pool = poolOf(item);
    const usualLongest = Array.isArray(pool) && pool.length > 0 ? nearestRank(pool, STALL_SHARE) : 0;
    const openMin = workedMinutes(intervals, toMin(item.started), nowMin);
    return openMin > Math.max(usualLongest, STALL_FLOOR_MIN) ? [{ id: item.id, agentId: null, sinceMs: item.started }] : [];
  });
}
