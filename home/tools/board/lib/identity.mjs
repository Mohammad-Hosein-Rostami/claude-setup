// Identity colours of the status line and `/where` (spec-tui-3, owner 2026-11-22: "we need more colors so that we can know better
// which is where"): every work item (a workflow run, an agent outside workflows, a lane branch) gets one hue and one marker shape,
// kept for its name, so a workflow row and the git row of the branch it works on read as one item.
// Exports: boardIdentity(board, store?, nowMs?) -> identity (hues, branches, repos, runs, and `store`: the new assignment to save,
// or null when it did not change); hueOf(identity, key) -> number; runBranch(identity, runId) -> string | null; itemKey(identity,
// run) / agentKey(identity, agent) / worktreeKey(identity, wt) -> the name whose hue an item takes; markerOf(hue, look) -> `●` `◆` `▲`.
// Sticky hues (lead decision, fix round 1; stable per name and distinct on screen at once): a name's home hue is a hash of it into
// the HUE_CODES palette (cells.mjs). A name seen for the first time takes the first hue from its home that no live item uses (one
// whose marker shape no live item uses first, so NO_COLOR still tells three items apart); the assignment is kept in `store`
// ({ v, items: [{ name, hue, seenMs, sinceMs }] }, hue-store.mjs keeps it in a file) and an item keeps its hue for as long as it
// is live, so a hue never changes when other items join or leave. An item gone for more than GONE_MS is forgotten. With more than
// six live items the seventh and later share a hue (their home hue) with an earlier one. Without a store the names are
// given hues in name order, so the same board always looks the same.
// Ties: a workflow (and an agent) working in a lane worktree, the board's sure placement (repos.mjs placeAgents: `wt` set; never a
// guess from a folder), takes that branch's name, so it shares the branch's hue; a branch checked out in a main worktree is no lane;
// a finished agent counts for no lane. A worktree an isolated workflow agent got (`worktree-<runId>-<n>`) and the agents in it
// belong to that workflow's own hue. The marker shape is the hue's index mod 3.
// Invariants: pure (no I/O); never throws on any board shape (a name that is no string counts as none).
import { HUE_CODES } from './cells.mjs';

const MARKERS = ['●', '◆', '▲'];
const ASCII_MARKERS = ['*', '+', 'o'];
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const MS_PER_MIN = 60_000;
/** An item not seen for this long is forgotten: it takes a fresh hue when it comes back. */
const GONE_MS = 30 * MS_PER_MIN;
/** An item seen within this long is still the same live item; one back after longer re-checks that its hue is free. */
const CONTINUOUS_MS = 5 * MS_PER_MIN;
/** The last-seen time of a live item is rewritten only when this old, so a steady board writes nothing. */
const SEEN_REFRESH_MS = 2 * MS_PER_MIN;
const MAX_STORED_ITEMS = 64;
const MAX_STORED_NAME_CHARS = 120;
const STORE_VERSION = 1;

/** @returns {number} the home hue of a name: its FNV-1a hash into the palette */
function homeHue(name) {
  let hash = FNV_OFFSET;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0), FNV_PRIME) >>> 0;
  return hash % HUE_CODES.length;
}

/** The marker shape of a hue (an index into MARKERS). */
const shapeOf = (hue) => hue % MARKERS.length;
const listOf = (value) => (Array.isArray(value) ? value.filter((item) => item !== null && typeof item === 'object') : []);
const reposOf = (board) => [board?.repo, ...listOf(board?.repos)].filter((repo) => repo !== null && typeof repo === 'object');
const isName = (value) => typeof value === 'string' && value !== '';

/** The run whose isolated worktree (`worktree-<runId>`, `worktree-<runId>-<n>`) this name is; undefined for any other name. */
const isolatedRunOf = (name, runs) => (isName(name)
  ? runs.find((run) => isName(run.runId) && (name === `worktree-${run.runId}` || name.startsWith(`worktree-${run.runId}-`)))
  : undefined);

