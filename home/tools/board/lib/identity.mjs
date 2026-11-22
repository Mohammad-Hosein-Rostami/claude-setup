// Identity colours of the status line and `/where` (spec-tui-3, owner 2026-11-22: "we need more colors so that we can know better
// which is where"): every work item (a workflow run, an agent outside workflows, a lane branch) gets one hue and one marker shape,
// kept for its name, so a workflow row and the git row of the branch it works on read as one item.
// Exports: boardIdentity(board) -> identity; hueOf(identity, key) -> number; runBranch(identity, runId) -> string | null;
// itemKey(identity, run) / agentKey(identity, agent) -> the name whose hue an item takes; markerOf(hue, look) -> `●` `◆` `▲`.
// Rules: a name's home hue is a hash of it into the HUE_CODES palette (cells.mjs); the names of one board are given hues in name
// order, each taking the first free hue from its home on whose marker shape no earlier name has (else the first free, else its
// home), so up to six items on screen never share a hue, up to three never share a shape, and a name's hue does not depend on the
// board's order. A workflow (and an agent) working in a lane worktree, the board's sure placement
// (repos.mjs placeAgents: `wt` set; never a guess from a folder), takes that branch's name, so it shares the branch's hue; a
// branch checked out in a main worktree is no lane. The marker shape is the hue's index mod 3, so NO_COLOR still tells items apart.
// Invariants: pure (no I/O); never throws on any board shape.
import { HUE_CODES } from './cells.mjs';

const MARKERS = ['●', '◆', '▲'];
const ASCII_MARKERS = ['*', '+', 'o'];
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;

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

/** The lane branch an agent works on: its placed worktree's branch when that worktree is not a main checkout; else null. */
function laneBranchOf(agent, repos) {
  if (!isName(agent.wt) || !isName(agent.branch)) return null;
  const repo = repos.find((entry) => entry.name === agent.repo) ?? repos[0];
  const wt = listOf(repo?.worktrees).find((entry) => entry.name === agent.wt);
  return wt !== undefined && wt.main !== true ? agent.branch : null;
}

/** Each run's lane branch: the branch most of its placed agents work on (ties: the first seen). */
function runBranches(board, repos) {
  const counts = new Map();
  for (const agent of listOf(board?.agents)) {
    const branch = laneBranchOf(agent, repos);
    if (branch === null || !isName(agent.runId)) continue;
    const perRun = counts.get(agent.runId) ?? new Map();
    counts.set(agent.runId, perRun.set(branch, (perRun.get(branch) ?? 0) + 1));
  }
  return new Map([...counts].map(([runId, perRun]) => [runId, [...perRun].sort((a, b) => b[1] - a[1])[0][0]]));
}

/**
 * @param {object | null} board the session's board (runs, agents, repo, repos)
 * @returns {{ hues: Map<string, number>, branches: Map<string, string>, repos: object[], runs: object[] }} the hue of every item name
 *   on the board, each run's lane branch, and the repositories and runs they were read from
 */
export function boardIdentity(board) {
  const repos = reposOf(board);
  const identity = { hues: new Map(), branches: runBranches(board, repos), repos, runs: listOf(board?.runs) };
  const keys = new Set([
    ...listOf(board?.runs).map((run) => itemKey(identity, run)),
    ...listOf(board?.agents).map((agent) => agentKey(identity, agent)),
    ...repos.flatMap((repo) => listOf(repo.worktrees).filter((wt) => wt.main !== true).map((wt) => wt.branch ?? wt.name)),
  ].filter(isName));
  const taken = new Set();
  for (const key of [...keys].sort()) {
    const home = homeHue(key);
    const free = HUE_CODES.map((_, step) => (home + step) % HUE_CODES.length).filter((hue) => !taken.has(hue));
    const shapes = new Set([...taken].map(shapeOf));
    const hue = free.find((candidate) => !shapes.has(shapeOf(candidate))) ?? free[0] ?? home;
    taken.add(hue);
    identity.hues.set(key, hue);
  }
  return identity;
}

/** @returns {number} the hue of a name: the board's choice, else its home hue (a name the board did not list) */
export const hueOf = (identity, key) => identity?.hues?.get(key) ?? homeHue(String(key ?? ''));

/** @returns {string | null} the lane branch a run's agents work on, or null when none is known */
export const runBranch = (identity, runId) => identity?.branches?.get(runId) ?? null;

/** @returns {string} the name whose hue a workflow run takes: its lane branch, else its own name */
export const itemKey = (identity, run) => runBranch(identity, run?.runId) ?? String(run?.name ?? run?.runId ?? '?');

/** @returns {string} the name whose hue an agent takes: its lane branch, else its run's, else its own name */
export function agentKey(identity, agent) {
  const branch = laneBranchOf(agent ?? {}, identity?.repos ?? []);
  if (branch !== null) return branch;
  const run = listOf(identity?.runs).find((entry) => entry.runId === agent?.runId);
  return run ? itemKey(identity, run) : String(agent?.name ?? '?');
}

/** @returns {string} the marker of a hue: `●`, `◆` or `▲` (ASCII `*`, `+`, `o`) */
export const markerOf = (hue, look) => (look.ascii ? ASCII_MARKERS : MARKERS)[shapeOf(hue)];
