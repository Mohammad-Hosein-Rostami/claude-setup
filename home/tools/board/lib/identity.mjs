// Identity colours of the status line and `/where` (spec-tui-3, owner 2026-11-22: "we need more colors so that we can know better
// which is where"): every work item (an agent or a lane branch) gets one hue and one marker shape, kept for its name, so an
// agent row and the git row of the branch it works on read as one item.
// Exports: boardIdentity(board, store?, nowMs?) -> identity (hues, repos, and `store`: the new assignment to save, or null when it did
// not change); hueOf(identity, key) -> number; agentKey(identity, agent) / worktreeKey(wt) -> the name whose hue an item
// takes; markerOf(hue, look) -> `●` `◆` `▲`.
// Sticky hues (lead decision, fix round 1; stable per name and distinct on screen at once): a name's home hue is a hash of it into
// the HUE_CODES palette (cells.mjs). A name seen for the first time takes the first hue from its home that no live item uses (one
// whose marker shape no live item uses first, so NO_COLOR still tells three items apart); the assignment is kept in `store`
// ({ v, items: [{ name, hue, seenMs, sinceMs, away? }] }, hue-store.mjs keeps it in a file) and an item keeps its hue for as long
// as it is live, so a hue never changes when other items join or leave. An item that was away (`away`) comes back with its hue only
// when no live item has taken it meanwhile, and a newcomer avoids the hue of an item gone only a moment, so up to six live items
// never share. An item gone for more than GONE_MS is forgotten. With more than six live items the seventh and later share a hue
// (their home hue) with an earlier one. Only items the rows draw hold a hue: a finished agent after DONE_SHOWN_MS does not. Without a store the names are given hues in name order, so the same board always looks the same.
// Ties: an agent working in a lane worktree, the board's sure placement (repos.mjs placeAgents: `wt` set; never a guess from a
// folder), takes that branch's name, so it shares the branch's hue; a branch checked out in a main worktree is no lane. The marker
// shape is the hue's index mod 3.
// Invariants: pure (no I/O); never throws on any board shape (a name that is no string counts as none).
import { DONE_SHOWN_MS, HUE_CODES } from './cells.mjs';

const MARKERS = ['●', '◆', '▲'];
const ASCII_MARKERS = ['*', '+', 'o'];
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const MS_PER_MIN = 60_000;
/** An item not seen for this long is forgotten: it takes a fresh hue when it comes back. */
const GONE_MS = 30 * MS_PER_MIN;
/** An item seen within this long and not away is the same live item; one that was away, or back after longer, re-checks that its hue is free; a hue gone only this long is kept from newcomers. */
const CONTINUOUS_MS = 5 * MS_PER_MIN;
/** The last-seen time of a live item is rewritten only when this old, so a steady board saves once per interval, not per render. */
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

/** The lane branch an agent works on: its placed worktree's branch when that worktree is a lane (not a main checkout). */
function laneBranchOf(agent, repos) {
  if (!isName(agent.wt) || !isName(agent.branch)) return null;
  const repo = repos.find((entry) => entry.name === agent.repo) ?? repos[0];
  const wt = listOf(repo?.worktrees).find((entry) => entry.name === agent.wt);
  return wt !== undefined && wt.main !== true ? agent.branch : null;
}

/** The stored assignment as a map of name -> { hue, seenMs, sinceMs, away? }; entries of a bad shape are left out, a bad store is empty. */
function storedItems(store) {
  const items = store !== null && typeof store === 'object' && store.v === STORE_VERSION ? listOf(store.items) : [];
  const valid = items.filter((item) => isName(item.name) && Number.isInteger(item.hue) && item.hue >= 0 && item.hue < HUE_CODES.length
    && Number.isFinite(item.seenMs) && Number.isFinite(item.sinceMs));
  return new Map(valid.map((item) => [item.name, { hue: item.hue, seenMs: item.seenMs, sinceMs: item.sinceMs, ...(item.away === true ? { away: true } : {}) }]));
}

/**
 * The hue a new item takes: the first free one from its home, one that no item gone only a moment holds first (it may come back),
 * then one with a marker shape no live item has; its home when none is free.
 */
function freshHue(name, used, held) {
  const home = homeHue(name);
  const free = HUE_CODES.map((_, step) => (home + step) % HUE_CODES.length).filter((hue) => !used.has(hue));
  const unheld = free.filter((hue) => !held.has(hue));
  const choices = unheld.length > 0 ? unheld : free;
  const shapes = new Set([...used].map(shapeOf));
  return choices.find((hue) => !shapes.has(shapeOf(hue))) ?? choices[0] ?? home;
}