/** The lane branch an agent works on: its placed worktree's branch when that worktree is a lane (not a main checkout, not a workflow's isolated one). */
function laneBranchOf(agent, repos, runs) {
  if (!isName(agent.wt) || !isName(agent.branch)) return null;
  if (isolatedRunOf(agent.wt, runs) !== undefined || isolatedRunOf(agent.branch, runs) !== undefined) return null;
  const repo = repos.find((entry) => entry.name === agent.repo) ?? repos[0];
  const wt = listOf(repo?.worktrees).find((entry) => entry.name === agent.wt);
  return wt !== undefined && wt.main !== true ? agent.branch : null;
}

/** Each run's lane branch: the branch most of its running agents work on (ties: the first seen). A finished agent counts for none. */
function runBranches(board, repos, runs) {
  const counts = new Map();
  for (const agent of listOf(board?.agents)) {
    const branch = agent.state === 'done' ? null : laneBranchOf(agent, repos, runs);
    if (branch === null || !isName(agent.runId)) continue;
    const perRun = counts.get(agent.runId) ?? new Map();
    counts.set(agent.runId, perRun.set(branch, (perRun.get(branch) ?? 0) + 1));
  }
  return new Map([...counts].map(([runId, perRun]) => [runId, [...perRun].sort((a, b) => b[1] - a[1])[0][0]]));
}

/** The stored assignment as a map of name -> { hue, seenMs, sinceMs }; entries of a bad shape are left out, a bad store is empty. */
function storedItems(store) {
  const items = store !== null && typeof store === 'object' && store.v === STORE_VERSION ? listOf(store.items) : [];
  const valid = items.filter((item) => isName(item.name) && Number.isInteger(item.hue) && item.hue >= 0 && item.hue < HUE_CODES.length
    && Number.isFinite(item.seenMs) && Number.isFinite(item.sinceMs));
  return new Map(valid.map((item) => [item.name, { hue: item.hue, seenMs: item.seenMs, sinceMs: item.sinceMs }]));
}

/** The hue a new item takes: the first free one from its home, one with a marker shape no live item has first; its home when none is free. */
function freshHue(name, used) {
  const home = homeHue(name);
  const free = HUE_CODES.map((_, step) => (home + step) % HUE_CODES.length).filter((hue) => !used.has(hue));
  const shapes = new Set([...used].map(shapeOf));
  return free.find((hue) => !shapes.has(shapeOf(hue))) ?? free[0] ?? home;
}

/**
 * @param {string[]} keys the names of the live items, most important first (new names take hues in this order)
 * @param {Map<string, { hue: number, seenMs: number, sinceMs: number }>} stored the earlier assignment
 * @param {number} nowMs the clock
 * @returns {Map<string, number>} the hue of every live name
 */
function assignHues(keys, stored, nowMs) {
  const hues = new Map();
  const used = new Set();
  const keep = (key, hue) => { hues.set(key, hue); used.add(hue); };
  const known = keys.filter((key) => stored.has(key));
  for (const key of known.filter((name) => nowMs - stored.get(name).seenMs <= CONTINUOUS_MS)) keep(key, stored.get(key).hue);
  const back = known.filter((name) => !hues.has(name)).sort((a, b) => stored.get(a).sinceMs - stored.get(b).sinceMs);
  for (const key of back) if (!used.has(stored.get(key).hue)) keep(key, stored.get(key).hue);
  for (const key of keys.filter((name) => !hues.has(name))) keep(key, freshHue(key, used));
  return hues;
}

