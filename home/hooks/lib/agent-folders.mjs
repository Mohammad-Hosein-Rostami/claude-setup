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
// Re-read in the 2.1.329 bundle (other minified names, the same code): Ioe() is the walk
//   `while(!0){if(rg(k)===rg(h))break;if(!Gq(k))R.push(J$(k,".claude",e));if(y&&rg(k)===rg(y))break;...}`; rg() only normalises
//   the path's spelling (and lower-cases it on Windows), so the home folder is matched BY SPELLING ONLY: with HOME spelled through
//   a link the CLI never meets "home" and loads the agents above the real home folder (review round 3, S2: seen loaded). The
//   walk here stops the same way. ae() finds the git root with a stat of `<folder>/.git` (O2n(): a folder or a file, or a link to
//   one), so on a disk that ignores case `.GIT` ends its walk too (probe: yes). int() is the worktree rule, unchanged. New and
//   not read to the end: a filter Jat() over the folders found.
// The personal agents folder is told by what it is on disk (device and inode), not by how its path is spelled: a session folder
// spelled in another case, or through a link, must never turn the owner's own agents into "project" files with delete advice.
// Not established, so the safe side is taken: c1n() refuses some link targets (its checks Ki and dg were not read), so a `.git`
// that is a link to a network path, or is neither folder, file nor link, makes the walk "unsure"; the filters PK (automount roots)
// and vot were not read, so a folder they drop is still looked at. Not covered: the `.claude/agents` of --add-dir folders.
// Invariants: read-only; never throws; at most MAX_PARENT_LEVELS + 1 folders looked at (agent-brief.mjs: the same limit finds the git root). Nothing is read through a link, and no
// link on the way to an agents folder is followed, not even to see what it leads to (security review round 3, R3-7: a stat of a
// link into an automounter can stall): `.claude` and `.claude/agents` are told from an lstat, and a link among them is reported
// from its own text as leading inside or outside (`link`, `link-outside`), whether it leads to a folder, a file or nowhere.
// Inside a repository the same holds for the session folder's own path below the git root (security review round 4, R4-1): the
// agents folders at and below a linked folder are reported as links and not looked at, so no advice names a file behind a link.
// The personal agents folder is never a project folder, also when a link leads to it: told from the link's text, and only from a
// text without a `.` or `..` part, which names one place however the disk is linked. With such a part the text can spell the
// personal folder while the disk leads into the repository (`../sub-link/../../../.claude/agents` behind a link `sub-link`:
// security review 1 of round 9, S1), so that link is reported as a link and nothing is said about where it leads.
// Not covered here: the `.git` entry (a link there is still followed to see that it is a folder or a file: isCertainRoot) and
// the main checkout named by a worktree's `.git` file.
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { MAX_PARENT_LEVELS, gitDirOf, isInside, nearestGitEntry, sharedGitDir } from './agent-brief.mjs';

const CONFIG_FOLDER = '.claude';
const AGENTS_FOLDER = 'agents';
const GIT_ENTRY = '.git';
const UP = '../';
const NETWORK_PATH = /^[\\/]{2}/;
const NOT_PROJECT_KINDS = ['none', 'personal']; // what agentsFolderAt finds that is no project agents folder
const ROOT_FOLDER_KINDS = ['real', 'personal']; // a folder that certainly exists at the git root
const PATH_SEPARATORS = /[\\/]/;
const DOT_PARTS = ['.', '..'];

/** Whether a link's text has a `.` or `..` part: then where it leads depends on links on the way, which are not followed. */
const hasDotPart = (linkText) => linkText.split(PATH_SEPARATORS).some((part) => DOT_PARTS.includes(part));
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
    const found = nearestGitEntry(sessionDir, { otherSpellings: true });
    if (!found) return { certain: found === null }; // null: no repository up to the filesystem root; undefined: the walk gave up
    // `.GIT` on a disk that ignores case: the CLI's stat finds it and stops there, git itself does not: the walk ends, uncertain.
    return { top: found.top, entry: found.entry, certain: found.exact && isCertainRoot(found.top, found.entry) };
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

