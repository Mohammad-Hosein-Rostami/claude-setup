// The repositories the board may run git in (lead decisions of fix rounds 4 and 5, 2026-11-22): the session folder's and the setup's
// own (the repository holding this running code, found from this module's real path: `~/.claude/tools` links into it, and no agent's
// text can choose it). Claude Code's folder-trust record is not a source: the owner runs with bypass permissions, so it is unreliable,
// and it would widen what can name a folder. Git runs a repository's own config (`core.fsmonitor`, clean filters), so it never runs in a
// folder only an agent or a file it wrote named (review SEC-1 of 9ac483c3 and its residual).
// Exports: trustedRepos({ sessionFolder }) -> { session, repos: [{ common, folder, roots }] }; repoOfDir(repos, dir); sameRepo(folder,
// common); REMOTE_PATH.
// Each folder is placed in its repository by the file system alone (the `.git` entry of the folder or a parent; a worktree's `.git`
// file names its git folder, whose `commondir` names the shared one). `roots` are the repository's registered worktrees, read the same
// way (the main checkout, and `<common>/worktrees/<name>/gitdir`), so an agent's folder (its edits, its launch worktree, its cwd) is
// matched to a trusted repository by path prefix only: no file in an agent's folder is read. Worked out again on every refresh, never
// read back from a cache (review SEC-10: the board cache is a plain file any same-user process can write).
// Invariants: never throws; no git call here; `.git`, `commondir` and `gitdir` files are read without following a link or waiting on
// a FIFO, at most MAX_GIT_FILE_BYTES each (hooks/lib/plain-file.mjs); a UNC or device path is never touched.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

/** UNC `\\host\share`, `//host/share` and the mixed `/\host`, `\/host` (review SEC-8): a lookup there would reach another host. */
export const REMOTE_PATH = /^[\\/]{2}/;
const MAX_WORKTREES_READ = 32;
const MAX_FOLDER_DEPTH = 40;
const MAX_GIT_FILE_BYTES = 4096;

const entryOf = (path) => { try { return lstatSync(path, { throwIfNoEntry: false }) ?? null; } catch { return null; } };
const firstLine = (path) => { try { return readPlainFile(path, MAX_GIT_FILE_BYTES).split('\n')[0].trim(); } catch { return ''; } };
const realOf = (path) => { try { return realpathSync(path); } catch { return null; } };
const isLocalFolder = (dir) => typeof dir === 'string' && dir !== '' && isAbsolute(dir) && !REMOTE_PATH.test(dir);
const isInside = (dir, path) => dir === path || dir.startsWith(`${path}${sep}`);

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

/**
 * True when `folder` (a worktree path git listed) still belongs to the repository whose shared git folder is `common`, by the file
 * system with real paths: a lane whose `.git` file was rewritten, or a folder replaced by another repository, is refused before git
 * runs there (review SEC-6, second half).
 */
export function sameRepo(folder, common) {
  if (!isLocalFolder(folder)) return false;
  const found = commonDirOf(folder);
  const real = found === null ? null : realOf(found);
  return real !== null && real === realOf(common);
}

/** The repository's registered worktree folders: its main checkout, then each `<common>/worktrees/<name>/gitdir` names one. */
function rootsOf(common) {
  const roots = basename(common) === '.git' ? [dirname(common)] : [];
  let names = [];
  try {
    names = readdirSync(join(common, 'worktrees')).slice(0, MAX_WORKTREES_READ);
  } catch {
    return roots; // no linked worktrees
  }
  for (const name of names) {
    const gitFile = firstLine(join(common, 'worktrees', name, 'gitdir'));
    // resolve: git writes forward slashes on Windows too, the agents' folders have backslashes (review N-8)
    if (isLocalFolder(gitFile) && basename(gitFile) === '.git') roots.push(resolve(dirname(gitFile)));
  }
  return roots;
}

/** The folder of this module with every link resolved (inside the setup's repository); null when it cannot be resolved. */
const codeFolder = () => { try { return dirname(realpathSync(fileURLToPath(import.meta.url))); } catch { return null; } };

/**
 * @param {{ sessionFolder: string | null }} source the session's folder
 * @returns {{ session: object | null, repos: { common: string, folder: string, roots: string[] }[] }} the session folder's repository
 *   (also first in repos), then the setup's; `folder` is where git may run for that repository (a trusted folder, never an agent's)
 */
export function trustedRepos({ sessionFolder }) {
  try {
    const byCommon = new Map();
    for (const folder of [sessionFolder, codeFolder()].filter(isLocalFolder)) {
      const common = commonDirOf(folder);
      if (common !== null && !byCommon.has(common)) byCommon.set(common, { common, folder, roots: rootsOf(common) });
    }
    const repos = [...byCommon.values()];
    return { session: repos.find((repo) => repo.folder === sessionFolder) ?? null, repos };
  } catch {
    return { session: null, repos: [] };
  }
}

/** @returns {object | undefined} the trusted repository one of whose registered worktrees holds `dir` (the deepest one) */
export function repoOfDir(repos, dir) {
  if (!isLocalFolder(dir)) return undefined;
  let best;
  let bestLength = -1;
  for (const repo of repos) {
    for (const root of repo.roots) {
      if (isInside(dir, root) && root.length > bestLength) {
        best = repo;
        bestLength = root.length;
      }
    }
  }
  return best;
}
