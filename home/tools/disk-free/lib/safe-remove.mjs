// What disk-clean may remove, and the removal itself. Exports: UnsafeRoot, inspectRoot, ownedFolder, removeInside.
// Why it is written by hand: Node has no unlinkat, so a path-based removal can be redirected when a folder on the way is swapped for a
// symlink. Two defences close that: (1) every folder from the root down to the item, and every folder inside the item, must be owned by
// this user, not a symlink and not writable by group or others, so nobody else can swap anything; (2) before each unlink the folder's
// identity (device and inode) is compared with what was seen when it was entered, so an accidental swap by this user's own processes
// stops the removal. What remains is the instant between that comparison and the unlink call, open only to a process of this same user.
// A shared sticky folder (/tmp) is accepted as a root only for items that are owned by this user.
// Windows has no uid: the ownership and mode checks are skipped there and a root must be under the temp or home folder (see the README).
import { lstatSync, opendirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { lstatOrNull } from './clean-scan.mjs';

const MY_UID = process.getuid?.(); // undefined on Windows
const MAX_DEPTH = 64;
const BATCH_SIZE = 1000; // names read before removing them: memory stays small however many entries a planted folder holds
const MAX_BATCHES = 100_000;
const STICKY_AND_WORLD_WRITABLE = 0o1002;
const GROUP_OR_OTHERS_WRITE = 0o022;

export class UnsafeRoot extends Error {}

const isMine = (info) => MY_UID === undefined || info.uid === MY_UID;
const isClosedToOthers = (info) => MY_UID === undefined || (info.mode & GROUP_OR_OTHERS_WRITE) === 0;
const isSharedTemp = (info) => MY_UID !== undefined && info.isDirectory() && (info.mode & STICKY_AND_WORLD_WRITABLE) === STICKY_AND_WORLD_WRITABLE;
const isInside = (real, base) => real === base || real.startsWith(base + sep);
const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** lstat info of a real folder (not a link) owned by this user and closed to group and others, else null. */
export function ownedFolder(path) {
  const info = lstatOrNull(path);
  return info !== null && info.isDirectory() && isMine(info) && isClosedToOthers(info) ? info : null;
}

function allowedBases(home) {
  const bases = [tmpdir(), join(home, '.claude')];
  if (process.platform !== 'win32') bases.push('/tmp', '/private/tmp');
  return bases.map(realOrNull).filter((base) => base !== null);
}

/**
 * Decides whether a folder may be the root of a clean-up.
 * @param {unknown} root the configured root
 * @param {string} home the home folder (never a root)
 * @returns {{ real: string, shared: boolean } | null} its real path, and whether it is a shared sticky folder like /tmp; null when it does not exist
 * @throws {UnsafeRoot} when it is empty or relative, a link, not a folder, the home folder, not under the temp, /tmp or ~/.claude folders,
 *   or neither owned by this user and closed to others nor a shared sticky folder
 */
export function inspectRoot(root, home = homedir()) {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) throw new UnsafeRoot(`root ${JSON.stringify(root)} is empty or not an absolute path`);
  const info = lstatOrNull(root);
  if (info === null) return null;
  if (!info.isDirectory()) throw new UnsafeRoot(`root ${root} is a symlink or not a folder`); // lstat: a link is never a directory
  const real = realpathSync(root);
  if (real === realOrNull(home)) throw new UnsafeRoot(`root ${root} is the home folder`);
  if (!allowedBases(home).some((base) => isInside(real, base))) throw new UnsafeRoot(`root ${root} is not under the temp folder, /tmp or ~/.claude`);
  if (isMine(info) && isClosedToOthers(info)) return { real, shared: false };
  if (isSharedTemp(info)) return { real, shared: true };
  throw new UnsafeRoot(`root ${root} is owned by someone else or writable by others`);
}

const sameFolder = (path, expected) => {
  const now = lstatOrNull(path);
  return now !== null && now.isDirectory() && now.dev === expected.dev && now.ino === expected.ino;
};

function assertSameFolder(path, expected) {
  if (!sameFolder(path, expected)) throw new Error(`disk-clean: ${path} changed while it was being removed`);
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

/** Empties and removes one folder. Links inside are unlinked, never entered; a folder inside that is not safe stops the removal. */
function removeFolder(folder, info, depth) {
  if (depth > MAX_DEPTH) throw new Error(`disk-clean: ${folder} is nested deeper than ${MAX_DEPTH} folders`);
  for (let batch = 0; batch <= MAX_BATCHES; batch += 1) {
    const names = namesIn(folder);
    if (names.length === 0) break;
    for (const name of names) {
      assertSameFolder(folder, info);
      const child = join(folder, name);
      const childInfo = lstatOrNull(child);
      if (childInfo === null) continue;
      if (!childInfo.isDirectory()) {
        unlinkSync(child);
        continue;
      }
      if (!isMine(childInfo) || !isClosedToOthers(childInfo) || childInfo.dev !== info.dev) throw new Error(`disk-clean: ${child} is not owned by you, is writable by others or is another file system: kept`);
      removeFolder(child, childInfo, depth + 1);
    }
  }
  assertSameFolder(folder, info);
  rmdirSync(folder);
}

/**
 * Removes `path` (a file, or a folder with everything in it). Every folder from the root down must pass ownedFolder; the item itself
 * must be owned by this user and not a symlink.
 * @param {string} realRoot realpath of the root (from inspectRoot)
 * @param {string} path what to remove
 * @throws {Error} when the path is the root or outside it, is a symlink, is not safe (see the file header), or changes while being removed
 */
export function removeInside(realRoot, path) {
  const inside = relative(realRoot, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`disk-clean: ${path} is not inside ${realRoot}`);
  const rootInfo = lstatSync(realRoot);
  if (!rootInfo.isDirectory() || !((isMine(rootInfo) && isClosedToOthers(rootInfo)) || isSharedTemp(rootInfo))) throw new Error(`disk-clean: root ${realRoot} is not a folder owned by you`);
  const chain = [{ path: realRoot, info: rootInfo }];
  const names = inside.split(sep);
  for (const name of names.slice(0, -1)) {
    const folder = join(chain.at(-1).path, name);
    const info = lstatSync(folder);
    if (!info.isDirectory() || !isMine(info) || !isClosedToOthers(info)) throw new Error(`disk-clean: ${folder} is a symlink, is not owned by you or is writable by others`);
    chain.push({ path: folder, info });
  }
  const item = lstatSync(path);
  if (item.isSymbolicLink()) throw new Error(`disk-clean: ${path} is a symlink and is never removed`);
  if (!isMine(item)) throw new Error(`disk-clean: ${path} is not owned by you`);
  for (const { path: folder, info } of chain) assertSameFolder(folder, info);
  if (!item.isDirectory()) return unlinkSync(path);
  if (!isClosedToOthers(item)) throw new Error(`disk-clean: ${path} is writable by others: kept`);
  return removeFolder(path, item, 0);
}
