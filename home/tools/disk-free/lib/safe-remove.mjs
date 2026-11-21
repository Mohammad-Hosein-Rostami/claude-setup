// What disk-clean may remove, and the removal itself. Exports: UnsafeRoot, inspectRoot, ownedFolder, removeInside, moveAside, moveBack, originalName, isOwnAside.
// Why it is written by hand: Node has no unlinkat, so a path-based removal can be redirected when a folder on the way is swapped for a
// symlink. Three defences close that: (1) every folder from the root down to the item, and every folder inside the item, must be owned by
// this user, not a symlink and not writable by group or others, so nobody else can swap anything; (2) the removal works from inside the
// folder: it changes the working directory into it, checks that "." is the folder that was inspected (device and inode) and then removes
// bare names only, so a swap of any folder on the path after that point changes nothing; (3) a shared sticky folder (/tmp) counts as a
// root only when root owns it, because the owner of a sticky folder can rename everyone's entries in it.
// The process changes its working directory while it removes (removal is synchronous, so nothing else runs meanwhile) and puts it back.
// Windows has no uid: the ownership and mode checks are skipped there and a root must be under the temp or home folder (see the README).
import { lstatSync, opendirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { lstatOrNull } from './clean-scan.mjs';

const MY_UID = process.getuid?.(); // undefined on Windows
const ROOT_UID = 0;
const MAX_DEPTH = 64;
const BATCH_SIZE = 1000; // names read before removing them: memory stays small however many entries a planted folder holds
const MAX_BATCHES = 100_000;
const STICKY_AND_WORLD_WRITABLE = 0o1002;
const GROUP_OR_OTHERS_WRITE = 0o022;
const ASIDE_PREFIX = '.removing-';
const ASIDE_NAME = /^\.removing-\d+-(.+)$/;

export class UnsafeRoot extends Error {}

const isMine = (info) => MY_UID === undefined || info.uid === MY_UID;
const isClosedToOthers = (info) => MY_UID === undefined || (info.mode & GROUP_OR_OTHERS_WRITE) === 0;
const isSharedTemp = (info) => MY_UID !== undefined && info.isDirectory() && info.uid === ROOT_UID && (info.mode & STICKY_AND_WORLD_WRITABLE) === STICKY_AND_WORLD_WRITABLE;
const isMineAndClosed = (info) => info.isDirectory() && isMine(info) && isClosedToOthers(info);
const isInside = (real, base) => real === base || real.startsWith(base + sep);
const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The name a folder had before a clean-up renamed it aside (`.removing-<pid>-<name>`); any other name is returned as it is. */
export const originalName = (name) => ASIDE_NAME.exec(name)?.[1] ?? name;

/** True for the name of a folder this process renamed aside (`.removing-<own pid>-<name>`): the rules skip it, so a run never finds its own renames as new items. */
export const isOwnAside = (name) => name.startsWith(`${ASIDE_PREFIX}${process.pid}-`);

/** lstat info of a real folder (not a link) owned by this user and closed to group and others, else null. */
export function ownedFolder(path) {
  const info = lstatOrNull(path);
  return info !== null && isMineAndClosed(info) ? info : null;
}

function allowedBases(home) {
  const bases = [tmpdir(), join(home, '.claude')];
  if (process.platform !== 'win32') bases.push('/tmp', '/private/tmp');
  return bases.map(realOrNull).filter((base) => base !== null);
}

/**
 * Decides whether a folder may be the root of a clean-up.
 * @param {unknown} root the configured root
 * @param {string} home the home folder (never a root); it must be an absolute path
 * @returns {{ real: string, shared: boolean } | null} its real path, and whether it is a shared sticky folder like /tmp (owned by root); null when it does not exist
 * @throws {UnsafeRoot} when it is empty or relative, the home folder is unknown, it is a link, not a folder, the home folder, not under the temp, /tmp
 *   or ~/.claude folders, or neither owned by this user and closed to others nor a sticky folder owned by root
 */
export function inspectRoot(root, home = homedir()) {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) throw new UnsafeRoot(`root ${JSON.stringify(root)} is empty or not an absolute path`);
  if (!isAbsolute(home)) throw new UnsafeRoot(`the home folder ${JSON.stringify(home)} is not an absolute path`);
  const info = lstatOrNull(root);
  if (info === null) return null;
  if (!info.isDirectory()) throw new UnsafeRoot(`root ${root} is a symlink or not a folder`); // lstat: a link is never a directory
  const real = realpathSync(root);
  if (real === realOrNull(home)) throw new UnsafeRoot(`root ${root} is the home folder`);
  if (!allowedBases(home).some((base) => isInside(real, base))) throw new UnsafeRoot(`root ${root} is not under the temp folder, /tmp or ~/.claude`);
  if (isMineAndClosed(info)) return { real, shared: false };
  if (isSharedTemp(info)) return { real, shared: true };
  throw new UnsafeRoot(`root ${root} is owned by someone else or writable by others`);
}

