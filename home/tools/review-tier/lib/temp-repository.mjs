// Purpose: the folder of review-tier's own repository: make it, prove it holds only what this run put there, remove it, and clear the
//   folders that killed runs left behind.
// Exports: TEMP_PREFIX, makeTempFolder() -> path, removeTempFolder(path), removeStaleTempFolders(now) -> problems,
//   snapshotOf(gitDir) -> snapshot, checkTempFolder(gitDir, snapshot, packNames).
// Why the check: the folder is in the temp directory of the same OS user as the writer of a fix. A process that writer left running could
//   add `objects/info/alternates`, a graft file, a ref or config between two of the tool's calls, and the tool's reads would then see
//   objects or history it never imported (security N27 of lane r7-delta). The check is a snapshot between calls, not a lock: a file
//   added and removed inside one git call is not seen.
// Invariants: the folder is made by mkdtemp (mode 0700, a name nobody can predict) and is the bare repository itself. A file beside it,
//   `<folder>.pid`, holds the pid of the run that owns it; nothing is ever written into the repository by this module. Only folders named
//   by TEMP_PREFIX plus mkdtemp's six characters, older than STALE_AFTER_MS and with no live owner, are removed, never anything else.
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { untrusted } from './object-listing.mjs';

export const TEMP_PREFIX = 'review-tier-git-';
const PID_SUFFIX = '.pid';
const STALE_FOLDER = /^review-tier-git-[A-Za-z0-9]{6}$/;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // a day: no run takes that long, so an older folder belongs to a run that was killed
const PACK_FILE_KINDS = ['pack', 'idx', 'rev']; // what `git index-pack` writes per pack (`.rev` from git 2.41 on by default)
const TOP_ENTRIES = ['HEAD', 'config', 'objects', 'refs']; // all `git init --bare --template=` makes at the top
const UNCHANGED_FILES = ['HEAD', 'config'];

/** Makes the folder for the tool's repository and the pid file beside it. */
export function makeTempFolder() {
  const folder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  writeFileSync(`${folder}${PID_SUFFIX}`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  return folder;
}

/** Removes the folder and its pid file; a folder that is already gone is fine. */
export function removeTempFolder(folder) {
  rmSync(folder, { recursive: true, force: true });
  rmSync(`${folder}${PID_SUFFIX}`, { force: true });
}

/** True when a process with the pid in `pidFile` runs now. A file that is missing or holds no pid has no live owner. */
function ownerIsAlive(pidFile) {
  const pid = Number(lstatSync(pidFile, { throwIfNoEntry: false })?.isFile() ? readFileSync(pidFile, 'utf8').trim() : NaN);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 sends nothing: it only asks whether the process exists
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // it exists and belongs to another user; ESRCH: no such process
  }
}

/**
 * Removes the temp repositories of runs that were killed before they could (the owner's rule: the setup must not fill the disk).
 * @param {number} now the time to measure age from, in ms
 * @returns {string[]} one line per folder that could not be looked at or removed; such a problem never stops a review
 */
export function removeStaleTempFolders(now = Date.now()) {
  const problems = [];
  let names = [];
  try {
    names = readdirSync(tmpdir());
  } catch (error) {
    return [`old temp folders were not cleared: ${error.message}`];
  }
  for (const name of names.filter((entry) => STALE_FOLDER.test(entry))) {
    const folder = join(tmpdir(), name);
    try {
      const stat = lstatSync(folder, { throwIfNoEntry: false });
      const mine = process.getuid === undefined || stat?.uid === process.getuid();
      if (!stat?.isDirectory() || !mine || now - stat.mtimeMs < STALE_AFTER_MS || ownerIsAlive(`${folder}${PID_SUFFIX}`)) continue;
      removeTempFolder(folder);
    } catch (error) {
      problems.push(`the old temp folder ${folder} was not removed: ${error.message}`);
    }
  }
  return problems;
}

/**
 * The bytes `git init` wrote into the files that must not change during the run.
 * @param {string} gitDir the temp repository, right after `git init`
 * @returns {Map<string, Buffer>} file name -> content
 */
export const snapshotOf = (gitDir) => new Map(UNCHANGED_FILES.map((name) => [name, readFileSync(join(gitDir, name))]));

/** The names in `folder`, sorted; every entry must be a real folder or file as `kinds` says (a link is neither). */
function entriesOf(gitDir, folder, kinds) {
  const entries = readdirSync(join(gitDir, folder), { withFileTypes: true });
  for (const entry of entries) {
    const expected = kinds(entry.name);
    const fits = expected === 'folder' ? entry.isDirectory() : expected === 'file' ? entry.isFile() : false;
    if (!fits) throw untrusted(`the tool's own temp repository holds ${join(folder, entry.name)}, which this run did not put there (another process is writing into ${gitDir})`);
  }
  return entries.map((entry) => entry.name).sort();
}

/**
 * Stops the run unless the temp repository holds exactly what `git init --bare --template=` and this run's imports wrote: `HEAD` and
 * `config` with the bytes of `snapshot`, `objects/info/` and `refs/heads/`, `refs/tags/` empty, and in `objects/pack/` only the packs
 * of `packNames`. No alternates file, graft file, ref, shallow file, attributes file or loose object can be there.
 * @param {string} gitDir the temp repository
 * @param {Map<string, Buffer>} snapshot snapshotOf(gitDir), taken right after init
 * @param {Iterable<string>} packNames the `pack-<hash>` names `git index-pack` reported to this run
 * @throws {UsageError} naming the first entry that does not belong, or the file that changed
 */
export function checkTempFolder(gitDir, snapshot, packNames) {
  const folders = (...names) => (name) => (names.includes(name) ? 'folder' : 'nothing');
  const packFiles = new Set([...packNames].flatMap((name) => PACK_FILE_KINDS.map((kind) => `${name}.${kind}`)));
  const top = entriesOf(gitDir, '.', (name) => (UNCHANGED_FILES.includes(name) ? 'file' : TOP_ENTRIES.includes(name) ? 'folder' : 'nothing'));
  if (top.join() !== [...TOP_ENTRIES].sort().join()) throw untrusted(`the tool's own temp repository ${gitDir} lost a part of itself (it holds ${top.join(', ')})`);
  entriesOf(gitDir, 'objects', folders('info', 'pack'));
  entriesOf(gitDir, join('objects', 'info'), () => 'nothing');
  entriesOf(gitDir, join('objects', 'pack'), (name) => (packFiles.has(name) ? 'file' : 'nothing'));
  entriesOf(gitDir, 'refs', folders('heads', 'tags'));
  entriesOf(gitDir, join('refs', 'heads'), () => 'nothing');
  entriesOf(gitDir, join('refs', 'tags'), () => 'nothing');
  for (const [name, bytes] of snapshot) {
    if (!readFileSync(join(gitDir, name)).equals(bytes)) throw untrusted(`${join(gitDir, name)} of the tool's own temp repository changed during the run (another process is writing into it)`);
  }
}
