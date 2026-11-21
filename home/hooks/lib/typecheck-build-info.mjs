// The tsbuildinfo files that make the typecheck gate's tsc runs incremental. Split from typecheck-gate.mjs, which would
// pass 300 lines with it.
// Exports: planBuildInfo(key), seedBuildInfo(info), closeBuildInfo(info, publish), MAX_BUILD_INFO_BYTES, COLD_CHANGED.
// Layout: <temp root>/tsbuildinfo/<sha256 of the key> is the shared file of one check, `<that>.sha256` the gate's own record
// of its content, and `run-XXXXXX/` one run's private folder (tsc writes `info` there; it is renamed over the shared file).
// Invariants: the folder is used only when `lstat` says it is a real folder of this user with no group or other bits (one an
// older gate left with such bits is emptied and made again); every run gets a fresh folder, so no name in it can be
// guessed; the shared file is read without following a link or waiting on a FIFO and within a cap, the private copy is
// created exclusively, and publishing is a rename, which replaces a link planted at the shared name and never writes
// through it. When the folder cannot be trusted the run still gets a private file in a fresh folder (tsc must never write
// its build info into the project) and nothing is seeded or published. A shared file whose content is not the one the
// record names (rewritten by someone else, or two stops that published at once) is not used: that run is cold.
// Not a boundary: a process of the same user can rewrite the shared file and its record together.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempRoot } from './edit-log.mjs';
import { readPlainFile } from './plain-file.mjs';

const OWNER_ONLY_FOLDER = 0o700;
const OWNER_ONLY_FILE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
/** The most a build info may hold to be seeded or published, for the reader and the writer alike: 64 MB (a large project's is a few MB). */
export const MAX_BUILD_INFO_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 256; // one sha256 in hex and a newline
const MISSING_FILE = 'ENOENT';
/** Why a run that had a shared build info did not start from it; the run log holds it as `cold: <this>`. */
export const COLD_CHANGED = 'build info changed outside the gate';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const recordPath = (shared) => `${shared}.sha256`;

const isOwnFolder = (stat) => stat.isDirectory() && (process.platform === 'win32' || stat.uid === process.getuid());
const isOwnerOnly = (stat) => process.platform === 'win32' || (stat.mode & GROUP_AND_OTHER_BITS) === 0;

// True when `dir` is (now) a real folder of this user that nobody else can write or read; never throws.
function ownerOnlyFolder(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_FOLDER });
    if (!isOwnFolder(lstatSync(dir))) return false;
    if (isOwnerOnly(lstatSync(dir))) return true;
    rmSync(dir, { recursive: true, force: true }); // left open by an older gate: what it holds is not trusted
    mkdirSync(dir, { mode: OWNER_ONLY_FOLDER });
    const stat = lstatSync(dir);
    return isOwnFolder(stat) && isOwnerOnly(stat);
  } catch {
    return false;
  }
}

/**
 * The build-info files of one check for this run.
 * @param {string} key what the check is about (the package folder or the tsconfig path)
 * @returns {{shared: string | null, runDir: string, privateInfo: string} | null} `shared` is null when the gate's folder
 *   cannot be trusted (the run is cold and publishes nothing); null when no temp folder can be made at all
 */
export function planBuildInfo(key) {
  const root = join(tempRoot(), 'tsbuildinfo');
  const trusted = ownerOnlyFolder(root);
  try {
    const runDir = mkdtempSync(trusted ? join(root, 'run-') : join(tmpdir(), 'claude-typecheck-'));
    return { shared: trusted ? join(root, sha256(key)) : null, runDir, privateInfo: join(runDir, 'info') };
  } catch {
    return null;
  }
}

/**
 * Copies the shared build info into the run's private file, when it is the one this gate published.
 * @param {{shared: string | null, privateInfo: string}} info from {@link planBuildInfo}
 * @returns {string | null} {@link COLD_CHANGED} when a shared file is there and was not used; null otherwise
 */
export function seedBuildInfo({ shared, privateInfo }) {
  if (!shared) return null;
  let text;
  try {
    text = readPlainFile(shared, MAX_BUILD_INFO_BYTES);
    if (readPlainFile(recordPath(shared), MAX_RECORD_BYTES).trim() !== sha256(text)) return COLD_CHANGED;
  } catch (error) {
    return error?.code === MISSING_FILE && text === undefined ? null : COLD_CHANGED; // no shared file yet is the normal cold run
  }
  try {
    writeFileSync(privateInfo, text, { flag: 'wx', mode: OWNER_ONLY_FILE });
  } catch {
    // cold run: it only costs the speed-up
  }
  return null;
}

/**
 * Ends a run: publishes its build info as the shared one (with the record of its content) when asked, then removes the
 * run's folder with whatever is left in it. Never throws; calling it again does nothing.
 * @param {{shared: string | null, runDir: string, privateInfo: string}} info from {@link planBuildInfo}
 * @param {boolean} publish false for a run that was killed or never started
 */
export function closeBuildInfo({ shared, runDir, privateInfo }, publish) {
  try {
    if (publish && shared) {
      const record = join(runDir, 'sha256');
      writeFileSync(record, `${sha256(readPlainFile(privateInfo, MAX_BUILD_INFO_BYTES))}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
      renameSync(privateInfo, shared);
      renameSync(record, recordPath(shared));
    }
  } catch {
    // tsc wrote no build info, or it cannot be published: the next run is cold
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
