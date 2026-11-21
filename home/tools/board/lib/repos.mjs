// The repositories the session's work is in, for the board's git rows (spec-tui-2 and the owner's report of 2026-11-21: no git info
// at all while two agents worked in worktrees, because the lead's folder is not in git). Run only by the detached board refresh.
// Exports: sessionRepos({ folders, preferred, cache, nowMs, startMs }) -> { repos, git, cache }; placeAgents(agents, repos) -> { agents, repos };
// MAX_REPOS.
// Which: only folders the setup vouches for (refresh.mjs: the session folder, the STATUS.md folder the session linked, each agent's
// `meta.worktreePath` and the folders writers were launched in), never a folder an agent's tool call named: git runs a repository's
// own config (`core.fsmonitor`, clean filters), so it runs only where the owner put the work (review SEC-1 of 9ac483c3). Each is
// placed in its repository by the file system alone (the `.git` entry of the folder or a parent; a worktree's `.git` file names its
// git folder, whose `commondir` names the shared one), so worktrees of one clone are one repository; the worktrees that repository's
// own `worktree list` names are read with it. The first MAX_REPOS repositories are read with git-state.mjs repoState, sharing one
// git budget (`startMs`); the primary one (its `git` is the board's `git`) is the one holding a `preferred` folder (the STATUS.md
// folder, the road's `repo`), else the first. A preferred folder only orders: it never adds a repository, since an agent writes the
// road file and could name any folder there (review SEC-1 residual).
// Invariants: never throws; no git call here; `.git` and `commondir` files are read without following a link or waiting on a FIFO,
// only as regular files of at most MAX_GIT_FILE_BYTES (hooks/lib/plain-file.mjs); a UNC or device path is never touched.
import { lstatSync } from 'node:fs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { repoState } from './git-state.mjs';

/** At most this many repositories are read per refresh (each has its own 250 ms git budget in git-state.mjs). */
export const MAX_REPOS = 3;
const MAX_FOLDER_DEPTH = 40;
const MAX_GIT_FILE_BYTES = 4096;

const entryOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };
const firstLine = (path) => { try { return readPlainFile(path, MAX_GIT_FILE_BYTES).split('\n')[0].trim(); } catch { return ''; } };
const REMOTE_PATH = /^[\\/]{2}/; // UNC `\\host\share`, `//host/share` and the mixed `/\host`, `\/host` (review SEC-8): a lookup there would reach another host

/** The shared git folder of the repository holding `folder` (fs only), or null outside a repository. */
function commonDirOf(folder) {
  let at = folder;
  for (let depth = 0; depth < MAX_FOLDER_DEPTH; depth += 1) {
    const dotGit = join(at, '.git');
    const entry = entryOf(dotGit);
    if (entry?.isDirectory()) return dotGit;
    if (entry?.isFile()) {
      const named = /^gitdir: (.+)$/.exec(firstLine(dotGit))?.[1];
      if (!named) return null;
      const gitDir = isAbsolute(named) ? named : resolve(at, named);
      if (REMOTE_PATH.test(gitDir)) return null;
      const common = firstLine(join(gitDir, 'commondir'));
      return common ? resolve(gitDir, common) : gitDir;
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/** The folders grouped by repository, in the order first seen: [{ common, folder }] (folder: the first one of it). */
function groupsOf(folders) {
  const groups = new Map();
  for (const folder of folders) {
    if (typeof folder !== 'string' || folder === '' || !isAbsolute(folder) || REMOTE_PATH.test(folder)) continue;
    const common = commonDirOf(folder);
    if (common !== null && !groups.has(common)) groups.set(common, folder);
  }
  return [...groups].slice(0, MAX_REPOS).map(([common, folder]) => ({ common, folder }));
}

const isInside = (dir, path) => dir === path || dir.startsWith(`${path}${sep}`);

/** The repositories with the first one holding a preferred folder moved to the front, each with its own `git`. */
function preferredFirst(found, preferred) {
  const dirs = preferred.filter((dir) => typeof dir === 'string' && isAbsolute(dir));
  const at = found.findIndex(({ repo }) => repo.worktrees.some((wt) => dirs.some((dir) => isInside(dir, wt.path))));
  return at > 0 ? [found[at], ...found.slice(0, at), ...found.slice(at + 1)] : found;
}

/**
 * @param {{ folders: (string | null | undefined)[], preferred?: (string | null | undefined)[], cache: object | null, nowMs: number,
 *   startMs?: number }} source the trusted folders in priority order, the folders whose repository is shown first when it is one of
 *   theirs, the last cache ({ byCommon: { [common]: git cache } }) and when the refresh's git budget started
 * @returns {{ repos: object[], git: object | null, cache: object }} repos = git-state.mjs repo plus `name` (the main worktree's
 *   folder name), primary first; git = the primary repository's own { branch, ahead, behind, changed } or null
 */
export function sessionRepos({ folders, preferred = [], cache, nowMs, startMs = Date.now() }) {
  const old = cache !== null && typeof cache === 'object' && cache.byCommon ? cache.byCommon : {};
  try {
    const found = [];
    const byCommon = {};
    for (const { common, folder } of groupsOf(folders)) {
      const state = repoState({ cwd: folder, cache: old[common] ?? null, nowMs, startMs });
      byCommon[common] = state.cache;
      if (state.repo === null) continue;
      const main = state.repo.worktrees.find((wt) => wt.main);
      found.push({ repo: { ...state.repo, name: basename(main?.path ?? dirname(common)) }, git: state.git });
    }
    const ordered = preferredFirst(found, preferred);
    return { repos: ordered.map(({ repo }) => repo), git: ordered[0]?.git ?? null, cache: { byCommon } };
  } catch {
    return { repos: [], git: null, cache: { byCommon: old } };
  }
}

/**
 * The worktree of the trusted repositories that holds the agent (review C-1): the folder of the file it edited last, else the
 * worktree it was launched in, else an older edited folder, else its cwd (the lead's folder for most agents, so the last resort).
 */
function homeOf(agent, worktrees) {
  const places = agent.places ?? {};
  const [newest, ...older] = places.changed ?? [];
  const candidates = [newest, places.worktree, ...older, places.cwd];
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
