// The pass cache of `suite run`: a command that passed on a clean tree is not run again on the same tree.
// Exports: cacheKey, lookup, recordPass, removeOlderThan, CACHE_KEEP_MS.
// Invariants:
// - Only passes are stored (the caller records exit 0 on a clean tree only), so a failure always runs again.
// - The key is the exact tree sha, the folder the command runs in (relative to the repo's top), the command as given (argv, not a
//   joined string), the Node version and the platform: any change to one of them is a miss.
// - An entry older than CACHE_KEEP_MS is a miss and is removed by the next recordPass.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_KEEP_MS = 14 * 24 * 60 * 60 * 1000; // 14 days: long enough to reuse a pass across a week of lanes
const CACHE_FOLDER = 'cache';
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The cache key of one run.
 * @param {{ tree: string, folder: string, command: string[], nodeVersion: string, platform: string }} run the tree sha
 *   (`HEAD^{tree}`), the folder relative to the repo's top (`git rev-parse --show-prefix`), the command and its arguments,
 *   `process.version` and `process.platform`
 * @returns {string} a sha256 hex string
 */
export function cacheKey({ tree, folder, command, nodeVersion, platform }) {
  return createHash('sha256').update(JSON.stringify([tree, folder, command, nodeVersion, platform])).digest('hex');
}

const entryPath = (stateDir, key) => {
  if (!KEY_PATTERN.test(key)) throw new Error(`not a cache key: ${key}`);
  return join(stateDir, CACHE_FOLDER, `${key}.json`);
};

/**
 * The stored pass for `key`, or null when there is none or it is older than CACHE_KEEP_MS.
 * @param {string} stateDir the suite state folder
 * @param {string} key from cacheKey
 * @returns {{ at: string, log?: string } | null} `at` is the ISO time of the pass, `log` the path of its log
 * @throws {Error} an entry that exists but is not valid JSON (a broken cache must be seen, not read as a miss)
 */
export function lookup(stateDir, key) {
  let text;
  try {
    text = readFileSync(entryPath(stateDir, key), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const entry = JSON.parse(text);
  const age = Date.now() - Date.parse(entry.at);
  return Number.isFinite(age) && age >= 0 && age < CACHE_KEEP_MS ? entry : null;
}

/**
 * Stores a pass for `key` and removes expired entries.
 * @param {string} stateDir the suite state folder
 * @param {string} key from cacheKey
 * @param {{ at: string, tree: string, command: string[], repo: string, log: string }} entry what `cached PASS` prints later
 */
export function recordPass(stateDir, key, entry) {
  const folder = join(stateDir, CACHE_FOLDER);
  mkdirSync(folder, { recursive: true });
  removeOlderThan(folder, CACHE_KEEP_MS);
  const target = entryPath(stateDir, key);
  // write aside, then rename: a reader never sees half an entry
  const partial = `${target}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(entry));
  renameSync(partial, target);
}

/**
 * Removes the files in `folder` whose last change is older than `maxAgeMs` (old cache entries and logs).
 * @param {string} folder a folder that may not exist yet
 * @param {number} maxAgeMs the age limit in milliseconds
 */
export function removeOlderThan(folder, maxAgeMs) {
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const oldest = Date.now() - maxAgeMs;
  for (const name of names) {
    const path = join(folder, name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isFile() && stats.mtimeMs < oldest) rmSync(path, { force: true });
  }
}
