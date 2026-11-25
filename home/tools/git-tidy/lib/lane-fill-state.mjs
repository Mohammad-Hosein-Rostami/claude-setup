// Purpose: the fill file of a lane slot in clone mode (lane-fill.mjs cloneSupport), `<git common dir>/cs-lane-fill/lane-<n>.json`
//   holding `{ pid, branch, target, startedAt }`. A claim writes it in its first step under the pool lock and deletes it in its end
//   step under the lock again (lane-pool.mjs). While its pid lives the slot is filling; once that pid is gone (or the claim failed in
//   this process) the slot is broken (lane-slots.mjs readSlot), and the next claim that takes it empties it here and fills it again.
// Exports: FILL_FOLDER, startFillFile, readFillFile, deleteFillFile, isPidAlive, removeStaleIndexLock, emptyForRefill.
// Invariants:
// - A fill file is written through a fresh temp file (O_EXCL, 0600) renamed over it, so a link at its name is replaced, never followed,
//   and a reader never sees half a file. It is read only as a plain file of at most MAX_FILL_FILE_BYTES with a checked shape; anything
//   else throws, and the reader keeps the slot busy.
// - Of git's own files, a refill removes only the `index.lock` a fill killed mid-git leaves, and only once the fill's pid is gone.
// - A broken slot is emptied by deleting its entries except its `.git` file (never `git worktree remove --force`, never a reset); its
//   HEAD then moves to the new target without writing a file: the index becomes the target's tree first (`read-tree`), so
//   `switch --detach` keeps every entry and only moves HEAD.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitText } from './git.mjs';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';

export const FILL_FOLDER = 'cs-lane-fill';
const MAX_FILL_FILE_BYTES = 4096;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PRIVATE_FOLDER = 0o700;
const PRIVATE_FILE = 0o600;
const TEMP_SUFFIX_BYTES = 8;
const GIT_FILE = '.git';
const INDEX_LOCK = 'index.lock';

const fillFilePath = (commonDir, slot) => join(commonDir, FILL_FOLDER, `${slot}.json`);

const isFillFile = (value) => Number.isInteger(value?.pid) && value.pid > 0 && typeof value.branch === 'string'
  && FULL_SHA.test(value.target ?? '') && typeof value.startedAt === 'string';

/**
 * Writes the fill file of `slot` naming this process, so no other claim switches, empties or hands out the slot while it fills.
 * @param {string} commonDir the absolute git common dir
 * @param {string} slot the slot name, `lane-<n>`
 * @param {{ branch: string, target: string }} lane the branch the fill is for and the full sha it fills
 * @returns {{ pid: number, branch: string, target: string, startedAt: string }} what was written (the end step compares it)
 */
export function startFillFile(commonDir, slot, { branch, target }) {
  const fillFile = { pid: process.pid, branch, target, startedAt: new Date().toISOString() };
  const path = fillFilePath(commonDir, slot);
  mkdirSync(join(commonDir, FILL_FOLDER), { recursive: true, mode: PRIVATE_FOLDER });
  const temp = `${path}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}`;
  writeFileSync(temp, JSON.stringify(fillFile), { flag: 'wx', mode: PRIVATE_FILE });
  renameSync(temp, path);
  return fillFile;
}

/**
 * The fill file of `slot`.
 * @param {string} commonDir the absolute git common dir
 * @param {string} slot the slot name, `lane-<n>`
 * @returns {{ pid: number, branch: string, target: string, startedAt: string }|null} null when the slot has none
 * @throws {Error} when one is there but is a link, too big, torn or not of that shape
 */
export function readFillFile(commonDir, slot) {
  const path = fillFilePath(commonDir, slot);
  let value;
  try {
    value = JSON.parse(readPlainFile(path, MAX_FILL_FILE_BYTES));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`fill file ${path} cannot be read (${error.code ?? error.message})`, { cause: error });
  }
  if (!isFillFile(value)) throw new Error(`fill file ${path} is not { pid, branch, target, startedAt }`);
  return value;
}

/** Deletes the fill file of `slot` (the end step of its claim); a missing one is no error. */
export function deleteFillFile(commonDir, slot) {
  rmSync(fillFilePath(commonDir, slot), { force: true });
}

/** True unless signal 0 says the process is gone (EPERM: it runs under another user). */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Removes the `index.lock` that a fill killed in the middle of a git command leaves in the slot's own git folder.
 * @param {string} folder a slot folder that lane-slots.mjs readSlot just read as broken (its fill's pid is gone; git takes the folder
 *   as its own worktree root, so the git folder is the slot's, never the main checkout's)
 * @throws {Error} when git cannot name the git folder, or the file cannot be deleted
 */
export function removeStaleIndexLock(folder) {
  rmSync(join(gitText(folder, ['rev-parse', '--absolute-git-dir']), INDEX_LOCK), { force: true });
}

/**
 * Empties the broken slot `folder` except its `.git` file and moves its HEAD, detached, to `target` without writing a file (see the
 * header), so it is the empty worktree at `target` that lane-fill.mjs fillFresh fills.
 * @param {string} folder a slot folder that lane-slots.mjs readSlot just read as broken, now holding this claim's fill file
 * @param {string} target the full sha the new lane starts at
 * @throws {Error} when an entry cannot be deleted or git fails
 */
export function emptyForRefill(folder, target) {
  for (const name of readdirSync(folder).filter((entry) => entry !== GIT_FILE)) rmSync(join(folder, name), { recursive: true, force: true });
  gitText(folder, ['read-tree', target]);
  gitText(folder, ['switch', '--quiet', '--detach', target]);
}
