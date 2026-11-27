// The repositories the session's work is in, for the board's git rows (spec R18 "Git facts", owner decisions RC15 and RC19 of
// 2026-11-22). Run only by the detached board refresh.
// Exports: sessionRepos({ sessionFolder, usedDirs, liveDirs, cache, nowMs, startMs, env }) -> { repos, git, common, cache };
// placeAgents(agents, repos) -> { agents, repos }; MAX_REPOS.
// Which: the session folder's repository first, then each repository holding a folder this session used (`usedDirs`, newest use
// first: the folders of files any agent, live or done, or the lead edited, the agents' launch worktrees and cwds; refresh.mjs keeps
// them), at most MAX_REPOS. RC19 (the owner, over the spec's refs-only default): every used repository gets full status, so a folder
// an agent used does choose a repository git runs in; what git may run there is bounded by git-state.mjs (GIT_SAFETY, no lazy fetch,
// refs only where the repository's config names a filter). A folder is placed in its repository by the file system alone
// (trusted-repos.mjs trustedRepos of that folder: the `.git` entry of the folder or a parent, real path, disk case); git runs only in
// the worktrees the repository records (worktreeRecords), never in the used folder itself. The first MAX_REPOS are read with
// git-state.mjs repoState, sharing one git budget (`startMs`). When git runs
// out of time (a loaded machine), a repository keeps its last good state up to STALE_KEEP_MS, marked `stale`, instead of vanishing.
// The git cache holds results only: no path of it reaches git. The used folders come from the refresh cache and the transcripts, both
// files the same user can write, so they choose repositories exactly as an agent's edits do (RC19); they never name a git folder.
// Invariants: never throws; no git call here (repoState makes them).
import { basename, dirname, isAbsolute, sep } from 'node:path';
import { repoState } from './git-state.mjs';
import { REMOTE_PATH, repoOfDir, trustedRepos } from './trusted-repos.mjs';

/** At most this many repositories are read per refresh (they share one git budget per refresh, git-call.mjs). */
export const MAX_REPOS = 3;
const STALE_KEEP_MS = 60_000; // a repository git could not read in time shows its last good state this long, marked stale
const MAX_DIRS_PLACED = 12; // used folders looked up per refresh (a file-system walk each), newest first

/**
 * This refresh's state of a repository, else (git ran out of time under load) its last good one, marked stale, while fresh enough.
 * The last state comes from the writable cache, so it is only shown, and only with the worktrees the repository records now (`roots`):
 * no path of it ever reaches git (review SEC-10).
 */
function stateOrLast(state, last, roots, nowMs) {
  if (state.repo !== null && state.repo.worktrees.length > 0) return { repo: state.repo, git: state.git, last: { repo: state.repo, git: state.git, atMs: nowMs } };
  const kept = Array.isArray(last?.repo?.worktrees) && nowMs - last.atMs <= STALE_KEEP_MS ? last.repo.worktrees.filter((wt) => roots.includes(wt?.path)) : [];
  if (kept.length > 0) return { repo: { ...last.repo, worktrees: kept, stale: true }, git: last.git ?? null, last };
  return { repo: null, git: null, last: null };
}

/** The repositories to read: the session folder's, then those of the used folders in their order (newest use first), at most MAX_REPOS. */
function chosenRepos(session, usedDirs) {
  const chosen = [];
  if (session !== null) chosen.push(session);
  for (const dir of usedDirs.slice(0, MAX_DIRS_PLACED)) {
    if (chosen.length >= MAX_REPOS) break;
    if (repoOfDir(chosen, dir) !== undefined) continue; // in a repository already chosen
    const found = trustedRepos({ sessionFolder: dir }).session; // the repository of this folder, found by the file system alone
    if (found !== null && !chosen.some((repo) => repo.common === found.common)) chosen.push(found);
  }
  return chosen;
}

const isInside = (dir, path) => dir === path || dir.startsWith(`${path}${sep}`);

/**
 * @param {{ sessionFolder: string | null, usedDirs?: string[], liveDirs?: string[], cache: object | null, nowMs: number,
 *   startMs?: number }} source the session's folder, the folders this session used (newest first), the live agents'
 *   folders (git-state.mjs active rule b), the last cache ({ byCommon: { [common]: git cache } }) and when the refresh's git budget
 *   started
 * @returns {{ repos: object[], git: object | null, common: string | null, cache: object }} repos = git-state.mjs repo plus `name`
 *   (the main worktree's folder name), the session folder's first; git = the first repository's own
 *   { branch, ahead, behind, changed } or null; common = the first repository's shared git folder from the file system (never
 *   from the cache: repo-stats.mjs runs git on it)
 */