/** Throws unless the working directory "." is the folder that was inspected (same device and inode). */
function assertHere(expected) {
  const now = lstatSync('.');
  if (!now.isDirectory() || now.dev !== expected.dev || now.ino !== expected.ino) throw new Error('disk-clean: a folder changed while it was being removed');
}

function namesIn(folder) {
  const handle = opendirSync(folder);
  try {
    const names = [];
    for (let entry = handle.readSync(); entry !== null; entry = names.length < BATCH_SIZE ? handle.readSync() : null) names.push(entry.name);
    return names;
  } finally {
    handle.closeSync();
  }
}

/** Removes one entry of the working directory: a file or link is unlinked (never entered), a folder must be safe and is emptied and removed. */
function removeEntry(name, parentInfo, depth) {
  let child;
  try {
    child = lstatSync(name);
  } catch (error) {
    if (error.code === 'ENOENT') return; // gone already; any other error stops the removal instead of looping on an entry that cannot be looked at
    throw error;
  }
  if (!child.isDirectory()) return unlinkSync(name);
  if (!isMineAndClosed(child) || child.dev !== parentInfo.dev) throw new Error(`disk-clean: ${name} is not owned by you, is writable by others or is another file system: kept`);
  removeFolder(name, child, parentInfo, depth + 1);
}

/** Working directory is the parent of `name`. Enters the folder, empties it, goes back out and removes it. */
function removeFolder(name, info, parentInfo, depth) {
  if (depth > MAX_DEPTH) throw new Error(`disk-clean: ${name} is nested deeper than ${MAX_DEPTH} folders`);
  process.chdir(name); // follows a link, so the identity check below is what proves this is the folder that was inspected
  assertHere(info);
  for (let batch = 0; batch <= MAX_BATCHES; batch += 1) {
    const names = namesIn('.');
    if (names.length === 0) break;
    for (const entry of names) removeEntry(entry, info, depth);
  }
  process.chdir('..');
  assertHere(parentInfo);
  rmdirSync(name);
}

/** The names from `realRoot` down to `path` (at least one); throws when `path` is not inside `realRoot`. */
function namesBelow(realRoot, path) {
  const inside = relative(realRoot, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`disk-clean: ${path} is not inside ${realRoot}`);
  return inside.split(sep);
}

/**
 * Enters the root and checks it; the working directory is then the root (security N1: every later step is relative).
 * @returns {object} the lstat of the root as it was entered.
 */
function enterRoot(realRoot) {
  const rootInfo = lstatSync(realRoot);
  if (!rootInfo.isDirectory() || !(isMineAndClosed(rootInfo) || isSharedTemp(rootInfo))) throw new Error(`disk-clean: root ${realRoot} is not a folder owned by you or by root (sticky)`);
  process.chdir(realRoot);
  assertHere(rootInfo); // a root swapped between the lstat and the chdir is refused here
  return rootInfo;
}

