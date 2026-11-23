// Purpose: the cache of inferred screens: one JSON file per repository under ~/.claude/state/ui-screens (UI_SCREENS_STATE_DIR
// overrides), keyed by the real git common dir (worktrees of one clone share it). Exports: CACHE_FORMAT, stateDirOf, hashOf,
// cacheFile, readCache, writeCache.
// Invariants (P7, P8, P16): nothing is written in the project; a missing, corrupt or foreign file reads as no entries and is
// replaced on the next save by an atomic rename of a temp file unique to this process; at most MAX_CACHE_ENTRIES entries are kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRun } from './git-read.mjs';

export const CACHE_FORMAT = 'ui-screens/1';
const MAX_CACHE_ENTRIES = 8;
const NAME_HASH_CHARS = 16;

/** The cache folder: UI_SCREENS_STATE_DIR, else ~/.claude/state/ui-screens of HOME (USERPROFILE on Windows). */
export const stateDirOf = (env) => env.UI_SCREENS_STATE_DIR ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude', 'state', 'ui-screens');

/** sha256 hex of the lines joined by newlines. */
export const hashOf = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex');

/** The cache file of the repository (worktrees of one clone share it: keyed by the real git common dir). */
export function cacheFile(repoDir, stateDir) {
  const common = fs.realpathSync.native(gitRun(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString('utf8').trim());
  const repo = path.basename(path.dirname(common)).replace(/[^A-Za-z0-9_.-]/g, '-');
  return { file: path.join(stateDir, `${repo}-${hashOf([common]).slice(0, NAME_HASH_CHARS)}.json`), common };
}

/** The cache entries; a missing, corrupt or foreign file reads as none (it is rewritten on the next save). */
export function readCache({ file, common }) {
  try {
    if (!fs.lstatSync(file).isFile()) return [];
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json?.format !== CACHE_FORMAT || json.commonDir !== common || !Array.isArray(json.entries)) return [];
    return json.entries.filter((e) => typeof e?.key === 'string' && e.extra && typeof e.extra === 'object' && Array.isArray(e.screens) && Array.isArray(e.unresolved));
  } catch {
    return []; // no cache yet, or one that cannot be read: a miss, never a failure
  }
}

/** Save an entry (newest first, MAX_CACHE_ENTRIES kept) by an atomic replace with a temp name unique to this process. */
export function writeCache(store, entry) {
  const entries = [entry, ...readCache(store).filter((e) => e.key !== entry.key)].slice(0, MAX_CACHE_ENTRIES);
  fs.mkdirSync(path.dirname(store.file), { recursive: true, mode: 0o700 });
  const temp = `${store.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ format: CACHE_FORMAT, commonDir: store.common, entries })}\n`, { mode: 0o600 });
  fs.renameSync(temp, store.file);
}