export function sessionRepos({ sessionFolder, usedDirs = [], liveDirs = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache !== null && typeof cache === 'object' && cache.byCommon ? cache.byCommon : {};
  try {
    const found = [];
    const byCommon = {};
    const session = trustedRepos({ sessionFolder }).session; // its `folder` is the real path in the disk's case (P11: APFS, links)
    for (const { common, folder, roots } of chosenRepos(session, usedDirs)) {
      const state = repoState({ cwd: folder, sessionFolder: session?.folder ?? null, common, liveDirs, cache: old[common] ?? null, nowMs, startMs });
      const shown = stateOrLast(state, old[common]?.last ?? null, roots, nowMs);
      byCommon[common] = { ...(state.repo === null ? (old[common] ?? {}) : state.cache), last: shown.last };
      if (shown.repo === null) continue;
      const main = shown.repo.worktrees.find((wt) => wt.main);
      found.push({ repo: { ...shown.repo, name: basename(main?.path ?? dirname(common)) }, git: shown.git, common });
    }
    return { repos: found.map(({ repo }) => repo), git: found[0]?.git ?? null, common: found[0]?.common ?? null, cache: { byCommon } };
  } catch {
    return { repos: [], git: null, common: null, cache: { byCommon: old } };
  }
}

const isLocal = (dir) => typeof dir === 'string' && isAbsolute(dir) && !REMOTE_PATH.test(dir);
const worktreeOf = (dir, worktrees) => (isLocal(dir) ? worktrees.find((wt) => isInside(dir, wt.path)) : undefined);

/**
 * Where the agent works (reviews C-1 and F1): the worktree holding a folder of a file it edited, newest first, else its isolation
 * worktree (`meta.worktreePath`); `sure`. Else the worktree its launch folder or cwd is in, which says only the repository: an agent
 * working through Bash alone may be on any branch of it (review F2, lead decision: never show a branch it may not be on).
 * @returns {{ home: object | undefined, sure: boolean }}
 */
function homeOf(places, worktrees) {
  for (const dir of places.changed ?? []) {
    const home = worktreeOf(dir, worktrees);
    if (home !== undefined) return { home, sure: true };
  }
  const isolatedHome = places.isolated === true ? worktreeOf(places.worktree, worktrees) : undefined;
  if (isolatedHome !== undefined) return { home: isolatedHome, sure: true };
  return { home: worktreeOf(places.worktree, worktrees) ?? worktreeOf(places.cwd, worktrees), sure: false };
}

/** What an agent row says when the agent is on no known worktree: the repository or folder it was launched in, and why. */
function unplacedText(places, agent, repoName) {
  const launch = isLocal(places.worktree) ? places.worktree : isLocal(places.cwd) ? places.cwd : null;
  const at = repoName ?? (launch === null ? null : basename(launch));
  const why = (places.changed ?? []).length > 0 ? 'edits outside git' : agent.writer ? 'no edits yet' : 'read-only';
  return at === null ? null : `${at} · ${why}`;
}

/**
 * Places each agent on a worktree of the trusted repositories by path prefix only (an agent's folders never open a repository).
 * @param {object[]} agents agents.mjs entries (with `places`)
 * @param {object[]} repos sessionRepos(...).repos
 * @returns {{ agents: object[], repos: object[] }} agents with repo, wt, branch (null when on no sure worktree) and `unplaced` (the
 *   row's text then: `claude-setup · no edits yet`, `round4 · no edits yet`, or null), without places (`startMs` stays: the tick's
 *   agents line shows each agent's age from it); the repositories with each worktree's `agents` (the names of the live agents
 *   surely on it)
 */
export function placeAgents(agents, repos) {
  const worktrees = repos.flatMap((repo) => repo.worktrees.map((wt) => ({ repo, wt }))).sort((a, b) => b.wt.path.length - a.wt.path.length);
  const flat = worktrees.map(({ wt }) => wt);
  const names = new Map(flat.map((wt) => [wt, []]));
  const placed = agents.map(({ places = {}, ...agent }) => {
    const { home, sure } = homeOf(places, flat);
    const repo = home === undefined ? undefined : worktrees.find((entry) => entry.wt === home).repo;
    if (!sure) return { ...agent, repo: repo?.name ?? null, wt: null, branch: null, unplaced: unplacedText(places, agent, repo?.name ?? null) };
    if (agent.state !== 'done') names.get(home).push(agent.name);
    return { ...agent, repo: repo.name, wt: home.name, branch: home.branch ?? null, unplaced: null };
  });
  const withNames = repos.map((repo) => {
    const worktreeOfBranch = new Map(repo.worktrees.filter((wt) => wt.branch !== null).map((wt) => [wt.branch, wt]));
    const agentsOn = (branch) => names.get(worktreeOfBranch.get(branch)) ?? [];
    return { ...repo, worktrees: repo.worktrees.map((wt) => ({ ...wt, agents: names.get(wt) ?? [] })),
      active: (Array.isArray(repo.active) ? repo.active : []).map((branch) => ({ ...branch, agents: agentsOn(branch.name) })) };
  });
  return { agents: placed, repos: withNames };
}