/**
 * Runs action(name, parentInfo, rootInfo) with the working directory inside the checked parent of `path`; puts the
 * directory back afterwards. The walk from the root down goes one relative name at a time: each folder passes the owner,
 * mode, link and file-system checks by lstat, and after the chdir into it its identity (dev, inode) is checked again,
 * so a folder on the way swapped by a same-user rename after the check is refused instead of followed (security N1).
 */
function inParent(realRoot, path, action) {
  const names = namesBelow(realRoot, path);
  const original = process.cwd();
  try {
    const rootInfo = enterRoot(realRoot);
    let parentInfo = rootInfo;
    for (const folderName of names.slice(0, -1)) {
      const info = lstatSync(folderName);
      if (!isMineAndClosed(info) || info.dev !== rootInfo.dev) throw new Error(`disk-clean: ${join(realRoot, folderName)} on the way to ${path} is a symlink, is not owned by you, is writable by others or is another file system`);
      process.chdir(folderName);
      assertHere(info);
      parentInfo = info;
    }
    return action(names.at(-1), parentInfo, rootInfo);
  } finally {
    try {
      process.chdir(original);
    } catch {
      process.chdir(realRoot); // the old directory is gone (it was inside what was removed): the root always exists
    }
  }
}

/** lstat of a named item that must be a real folder or file of this user on the root's file system, never a link. */
function checkedItem(name, rootInfo) {
  const item = lstatSync(name);
  if (item.isSymbolicLink()) throw new Error(`disk-clean: ${name} is a symlink and is never removed`);
  if (!isMine(item)) throw new Error(`disk-clean: ${name} is not owned by you`);
  if (item.dev !== rootInfo.dev) throw new Error(`disk-clean: ${name} is on another file system (a mount point): kept`);
  if (item.isDirectory() && !isClosedToOthers(item)) throw new Error(`disk-clean: ${name} is writable by others: kept`);
  return item;
}

/**
 * Removes `path` (a file, or a folder with everything in it). Every folder from the root down must be safe; the item itself must be owned by
 * this user, not a symlink and on the root's file system.
 * @param {string} realRoot realpath of the root (from inspectRoot)
 * @param {string} path what to remove
 * @throws {Error} when the path is the root or outside it, is a symlink, is not safe (see the file header), or changes while being removed
 */
export function removeInside(realRoot, path) {
  inParent(realRoot, path, (name, parentInfo, rootInfo) => {
    const item = checkedItem(name, rootInfo);
    if (!item.isDirectory()) return unlinkSync(name);
    return removeFolder(name, item, parentInfo, 0);
  });
}

/**
 * Renames a folder to `.removing-<pid>-<name>` in the same parent, atomically, so a session that resumes now writes to a new folder and the
 * old one can be checked again before it is removed.
 * @returns {string} the new path
 * @throws {Error} as removeInside, or when the folder is not a folder
 */
export function moveAside(realRoot, path) {
  const asideName = `${ASIDE_PREFIX}${process.pid}-${basename(path)}`;
  inParent(realRoot, path, (name, _parentInfo, rootInfo) => {
    if (!checkedItem(name, rootInfo).isDirectory()) throw new Error(`disk-clean: ${path} is not a folder`);
    renameSync(name, asideName);
  });
  return join(dirname(path), asideName);
}

/** Renames a folder that moveAside moved back to its own name; throws when the name is taken by a folder that is not empty (the session wrote there). */
export function moveBack(realRoot, asidePath, originalPath) {
  if (dirname(asidePath) !== dirname(originalPath)) throw new Error(`disk-clean: ${asidePath} and ${originalPath} are not in one folder`);
  inParent(realRoot, asidePath, (name, _parentInfo, rootInfo) => {
    checkedItem(name, rootInfo);
    renameSync(name, basename(originalPath));
  });
}
