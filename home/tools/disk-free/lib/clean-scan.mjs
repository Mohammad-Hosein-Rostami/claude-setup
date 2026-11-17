// Safe file-system helpers for disk-clean. Exports: entriesOf, mtimeOf, treeBytes, touchedSince, removeInside.
// Invariants: nothing here follows a symlink (lstat and Dirent only); folders are read with opendir one entry at a time, so a folder
// of a million entries is never held in memory; removeInside refuses any path that is not strictly inside the real path of its root.
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';

/** Streams the entries (Dirent) of a folder; yields nothing when it cannot be read (missing folder, no permission). */
export async function* entriesOf(folder) {
  let handle;
  try {
    handle = await opendir(folder);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return;
    throw error;
  }
  yield* handle;
}

/** Modification time (ms) without following a symlink; null when the path is gone (another process, or the owner, removed it meanwhile). */
export function mtimeOf(path) {
  try {
    return lstatSync(path).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Bytes of a file or folder tree as lstat sees them (symlinks count as themselves, are never entered).
 * @param {string} path
 * @param {number} deadlineMs Date.now() value after which measuring stops
 * @returns {Promise<{ bytes: number, complete: boolean }>} complete is false when the deadline cut the walk short
 */
export async function treeBytes(path, deadlineMs) {
  let bytes = 0;
  const pending = [path];
  while (pending.length > 0) {
    if (Date.now() > deadlineMs) return { bytes, complete: false };
    const current = pending.pop();
    let info;
    try {
      info = lstatSync(current);
    } catch {
      continue; // gone while walking: another process removed it
    }
    bytes += info.blocks === undefined ? info.size : info.blocks * 512;
    if (!info.isDirectory()) continue;
    for await (const entry of entriesOf(current)) pending.push(join(current, entry.name));
  }
  return { bytes, complete: true };
}

/** True when the folder or any entry directly in it was modified after `cutoffMs` (stops at the first one found). */
export async function touchedSince(folder, cutoffMs) {
  try {
    if (lstatSync(folder).mtimeMs > cutoffMs) return true;
  } catch {
    return false;
  }
  for await (const entry of entriesOf(folder)) {
    try {
      if (lstatSync(join(folder, entry.name)).mtimeMs > cutoffMs) return true;
    } catch {
      // removed meanwhile
    }
  }
  return false;
}

/**
 * Removes `path` (a file, or a folder with everything in it; links inside are removed, never entered).
 * @param {string} realRoot realpath of the root the clean-up works in
 * @param {string} path what to remove
 * @throws {Error} when the path is the root itself, is outside it, is a symlink, or its parent folder resolves outside the root
 */
export function removeInside(realRoot, path) {
  const inside = relative(realRoot, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`disk-clean: ${path} is not inside ${realRoot}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`disk-clean: ${path} is a symlink and is never removed`);
  const parent = realpathSync(dirname(path));
  if (parent !== realRoot && !parent.startsWith(realRoot + sep)) throw new Error(`disk-clean: ${path} resolves outside ${realRoot}`);
  rmSync(path, { recursive: true, force: true });
}