/**
 * @param {string[]} keys the names of the live items, most important first (new names take hues in this order)
 * @param {Map<string, { hue: number, seenMs: number, sinceMs: number, away?: true }>} stored the earlier assignment
 * @param {number} nowMs the clock
 * @returns {Map<string, number>} the hue of every live name
 */
function assignHues(keys, stored, nowMs) {
  const hues = new Map();
  const used = new Set();
  const keep = (key, hue) => { hues.set(key, hue); used.add(hue); };
  const known = keys.filter((key) => stored.has(key));
  const live = new Set(keys);
  const justGone = new Set([...stored].filter(([name, item]) => !live.has(name) && nowMs - item.seenMs <= CONTINUOUS_MS).map(([, item]) => item.hue));
  // An item seen in the last render keeps its hue whatever it shares (a seventh item keeps sharing); one that was away, or unseen
  // for long, gets its old hue back only when no live item has taken it meanwhile, the one that stayed keeping it.
  const stayed = known.filter((name) => stored.get(name).away !== true && nowMs - stored.get(name).seenMs <= CONTINUOUS_MS);
  for (const key of stayed) keep(key, stored.get(key).hue);
  const back = known.filter((name) => !hues.has(name)).sort((a, b) => stored.get(a).sinceMs - stored.get(b).sinceMs);
  for (const key of back) if (!used.has(stored.get(key).hue)) keep(key, stored.get(key).hue);
  for (const key of keys.filter((name) => !hues.has(name))) keep(key, freshHue(key, used, justGone));
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
    .map(([name, item]) => ({ name, ...item, away: true }));
  // Live items first, in key order, so a board of more than MAX_STORED_ITEMS keeps the same ones and a steady board is saved only for the last-seen refresh.
  const newestFirst = (a, b) => b.seenMs - a.seenMs || (a.name < b.name ? -1 : 1);
  const items = [...live, ...gone.sort(newestFirst)].slice(0, MAX_STORED_ITEMS);
  const asText = (list) => JSON.stringify([...list].sort((a, b) => (a.name < b.name ? -1 : 1)));
  const before = [...stored].map(([name, item]) => ({ name, ...item }));
  return asText(items) === asText(before) ? null : { v: STORE_VERSION, items };
}

/** An agent the rows draw: not finished, or finished less than DONE_SHOWN_MS ago (layout.mjs shownAgents). */
const isShownAgent = (agent, nowMs) => agent.state !== 'done' || nowMs - agent.doneMs < DONE_SHOWN_MS;

/**
 * The names of the items the rows draw, most important first: lane branches, then the agents outside lanes. An agent the rows have
 * dropped holds no hue, so a new item never shares with one that is no longer on screen.
 */
function liveKeys(identity, board, repos, nowMs) {
  const lanes = repos.flatMap((repo) => listOf(repo.worktrees).filter((wt) => wt.main !== true).map((wt) => wt.branch ?? wt.name));
  const agents = listOf(board?.agents).filter((agent) => isShownAgent(agent, nowMs));
  const sorted = (names) => names.filter(isName).sort();
  return [...new Set([...sorted(lanes), ...sorted(agents.map((agent) => agentKey(identity, agent)))])];
}

/**
 * @param {object | null} board the session's board (agents, repo, repos)
 * @param {object | null} [store] the assignment saved earlier (`identity.store` of a previous call); none starts fresh
 * @param {number} [nowMs] the clock, for forgetting items gone for long
 * @returns {{ hues: Map<string, number>, repos: object[], store: object | null }} the hue of every item name on the board, the
 *   repositories they were read from, and the assignment to save (null when it did not change)
 */
export function boardIdentity(board, store = null, nowMs = 0) {
  const repos = reposOf(board);
  const identity = { hues: new Map(), repos, store: null };
  const stored = storedItems(store);
  identity.hues = assignHues(liveKeys(identity, board, repos, nowMs), stored, nowMs);
  identity.store = nextStore(identity.hues, stored, nowMs);
  return identity;
}

/** @returns {number} the hue of a name: the board's choice, else its home hue (a name the board did not list) */
export const hueOf = (identity, key) => identity?.hues?.get(key) ?? homeHue(isName(key) ? key : '');

/** @returns {string} the name whose hue an agent takes: its lane branch, else its own name */
export const agentKey = (identity, agent) => laneBranchOf(agent ?? {}, identity?.repos ?? []) ?? (isName(agent?.name) ? agent.name : '?');

/** @returns {string} the name whose hue a worktree takes: its branch, else its folder name */
export const worktreeKey = (wt) => (isName(wt?.branch) ? wt.branch : isName(wt?.name) ? wt.name : '?');

/** @returns {string} the marker of a hue: `●`, `◆` or `▲` (ASCII `*`, `+`, `o`) */
export const markerOf = (hue, look) => (look.ascii ? ASCII_MARKERS : MARKERS)[shapeOf(hue)];
