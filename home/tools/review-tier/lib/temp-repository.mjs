// Purpose: the folder of review-tier's own repository: make it, check that it holds only what this run put there, remove it, and clear
//   the folders that killed runs left behind.
// Exports: TEMP_PREFIX, makeTempFolder() -> path, removeTempFolder(path), removeStaleTempFolders(now) -> problems,
//   staleFolderShape(folder) -> { files, folders, stray }, removeByName(folder, shape), snapshotOf(gitDir) -> snapshot,
//   checkTempFolder(gitDir, snapshot, packNames), notePackFiles(gitDir, name, written) -> note, checkPackFiles(gitDir, notes, { last }).
// Why the check: the folder is in the temp directory of the same OS user as the writer of a fix. A process that writer left running could
//   add `objects/info/alternates`, a graft file, a ref, config or a pack, or swap a pack's files, and the tool's reads would then see
//   objects or history it never imported (security N27, N33, S10 of lane r7-delta).
// What the check compares: names, file types, and the bytes of `HEAD` and `config`. For each imported pack it compares dev, inode, size,
//   mtime and ctime with what was there right after `git index-pack`, and at the end of the run it compares the `.pack` bytes with the
//   bytes the tool wrote. It does not check `.idx` or `.rev` against what git wrote. It runs after each import and once after the last
//   read; every read runs between those two checks. A change that a process of the same user makes and undoes between two checks (a pack
//   added and removed) is not seen, and neither is an `.idx` replaced before the tool notes it. Only a folder the writer's processes
//   cannot write closes this (N27/N33, phase 3). The checks narrow the window; they are not a lock.
// Invariants: the folder is made by mkdtemp (mode 0700, a name nobody can predict) and is the bare repository itself. A file beside it,
//   `<folder>.pid`, holds the pid of the run that owns it; nothing is ever written into the repository by this module. An old folder is
//   removed only when it is named by TEMP_PREFIX plus mkdtemp's six characters, is older than STALE_AFTER_MS, has no live owner and has
//   the shape a run of this tool can leave (STALE_SHAPE, read with no link followed); it is removed entry by entry, by name, never
//   recursively, so a folder renamed onto that name in between loses at most files of those names.
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const NOTED_STAT = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']; // a rename, a rewrite in place and `touch` each move one of them
const HASH_CHUNK_BYTES = 1 << 20; // a pack can exceed 2 GiB, which readFileSync cannot read: it is hashed in chunks
const IMPORTED_PACK_FILE = /^pack-[0-9a-f]{40}\.(?:pack|idx|rev)$/;
const KILLED_GIT_WRITE = /^tmp_(?:pack|idx|rev)_[A-Za-z0-9]{6}$/; // what `git index-pack` leaves when it is killed while it writes
const fileOrFolder = (files, folders) => (name) => (files.includes(name) ? 'file' : folders.includes(name) ? 'folder' : 'nothing');
/** What a run can leave behind, folder by folder (`import.pack`: a run killed during an import): name -> 'file' | 'folder' | 'nothing'. */
const STALE_SHAPE = new Map([
  ['', fileOrFolder(['HEAD', 'config', 'import.pack'], ['objects', 'refs'])],
  ['objects', fileOrFolder([], ['info', 'pack'])],
  ['objects/info', () => 'nothing'],
  ['objects/pack', (name) => (IMPORTED_PACK_FILE.test(name) || KILLED_GIT_WRITE.test(name) ? 'file' : 'nothing')],
  ['refs', fileOrFolder([], ['heads', 'tags'])],
  ['refs/heads', () => 'nothing'],
  ['refs/tags', () => 'nothing'],
]);

