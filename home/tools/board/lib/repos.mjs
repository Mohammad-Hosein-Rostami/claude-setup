// The repositories the session's work is in, for the board's git rows (spec-tui-2 and the owner's report of 2026-11-21: no git info
// at all while two agents worked in worktrees, because the lead's folder is not in git). Run only by the detached board refresh.
// Exports: sessionRepos({ sessionFolder, agentDirs, preferred, cache, nowMs, startMs }) -> { repos, git, cache };
// placeAgents(agents, repos) -> { agents, repos }; MAX_REPOS.
// Which (lead decisions of fix rounds 3-5, 2026-11-22): only trusted repositories (trusted-repos.mjs: the session folder's and the
// setup's own, worked out on every refresh), and of those the ones with active work: the session's own, and each
// one a registered worktree of which holds a live agent's folder (its edited files, its launch worktree, its cwd; matched by path
// prefix, so no file in an agent's folder is read). With none, the trusted repository holding the STATUS.md folder, else the
// road's `repo`. Git runs in the trusted folder of each (never an agent's or the road's folder: git runs a repository's own config,
// `core.fsmonitor` and clean filters; review SEC-1 and its residual). The first MAX_REPOS are read with git-state.mjs repoState,
// sharing one git budget (`startMs`); the primary one (its `git` is the board's `git`) is the one holding a `preferred` folder (the
// STATUS.md folder, the road's `repo`), else the first: a preferred folder only orders, it never adds a repository. When git runs
// out of time (a loaded machine), a repository keeps its last good state up to STALE_KEEP_MS, marked `stale`, instead of vanishing.
// The cache holds git results only (a writable file: it never decides where git runs; git-state.mjs checks every worktree path).
// Invariants: never throws; no git call here (repoState makes them).
import { basename, dirname, isAbsolute, sep } from 'node:path';
import { repoState } from './git-state.mjs';
import { REMOTE_PATH, repoOfDir, trustedRepos } from './trusted-repos.mjs';

/** At most this many repositories are read per refresh (they share one 250 ms git budget in git-state.mjs). */
export const MAX_REPOS = 3;
const STALE_KEEP_MS = 60_000; // a repository git could not read in time shows its last good state this long, marked stale

/** This refresh's state of a repository, else (git ran out of time under load) its last good one, marked stale, while fresh enough. */
function stateOrLast(state, last, nowMs) {
  if (state.repo !== null && state.repo.worktrees.length > 0) return { repo: state.repo, git: state.git, last: { repo: state.repo, git: state.git, atMs: nowMs } };
  if (last !== null && typeof last === 'object' && last.repo && nowMs - last.atMs <= STALE_KEEP_MS) return { repo: { ...last.repo, stale: true }, git: last.git, last };
  return { repo: null, git: null, last: null };
}

/** The trusted repositories to read: the session's and those with a live agent in them, else the STATUS.md or road one. */
function chosenRepos(trust, agentDirs, preferred) {
  const active = agentDirs.map((dir) => repoOfDir(trust.repos, dir)).filter((repo) => repo !== undefined);
  const chosen = [...new Set([trust.session, ...active].filter((repo) => repo !== null))];
  if (chosen.length > 0) return chosen.slice(0, MAX_REPOS);
  return preferred.map((dir) => repoOfDir(trust.repos, dir)).filter((repo) => repo !== undefined).slice(0, 1);
}

const isInside = (dir, path) => dir === path || dir.startsWith(`${path}${sep}`);

/** The repositories with the first one holding a preferred folder moved to the front, each with its own `git`. */
function preferredFirst(found, preferred) {
  const dirs = preferred.filter((dir) => typeof dir === 'string' && isAbsolute(dir));
  const at = found.findIndex(({ repo }) => repo.worktrees.some((wt) => dirs.some((dir) => isInside(dir, wt.path))));
  return at > 0 ? [found[at], ...found.slice(0, at), ...found.slice(at + 1)] : found;
}

