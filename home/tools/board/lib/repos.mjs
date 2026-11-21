// The repositories the session's work is in, for the board's git rows (spec-tui-2 and the owner's report of 2026-11-21: no git info
// at all while two agents worked in worktrees, because the lead's folder is not in git). Run only by the detached board refresh.
// Exports: sessionRepos({ folders, agentDirs, cache, nowMs }) -> { repos, git, cache }; MAX_REPOS.
// Which: every folder given (the session folder, the road's `repo`, each live agent's folder, in that order) is placed in its
// repository by the file system alone (the `.git` entry of the folder or a parent; a worktree's `.git` file names its git folder,
// whose `commondir` names the shared one), so worktrees of one clone are one repository. The first MAX_REPOS repositories are read
// with git-state.mjs repoState; the first is the primary one (its `git` is the board's `git`).
// Invariants: never throws; no git call here (repoState makes them, with its own timeouts and budget, one cache per repository).
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { repoState } from './git-state.mjs';

/** At most this many repositories are read per refresh (each has its own 250 ms git budget in git-state.mjs). */
export const MAX_REPOS = 3;
const MAX_FOLDER_DEPTH = 40;
const MAX_GIT_FILE_BYTES = 4096;

const entryOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };
const firstLine = (path) => { try { return readFileSync(path, 'utf8').slice(0, MAX_GIT_FILE_BYTES).split('\n')[0].trim(); } catch { return ''; } };

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
    if (typeof folder !== 'string' || folder === '' || !isAbsolute(folder)) continue;
    const common = commonDirOf(folder);
    if (common !== null && !groups.has(common)) groups.set(common, folder);
  }
  return [...groups].slice(0, MAX_REPOS).map(([common, folder]) => ({ common, folder }));
}

/**
 * @param {{ folders: (string | null | undefined)[], agentDirs: { name: string, dir: string | null }[], cache: object | null,
 *   nowMs: number }} source the folders in priority order, the live agents' folders and the last cache ({ [common]: git cache })
 * @returns {{ repos: object[], git: object | null, cache: object }} repos = git-state.mjs repo plus `name` (the main worktree's
 *   folder name), primary first; git = the primary repository's own { branch, ahead, behind, changed } or null
 */
export function sessionRepos({ folders, agentDirs, cache, nowMs }) {
  const old = cache !== null && typeof cache === 'object' && cache.byCommon ? cache.byCommon : {};
  try {
    const repos = [];
    const byCommon = {};
    let git = null;
    for (const { common, folder } of groupsOf(folders)) {
      const state = repoState({ cwd: folder, agentDirs, cache: old[common] ?? null, nowMs });
      byCommon[common] = state.cache;
      if (state.repo === null) continue;
      const main = state.repo.worktrees.find((wt) => wt.main);
      repos.push({ ...state.repo, name: basename(main?.path ?? dirname(common)) });
      git ??= state.git;
    }
    return { repos, git, cache: { byCommon } };
  } catch {
    return { repos: [], git: null, cache: { byCommon: old } };
  }
}