/** Makes the folder for the tool's repository and the pid file beside it. */
export function makeTempFolder() {
  const folder = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  writeFileSync(`${folder}${PID_SUFFIX}`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  return folder;
}

/**
 * Removes this run's own folder and its pid file; a folder that is already gone is fine. The pid file goes first: a run killed in
 * between leaves a folder with no owner, which a later run clears after a day (review N6-5).
 */
export function removeTempFolder(folder) {
  rmSync(`${folder}${PID_SUFFIX}`, { force: true });
  rmSync(folder, { recursive: true, force: true });
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

/** Walks `relative` inside `folder` into `shape`; returns the first entry that does not fit STALE_SHAPE (a link never fits), or null. */
function strayIn(folder, relative, shape) {
  for (const entry of readdirSync(join(folder, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const kind = STALE_SHAPE.get(relative)(entry.name);
    if (kind === 'file' && entry.isFile()) shape.files.push(path);
    else if (kind !== 'folder' || !entry.isDirectory()) return path;
    else {
      const stray = strayIn(folder, path, shape);
      if (stray !== null) return stray;
      shape.folders.push(path); // after everything inside it: the list is deepest first
    }
  }
  return null;
}

/**
 * What an old folder holds, read with no link followed.
 * @param {string} folder a candidate for removal
 * @returns {{files: string[], folders: string[], stray: string | null}} the files and folders (deepest first) inside it, as paths
 *   relative to it; `stray`: the first entry that a run of this tool cannot leave there, or null when the whole folder fits
 */
export function staleFolderShape(folder) {
  const shape = { files: [], folders: [] };
  return { ...shape, stray: strayIn(folder, '', shape) };
}

/**
 * Removes `folder` by the names `shape` lists, never recursively: each listed file that is still a regular file, then each listed
 * folder, deepest first, then the folder itself.
 * @param {string} folder the folder staleFolderShape read
 * @param {{files: string[], folders: string[]}} shape what staleFolderShape returned for it
 * @throws {Error} from the file system; a folder that holds anything else now is not empty (ENOTEMPTY) and stops the removal there
 */
export function removeByName(folder, { files, folders }) {
  for (const file of files) {
    if (lstatSync(join(folder, file), { throwIfNoEntry: false })?.isFile()) unlinkSync(join(folder, file));
  }
  for (const inner of folders) rmdirSync(join(folder, inner));
  rmdirSync(folder);
}

/** Removes the pid file beside a removed folder when it is a regular file; returns a problem line for anything else there. */
function removePidFile(folder) {
  const pidFile = `${folder}${PID_SUFFIX}`;
  const stat = lstatSync(pidFile, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (!stat.isFile()) return `left alone: ${pidFile} is not a regular file (the old temp folder beside it was removed)`;
  unlinkSync(pidFile);
  return null;
}

/** True for a real folder of this user, older than a day, whose owner is gone. */
function isStale(folder, now) {
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  const mine = process.getuid === undefined || stat?.uid === process.getuid();
  return stat?.isDirectory() === true && mine && now - stat.mtimeMs >= STALE_AFTER_MS && !ownerIsAlive(`${folder}${PID_SUFFIX}`);
}

/**
 * Removes the temp repositories of runs that were killed before they could (the owner's rule: the setup must not fill the disk).
 * @param {number} now the time to measure age from, in ms
 * @returns {string[]} one line per folder that was left alone, could not be looked at or was not removed; such a problem never stops a
 *   review
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
      if (!isStale(folder, now)) continue;
      const shape = staleFolderShape(folder);
      if (shape.stray !== null) {
        problems.push(`left alone: not a review-tier temp repository: ${folder} (it holds ${shape.stray})`);
        continue;
      }
      removeByName(folder, shape);
      const problem = removePidFile(folder);
      if (problem !== null) problems.push(problem);
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

/** The names in `folder`, sorted; every entry must be a real folder or file as `kinds` says (a link is neither); a missing folder is refused. */
function entriesOf(gitDir, folder, kinds) {
  let entries;
  try {
    entries = readdirSync(join(gitDir, folder), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw untrusted(`the tool's own temp repository ${gitDir} lost a part of itself (${folder} is gone)`);
    throw error;
  }
  for (const entry of entries) {
    const expected = kinds(entry.name);
    const fits = expected === 'folder' ? entry.isDirectory() : expected === 'file' ? entry.isFile() : false;
    if (!fits) throw untrusted(`the tool's own temp repository holds ${join(folder, entry.name)}, which this run did not put there (another process is writing into ${gitDir})`);
  }
  return entries.map((entry) => entry.name).sort();
}

/**
 * Stops the run unless the temp repository holds nothing but what `git init --bare --template=` and this run's imports wrote: `HEAD`
 * and `config` with the bytes of `snapshot`, `objects/info/` and `refs/heads/`, `refs/tags/` empty, and in `objects/pack/` no file but
 * those of the packs of `packNames` (whether those files are all there and unchanged is checkPackFiles' part). No alternates file,
 * graft file, ref, shallow file, attributes file or loose object can be there.
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

const packFile = (gitDir, name, kind) => join(gitDir, 'objects', 'pack', `${name}.${kind}`);
const changed = (gitDir, what) => untrusted(`the tool's own temp repository changed during the run: ${what} (another process is writing into ${gitDir})`);
/** The NOTED_STAT fields of a regular file as one string, or null when there is no regular file of that name (a link is none). */
function statOf(path) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? NOTED_STAT.map((field) => stat[field]).join(' ') : null;
}

/** The SHA-256 of a file, read in chunks of HASH_CHUNK_BYTES. */
function sha256OfFile(path) {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    for (let read = readSync(descriptor, chunk); read > 0; read = readSync(descriptor, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

/**
 * What the later checks compare a pack with, taken right after `git index-pack` stored it.
 * @param {string} gitDir the temp repository
 * @param {string} name the `pack-<hash>` name `git index-pack` printed
 * @param {{trailer: string, sha256: string}} written what the pack writer wrote (lib/pack-writer.mjs): its SHA-1 trailer, which names the
 *   pack git stores, and the SHA-256 of all its bytes
 * @returns {{sha256: string, stats: Map<string, string>}} the bytes to expect in the `.pack`, and the file facts of `.pack`, `.idx`, `.rev`
 * @throws {UsageError} when git named another pack than the one written, or a file of it is not there as a regular file
 */
export function notePackFiles(gitDir, name, written) {
  if (name !== `pack-${written.trailer}`) throw untrusted(`git index-pack named the pack ${name}, not the pack-${written.trailer} this run wrote (another process is writing into ${gitDir})`);
  const stats = new Map(PACK_FILE_KINDS.map((kind) => [kind, statOf(packFile(gitDir, name, kind))]));
  for (const [kind, stat] of stats) {
    if (stat === null) throw changed(gitDir, `${packFile(gitDir, name, kind)} is not there right after git index-pack`);
  }
  return { sha256: written.sha256, stats };
}

/**
 * Stops the run unless every noted pack file is there with the facts notePackFiles took; with `last`, also unless each `.pack` still
 * holds the bytes the tool wrote.
 * @param {string} gitDir the temp repository
 * @param {Map<string, {sha256: string, stats: Map<string, string>}>} notes pack name -> notePackFiles' result
 * @param {{last?: boolean}} options `last`: the check after the last read, which also hashes each `.pack` again
 * @throws {UsageError} "the tool's own temp repository changed during the run", naming the file
 */
export function checkPackFiles(gitDir, notes, { last = false } = {}) {
  for (const [name, { sha256, stats }] of notes) {
    for (const [kind, stat] of stats) {
      if (statOf(packFile(gitDir, name, kind)) !== stat) throw changed(gitDir, `${packFile(gitDir, name, kind)} is gone or is not the file git index-pack wrote`);
    }
    if (last && sha256OfFile(packFile(gitDir, name, 'pack')) !== sha256) throw changed(gitDir, `${packFile(gitDir, name, 'pack')} no longer holds the bytes this run wrote`);
  }
}