/**
 * @param {{ sessionFolder: string | null, agentDirs?: (string | null | undefined)[], preferred?: (string | null | undefined)[],
 *   cache: object | null, nowMs: number, startMs?: number }} source the session's folder, the folders of the live agents, the
 *   folders whose repository is shown first (STATUS.md folder, road repo), the last cache ({ byCommon: { [common]: git cache } })
 *   and when the refresh's git budget started
 * @returns {{ repos: object[], git: object | null, cache: object }} repos = git-state.mjs repo plus `name` (the main worktree's
 *   folder name), primary first; git = the primary repository's own { branch, ahead, behind, changed } or null
 */
export function sessionRepos({ sessionFolder, agentDirs = [], preferred = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache !== null && typeof cache === 'object' && cache.byCommon ? cache.byCommon : {};
  try {
    const trust = trustedRepos({ sessionFolder });
    const found = [];
    const byCommon = {};
    for (const { common, folder } of chosenRepos(trust, agentDirs, preferred)) {
      const state = repoState({ cwd: folder, common, cache: old[common] ?? null, nowMs, startMs });
      const shown = stateOrLast(state, old[common]?.last ?? null, nowMs);
      byCommon[common] = { ...(state.repo === null ? (old[common] ?? {}) : state.cache), last: shown.last };
      if (shown.repo === null) continue;
      const main = shown.repo.worktrees.find((wt) => wt.main);
      found.push({ repo: { ...shown.repo, name: basename(main?.path ?? dirname(common)) }, git: shown.git });
    }
    const ordered = preferredFirst(found, preferred);
    return { repos: ordered.map(({ repo }) => repo), git: ordered[0]?.git ?? null, cache: { byCommon } };
  } catch {
    return { repos: [], git: null, cache: { byCommon: old } };
  }
}

/**
 * The worktree of the trusted repositories that holds the agent (reviews C-1 and F1): the folders of the files it edited, newest
 * first (an agent that edits its lane and then writes a report outside git stays on its lane), else the worktree it was launched in,
 * else its cwd (the lead's folder for most agents, so the last resort).
 */
function homeOf(agent, worktrees) {
  const places = agent.places ?? {};
  const candidates = [...(places.changed ?? []), places.worktree, places.cwd];
  for (const dir of candidates) {
    if (typeof dir !== 'string' || !isAbsolute(dir) || REMOTE_PATH.test(dir)) continue;
    const home = worktrees.find((wt) => isInside(dir, wt.path));
    if (home !== undefined) return home;
  }
  return undefined;
}

/**
 * Places each agent on a worktree of the trusted repositories by path prefix only (an agent's folders never open a repository).
 * @param {object[]} agents agents.mjs entries (with `places`)
 * @param {object[]} repos sessionRepos(...).repos
 * @returns {{ agents: object[], repos: object[] }} agents with repo, wt, branch (null when on none) and without places or startMs;
 *   the repositories with each worktree's `agents` (the names of the live agents on it)
 */
export function placeAgents(agents, repos) {
  const worktrees = repos.flatMap((repo) => repo.worktrees.map((wt) => ({ repo, wt }))).sort((a, b) => b.wt.path.length - a.wt.path.length);
  const flat = worktrees.map(({ wt }) => wt);
  const names = new Map(flat.map((wt) => [wt, []]));
  const placed = agents.map(({ places, startMs, ...agent }) => {
    const home = homeOf({ places }, flat);
    if (home !== undefined && agent.state !== 'done') names.get(home).push(agent.name);
    const repo = home === undefined ? undefined : worktrees.find((entry) => entry.wt === home).repo;
    return { ...agent, repo: repo?.name ?? null, wt: home?.name ?? null, branch: home?.branch ?? null };
  });
  const withNames = repos.map((repo) => ({ ...repo, worktrees: repo.worktrees.map((wt) => ({ ...wt, agents: names.get(wt) ?? [] })) }));
  return { agents: placed, repos: withNames };
}