/** The store to save: the live items with their hues (seen-time kept while fresh), the others still inside GONE_MS; null when unchanged. */
function nextStore(hues, stored, nowMs) {
  const live = [...hues].filter(([name]) => name.length <= MAX_STORED_NAME_CHARS).map(([name, hue]) => {
    const before = stored.get(name);
    const fresh = before !== undefined && before.hue === hue && nowMs - before.seenMs <= SEEN_REFRESH_MS;
    return { name, hue, seenMs: fresh ? before.seenMs : nowMs, sinceMs: before?.sinceMs ?? nowMs };
  });
  const gone = [...stored].filter(([name, item]) => !hues.has(name) && nowMs - item.seenMs <= GONE_MS)
    .map(([name, item]) => ({ name, ...item }));
  const items = [...live, ...gone].sort((a, b) => b.seenMs - a.seenMs || (a.name < b.name ? -1 : 1)).slice(0, MAX_STORED_ITEMS);
  const asText = (list) => JSON.stringify([...list].sort((a, b) => (a.name < b.name ? -1 : 1)));
  const before = [...stored].map(([name, item]) => ({ name, ...item }));
  return asText(items) === asText(before) ? null : { v: STORE_VERSION, items };
}

/** The names of the board's live items, most important first: workflows, then lane branches, then the agents outside lanes. */
function liveKeys(identity, board, repos) {
  const lanes = repos.flatMap((repo) => listOf(repo.worktrees).filter((wt) => wt.main !== true && isolatedRunOf(wt.branch ?? wt.name, identity.runs) === undefined)
    .map((wt) => wt.branch ?? wt.name));
  const sorted = (names) => names.filter(isName).sort();
  return [...new Set([
    ...sorted(identity.runs.map((run) => itemKey(identity, run))), ...sorted(lanes), ...sorted(listOf(board?.agents).map((agent) => agentKey(identity, agent))),
  ])];
}

/**
 * @param {object | null} board the session's board (runs, agents, repo, repos)
 * @param {object | null} [store] the assignment saved earlier (`identity.store` of a previous call); none starts fresh
 * @param {number} [nowMs] the clock, for forgetting items gone for long
 * @returns {{ hues: Map<string, number>, branches: Map<string, string>, repos: object[], runs: object[], store: object | null }} the
 *   hue of every item name on the board, each run's lane branch, the repositories and runs they were read from, and the assignment
 *   to save (null when it did not change)
 */
export function boardIdentity(board, store = null, nowMs = 0) {
  const repos = reposOf(board);
  const runs = listOf(board?.runs);
  const identity = { hues: new Map(), branches: runBranches(board, repos, runs), repos, runs, store: null };
  const stored = storedItems(store);
  identity.hues = assignHues(liveKeys(identity, board, repos), stored, nowMs);
  identity.store = nextStore(identity.hues, stored, nowMs);
  return identity;
}

/** @returns {number} the hue of a name: the board's choice, else its home hue (a name the board did not list) */
export const hueOf = (identity, key) => identity?.hues?.get(key) ?? homeHue(isName(key) ? key : '');

/** @returns {string | null} the lane branch a run's agents work on, or null when none is known */
export const runBranch = (identity, runId) => identity?.branches?.get(runId) ?? null;

/** @returns {string} the name whose hue a workflow run takes: its lane branch, else its own name */
export const itemKey = (identity, run) => runBranch(identity, run?.runId) ?? (isName(run?.name) ? run.name : isName(run?.runId) ? run.runId : '?');

/** @returns {string} the name whose hue an agent takes: its lane branch, else its run's, else its own name */
export function agentKey(identity, agent) {
  const runs = listOf(identity?.runs);
  const branch = laneBranchOf(agent ?? {}, identity?.repos ?? [], runs);
  if (branch !== null) return branch;
  const run = runs.find((entry) => entry.runId === agent?.runId);
  return run ? itemKey(identity, run) : isName(agent?.name) ? agent.name : '?';
}

/** @returns {string} the name whose hue a worktree takes: its isolated workflow's, else its branch, else its folder name */
export function worktreeKey(identity, wt) {
  const run = isolatedRunOf(wt?.branch ?? wt?.name, listOf(identity?.runs));
  if (run !== undefined) return itemKey(identity, run);
  return isName(wt?.branch) ? wt.branch : isName(wt?.name) ? wt.name : '?';
}

/** @returns {string} the marker of a hue: `●`, `◆` or `▲` (ASCII `*`, `+`, `o`) */
export const markerOf = (hue, look) => (look.ascii ? ASCII_MARKERS : MARKERS)[shapeOf(hue)];
