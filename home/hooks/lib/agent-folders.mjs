// Where Claude Code looks for a project's agent files, so that the project-agents note looks in the same places.
// Exports: agentFolders(sessionDir, homeDir, personalDir).
// Read from the Claude Code 2.1.328 bundle (minified names) and probed on that CLI with `claude --agent zzz-none -p hi` in a temp
// HOME; re-read and re-probe when the CLI changes:
//   Nne(): while(!0){if(jh(k)===jh(h))break;if(!PK(k))R.push(IW(k,".claude",e));if(y&&jh(k)===jh(y))break;let we=zDr(k);if(we===k)break;k=we}
//     k starts at the session folder, h is the home folder, y the git root: every <folder>/.claude/agents from the session folder
//     upwards, stopping before the home folder, after the git root, or at the filesystem root (probe: with no repository a folder
//     two levels up is loaded; a session in a subfolder of a repository loads the root's agents).
//   ae() with c1n(): the git root is the nearest folder whose `.git` is a folder or a file, or a link that resolves to one
//     (probe: a `.git` link to a folder ends the walk there).
//   Kit(): let g=Cr(r),h=ia(r);if(!g||!h||h===g)return;...if(e.some((H)=>jh(H)===y))return;...e.push(IW(h,".claude",o))
//     in a linked worktree whose root has no .claude/agents, the main checkout's .claude/agents is loaded (probe: loaded).
// Not established, so the safe side is taken: c1n() refuses some link targets (its checks Ki and dg were not read), so a `.git`
// that is a link to a network path, or is neither folder, file nor link, makes the walk "unsure"; the filters PK (automount roots)
// and vot were not read, so a folder they drop is still looked at. Not covered: the `.claude/agents` of --add-dir folders.
// Invariants: read-only; never throws; at most MAX_LEVELS_UP + 1 folders looked at. Nothing is read through a link: an agents folder
// whose real path is not <real folder>/.claude/agents is reported as a link, never listed. The personal agents folder is never a
// project folder, also when a link leads to it.
import { existsSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gitDirOf, isInside, nearestGitEntry, sharedGitDir } from './agent-brief.mjs';

const CONFIG_FOLDER = '.claude';
const AGENTS_FOLDER = 'agents';
const GIT_ENTRY = '.git';
const UP = '../';
const MAX_LEVELS_UP = 64; // folders above the session folder looked at: deeper than any real project (agent-brief.mjs uses the same)
const NETWORK_PATH = /^[\\/]{2}/;
const IGNORES_CASE = process.platform === 'win32'; // the CLI lower-cases paths there before it compares them (jh)

const spelled = (path) => (IGNORES_CASE ? resolve(path).toLowerCase() : resolve(path));