/** What a folder is on disk (device and inode), whatever its path is spelled like; undefined when it cannot be stat'ed. */
function folderId(path) {
  try {
    const stats = statSync(path, { bigint: true }); // bigint: a Windows file id does not fit a double
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * The checks for "this is the personal agents folder".
 * @returns {{ isFolder: (folder: string) => boolean, isLinkTarget: (target: string) => boolean }} `isFolder`: for a folder that is
 *   no link, by its identity on disk, so that a path spelled in another case is still that folder, and by the path as well (the
 *   only check left when the folder cannot be stat'ed); `isLinkTarget`: for the place a link leads to, which is never looked at:
 *   by the path alone, as the personal folder is spelled and as it resolves.
 */
function personalFolderCheck(personalDir) {
  const paths = [spelled(personalDir), spelled(realOrSpelled(personalDir))];
  const id = folderId(personalDir);
  const isLinkTarget = (target) => paths.includes(spelled(target));
  return { isFolder: (folder) => isLinkTarget(folder) || (id !== undefined && folderId(folder) === id), isLinkTarget };
}

/**
 * The outermost link among the folders on the way from `top` down to `dir` (`top` itself left out), found by lstat alone.
 * @returns {string | undefined} the link's path; undefined when no folder on the way is a link, or one of them cannot be read.
 */
function linkBelow(top, dir) {
  try {
    let path = top;
    for (const part of relative(top, dir).split(sep).filter(Boolean)) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) return path;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `<dir>/.claude/agents` is, told without following a link.
 * @param {string} dir - a folder on the way from the session folder up.
 * @param {ReturnType<typeof personalFolderCheck>} personal - the checks for the personal agents folder.
 * @param {string[]} boundaries - the git root (the session folder outside a repository) as it is spelled and as it resolves.
 * @param {string | undefined} sessionLink - from linkBelow: a link on the session folder's own path inside the repository.
 * @returns {{ kind: 'none' | 'personal' } | { kind: 'real', path: string } | { kind: 'link' | 'link-outside' }} `none`: nothing
 *   there, or no folder; `personal`: the personal agents folder, or a link whose text, free of `.` and `..` parts, is its path;
 *   `real`: a folder below a real `.claude`, whose own files can be listed at `path`; else a link (`dir` lies at or below
 *   `sessionLink`, or `.claude` or `agents` is one) whose text leads to a place inside a boundary or out of it, or spells the
 *   personal folder through a `.` or `..` part (`link`); what is there, if anything, is not looked at.
 */
function agentsFolderAt(dir, personal, boundaries, sessionLink) {
  const config = join(dir, CONFIG_FOLDER);
  const agents = join(config, AGENTS_FOLDER);
  try {
    const behindSessionLink = sessionLink !== undefined && isInside(dir, sessionLink);
    const link = behindSessionLink ? sessionLink : [config, agents].find((path) => lstatSync(path).isSymbolicLink());
    if (link === undefined) {
      if (!lstatSync(agents).isDirectory()) return { kind: 'none' };
      return personal.isFolder(agents) ? { kind: 'personal' } : { kind: 'real', path: agents };
    }
    const linkText = readlinkSync(link);
    const target = resolve(dirname(link), linkText, relative(link, agents));
    if (personal.isLinkTarget(target)) return { kind: hasDotPart(linkText) ? 'link' : 'personal' };
    return { kind: boundaries.some((boundary) => isInside(target, boundary)) ? 'link' : 'link-outside' };
  } catch {
    return { kind: 'none' }; // no `.claude` or no `agents` in it, or one of them cannot be read
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
  const boundaries = [boundary, realOrSpelled(boundary)]; // a link's text may spell the place either way
  const isHome = (folder) => spelled(folder) === spelled(homeDir); // by spelling only, as the CLI does (see the header)
  const personal = personalFolderCheck(personalDir);
  const sessionLink = root.top === undefined ? undefined : linkBelow(root.top, resolve(sessionDir));
  const folders = [];
  let dir = resolve(sessionDir);
  let ended = false; // the walk reached the home folder, the git root or the filesystem root
  let rootHasAgents = false;
  for (let up = 0; up <= MAX_PARENT_LEVELS && !ended; up += 1) {
    ended = isHome(dir);
    if (ended) break;
    const found = agentsFolderAt(dir, personal, boundaries, sessionLink);
    const parentShown = `${UP.repeat(up)}${CONFIG_FOLDER}/`;
    if (!NOT_PROJECT_KINDS.includes(found.kind)) folders.push({ ...found, parentShown, shown: `${parentShown}${AGENTS_FOLDER}/` });
    // A link at the root may lead nowhere, and it is not followed to find out: then the main checkout's folder is named as well.
    rootHasAgents ||= dir === root.top && ROOT_FOLDER_KINDS.includes(found.kind);
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
