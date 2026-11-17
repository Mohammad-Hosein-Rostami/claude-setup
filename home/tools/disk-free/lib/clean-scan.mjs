// Read-only file-system helpers for disk-clean. Exports: entriesOf, lstatOrNull, mtimeOf, walkTree, treeBytes, touchedSince.
// Invariants: nothing here follows a symlink (lstat and Dirent only); folders are read with opendir one entry at a time and a walk keeps
// only one open folder per level, so a folder of a million entries (or a planted one of many more) never fills the memory; a walk stops at
// a cap of entries and depth and says so. The removal itself is in safe-remove.mjs.
import { lstatSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_WALK_ENTRIES = 2_000_000;
export const MAX_WALK_DEPTH = 64;
const BYTES_PER_BLOCK = 512;

/** Streams the entries (Dirent) of a folder; yields nothing when it cannot be read (missing folder, no permission). */
export async function* entriesOf(folder) {
  let handle;
  try {
    handle = await opendir(folder);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  }
  yield* handle;
}

/** lstat info without following a symlink; null when the path is gone or cannot be looked at (never throws: unknown means keep). */
export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Modification time (ms) without following a symlink; null when the path is gone or cannot be looked at. */
export const mtimeOf = (path) => lstatOrNull(path)?.mtimeMs ?? null;

/**
 * Streams the lstat info of a path and, for a folder, of everything under it (depth first, links never entered).
 * @param {string} root
 * @param {{ maxEntries?: number, maxDepth?: number }} limits
 * @param {{ cutShort?: boolean }} outcome set to cutShort=true when a limit or an unreadable folder left part of the tree unseen
 */
export async function* walkTree(root, { maxEntries = MAX_WALK_ENTRIES, maxDepth = MAX_WALK_DEPTH } = {}, outcome = {}) {
  const rootInfo = lstatOrNull(root);
  if (rootInfo === null) return;
  yield rootInfo;
  if (!rootInfo.isDirectory()) return;
  const rootDir = await opendir(root).catch(() => null);
  if (rootDir === null) {
    outcome.cutShort = true;
    return;
  }
  const open = [{ dir: rootDir, path: root }];
  let seen = 0;
  try {
    while (open.length > 0) {
      const top = open.at(-1);
      const entry = await top.dir.read();
      if (entry === null) {
        open.pop();
        await top.dir.close();
        continue;
      }
      seen += 1;
      if (seen > maxEntries) {
        outcome.cutShort = true;
        return;
      }
      const path = join(top.path, entry.name);
      const info = lstatOrNull(path);
      if (info === null) continue;
      yield info;
      if (!info.isDirectory()) continue;
      const dir = open.length >= maxDepth ? null : await opendir(path).catch(() => null);
      if (dir === null) outcome.cutShort = true;
      else open.push({ dir, path });
    }
  } finally {
    for (const { dir } of open) await dir.close().catch(() => {});
  }
}

/**
 * Bytes of a file or folder tree as lstat sees them (symlinks count as themselves, are never entered).
 * @param {string} path
 * @param {number} deadlineMs Date.now() value after which measuring stops
 * @returns {Promise<{ bytes: number, complete: boolean }>} complete is false when the deadline or a walk limit cut the walk short
 */
export async function treeBytes(path, deadlineMs) {
  let bytes = 0;
  const outcome = {};
  for await (const info of walkTree(path, {}, outcome)) {
    if (Date.now() > deadlineMs) return { bytes, complete: false };
    bytes += info.blocks === undefined ? info.size : info.blocks * BYTES_PER_BLOCK;
  }
  return { bytes, complete: outcome.cutShort !== true };
}

/**
 * True when the path, or anything anywhere under it, was modified after `cutoffMs` (stops at the first one found). Also true when the
 * path is gone or the walk was cut short: what cannot be seen counts as busy, so it is kept.
 * @param {string} path
 * @param {number} cutoffMs
 * @param {{ maxEntries?: number, maxDepth?: number }} limits the walk caps (tests make them small)
 */
export async function touchedSince(path, cutoffMs, limits = {}) {
  const outcome = {};
  let sawRoot = false;
  for await (const info of walkTree(path, limits, outcome)) {
    sawRoot = true;
    if (info.mtimeMs > cutoffMs) return true;
  }
  return !sawRoot || outcome.cutShort === true;
}