/** The real path of a folder, or its resolved spelling when it cannot be resolved. */
function realOrSpelled(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether a `.git` entry certainly makes its folder the git root for the CLI (see the header for the link case). */
function isCertainRoot(top, entry) {
  if (entry.isDirectory() || entry.isFile()) return true;
  if (!entry.isSymbolicLink() || NETWORK_PATH.test(readlinkSync(join(top, GIT_ENTRY)))) return false;
  const target = statSync(join(top, GIT_ENTRY), { throwIfNoEntry: false }); // a dangling link: no target
  return target !== undefined && (target.isDirectory() || target.isFile());
}

/**
 * The git root of the session folder.
 * @returns {{ top?: string, entry?: import('node:fs').Stats, certain: boolean }} `top`: the nearest folder at or above the session
 *   folder with a `.git` entry; `certain`: false when the CLI may see another root (or none) than this one.
 */
function gitRootOf(sessionDir) {
  try {
    const found = nearestGitEntry(sessionDir);
    if (!found) return { certain: found === null }; // null: no repository up to the filesystem root; undefined: the walk gave up
    return { top: found.top, entry: found.entry, certain: isCertainRoot(found.top, found.entry) };
  } catch {
    return { certain: false };
  }
}

/** Whether a linked worktree's main checkout has a `.claude/agents` folder: the CLI loads it when the worktree root has none. */
function mainCheckoutHasAgents(top, entry) {
  try {
    const gitDir = entry.isFile() ? gitDirOf(top, entry) : undefined;
    const shared = gitDir === undefined ? undefined : sharedGitDir(gitDir);
    if (shared === undefined || shared === gitDir) return false; // not a linked worktree (a submodule has no commondir)
    const main = basename(shared) === GIT_ENTRY ? dirname(shared) : shared;
    return main !== top && statSync(join(main, CONFIG_FOLDER, AGENTS_FOLDER)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What `<dir>/.claude/agents` is.
 * @returns {{ kind: 'none' } | { kind: 'real', path: string } | { kind: 'link' | 'link-outside' }} `none`: no folder there, a path
 *   that cannot be resolved (a link loop: the CLI loads nothing from it) or the personal folder; `real`: the folder's own files can
 *   be listed at `path`; a link leads either to another place inside `boundary` or out of it.
 */
function agentsFolderAt(dir, personalDir, boundary) {
  try {
    const real = realpathSync(join(dir, CONFIG_FOLDER, AGENTS_FOLDER));
    if (!statSync(real).isDirectory()) return { kind: 'none' };
    if (existsSync(personalDir) && real === realpathSync(personalDir)) return { kind: 'none' };
    if (real === join(realpathSync(dir), CONFIG_FOLDER, AGENTS_FOLDER)) return { kind: 'real', path: real };
    return { kind: isInside(real, realpathSync(boundary)) ? 'link' : 'link-outside' };
  } catch {
    return { kind: 'none' };
  }
}

/**
 * The agents folders Claude Code loads project agents from for a session, nearest first.
 * @param {string} sessionDir - the session's folder.
 * @param {string} homeDir - the home folder: the walk stops before it.
 * @param {string} personalDir - the personal agents folder, which is never a project folder.
 * @returns {{ folders: { kind: 'real' | 'link' | 'link-outside', path?: string, parentShown: string, shown: string }[],
 *   inRepository: boolean, unsure: boolean, mainCheckout: boolean }} `shown`: the folder as the note names it, relative to the
 *   session folder and ending in `/` (`parentShown`: the same for its `.claude`); `inRepository`: the folders lie inside a git root
 *   that is certain; `unsure`: the CLI may look in folders further up that were not looked at here; `mainCheckout`: the session is
 *   in a linked worktree without agents at its root, and the main checkout has an agents folder (not looked into).
 */
export function agentFolders(sessionDir, homeDir, personalDir) {
  const root = gitRootOf(sessionDir);
  const boundary = root.top ?? resolve(sessionDir);
  const home = spelled(realOrSpelled(homeDir));
  const isHome = (folder) => spelled(folder) === spelled(homeDir) || spelled(realOrSpelled(folder)) === home;
  const folders = [];
  let dir = resolve(sessionDir);
  let ended = false; // the walk reached the home folder, the git root or the filesystem root
  let rootHasAgents = false;
  for (let up = 0; up <= MAX_LEVELS_UP && !ended; up += 1) {
    ended = isHome(dir);
    if (ended) break;
    const found = agentsFolderAt(dir, personalDir, boundary);
    const parentShown = `${UP.repeat(up)}${CONFIG_FOLDER}/`;
    if (found.kind !== 'none') folders.push({ ...found, parentShown, shown: `${parentShown}${AGENTS_FOLDER}/` });
    rootHasAgents ||= dir === root.top && existsSync(join(dir, CONFIG_FOLDER, AGENTS_FOLDER));
    ended = dir === root.top || dirname(dir) === dir;
    dir = dirname(dir);
  }
  return {
    folders,
    inRepository: root.top !== undefined && root.certain,
    unsure: !root.certain || !ended,
    mainCheckout: root.top !== undefined && !rootHasAgents && mainCheckoutHasAgents(root.top, root.entry),
  };
}
