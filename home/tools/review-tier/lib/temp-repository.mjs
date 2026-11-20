// Purpose: the folder of review-tier's own repository: make it, check that it holds only what this run put there, and remove it.
// Exports: TEMP_PREFIX, makeTempFolder() -> { path, dev, ino }, removeTempFolder(made) -> problem, snapshotOf(gitDir) -> snapshot,
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
// Invariants: the folder is made by mkdtemp (mode 0700, a name nobody can predict) and is the bare repository itself; this module writes
//   nothing into it and nothing beside it. It removes no folder but the one this run made, from inside: each folder is entered and
//   checked by device and inode before anything in it is removed, and entries go by their bare names, so a link or another folder swapped
//   in during the removal is never followed (fix 7, K4). A run that is killed leaves its folder (`review-tier-git-*` in the system temp
//   folder) behind, and no run of this tool removes it.
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { untrusted } from './object-listing.mjs';

export const TEMP_PREFIX = 'review-tier-git-';
const PACK_FILE_KINDS = ['pack', 'idx', 'rev']; // what `git index-pack` writes per pack (`.rev` from git 2.41 on by default)
const TOP_ENTRIES = ['HEAD', 'config', 'objects', 'refs']; // all `git init --bare --template=` makes at the top
const UNCHANGED_FILES = ['HEAD', 'config'];
const NOTED_STAT = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']; // a rename, a rewrite in place and `touch` each move one of them
const HASH_CHUNK_BYTES = 1 << 20; // a pack can exceed 2 GiB, which readFileSync cannot read: it is hashed in chunks

/**
 * Makes the folder for the tool's repository.
 * @returns {{path: string, dev: bigint, ino: bigint}} its path, and the device and inode removeTempFolder checks before it removes anything
 */
export function makeTempFolder() {
  const path = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const { dev, ino } = lstatSync(path, { bigint: true });
  return { path, dev, ino };
}

/** Throws unless the working directory is the folder `expected` names (same device and inode). */
function assertHere(expected) {
  const here = lstatSync('.', { bigint: true });
  if (here.dev !== expected.dev || here.ino !== expected.ino) throw new Error('a folder in it was replaced while it was being removed');
}

/**
 * Removes everything in the working directory, which assertHere proved to be `here`: a file, link or other non-folder is unlinked by its
 * bare name; a folder is entered (chdir follows a link, so it is checked against its own lstat first thing), emptied, left (the parent
 * checked again) and removed with rmdir. The way of home/tools/disk-free/lib/safe-remove.mjs (removeFolder), without its owner and
 * mode checks: those refuse an honest group-writable folder made under umask 002, and this folder is the run's own.
 */
function emptyHere(here) {
  for (const name of readdirSync('.')) {
    const entry = lstatSync(name, { bigint: true });
    if (!entry.isDirectory()) {
      unlinkSync(name);
      continue;
    }
    process.chdir(name);
    assertHere(entry);
    emptyHere(entry);
    process.chdir('..');
    assertHere(here);
    rmdirSync(name);
  }
}

/** Empties the folder `made` from inside, puts the working directory `back`, then removes the empty folder (rmdir follows no link). */
function removeFromInside(made, back) {
  process.chdir(made.path);
  try {
    assertHere(made);
    emptyHere(made);
  } finally {
    process.chdir(back);
  }
  rmdirSync(made.path);
}

/**
 * Removes this run's own folder; a folder that is already gone is fine.
 * @param {{path: string, dev: bigint, ino: bigint}} made what makeTempFolder returned
 * @returns {string | null} null when the folder is gone; else one line saying what stopped the removal, which then leaves the rest where
 *   it is. It never throws, so the `finally` that calls it cannot hide the run's own error.
 */
export function removeTempFolder(made) {
  try {
    removeFromInside(made, process.cwd());
    return null;
  } catch (error) {
    if (error.code === 'ENOENT' && lstatSync(made.path, { throwIfNoEntry: false }) === undefined) return null;
    return `the temp folder ${made.path} was not removed in full, the rest is left there: ${error.message}`;
  }
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
