// Purpose: the only code of review-tier that reads the lane's object store: it copies every object a run may read into the tool's own
//   repository, each under the name its own content gives ("verified import").
// Exports: alternatesEntry(path), openLaneSource(git, objectsDir) -> { isCommit(sha), importCommits(endpoints), importSnapshot(plan) }.
// Why: git does not check an object's hash when it reads it, and one name can have several copies in a store (a loose file, a pack, a
//   second pack with a forged index, a folder named by `objects/info/alternates`); which copy a read is served depends on which pack git
//   used last. Fix round 4 re-hashed the objects and then let the diffs read the lane's store again: the copy that was checked was not
//   always the copy that was read (security B13 of lane r7-delta), and the list of what to check had a gap (B12). Here each object is
//   read from the lane once, hashed, and written into the tool's own store; every later read sees only that store.
// How: two phases, each one pack built here (lib/pack-writer.mjs) and indexed by `git index-pack`, which names every object from its
//   content again with git's collision-detecting SHA-1. Phase 1: the commits reachable from the run's endpoints, so every ancestry
//   question is answered from imported commits. Phase 2, once the merge bases and the lane start are known: the trees of the commits
//   that are compared, every file of the tip (what lands, unchanged files included), both sides of every changed path, and every
//   `.gitattributes` of the lane start (attributes are read from it). After each phase the closure check (lib/closure-check.mjs) proves
//   in the tool's own store that nothing a read needs is missing, and the folder check that nothing else was put there; the pack git
//   stored must be the one written here (its name is the writer's trailer, and its bytes are hashed again after the last read).
// Invariants: the lists of what to copy are made on the lane's side from objects that are not checked yet, so they are hints: a list
//   with too much costs time, and one with too little leaves an object missing, which the closure check turns into exit 2. A mismatch
//   between a name and its content, a missing object, an object of another type than what names it, or one above MAX_OBJECT_BYTES is a
//   UsageError (exit 2) naming the object. Memory is bounded: objects are read in batches of MAX_BATCH_BYTES and the pack is a file.
//   Never `git fsck` (`--no-full` and `--connectivity-only` miss a forged pack, `rev-list --verify-objects` exits 0 on a mismatch).
import { createHash } from 'node:crypto';
import { closeSync, openSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { checkCommitClosure, checkSnapshotClosure } from './closure-check.mjs';
import { attributeBlobs, changedBlobs, fileBlobs, listed, treeEntries, untrusted } from './object-listing.mjs';
import { MAX_OBJECT_BYTES, openPack } from './pack-writer.mjs';
import { spawnGit } from './trusted-git.mjs';

const MAX_BATCH_BYTES = 64 << 20; // objects read in one `cat-file --batch` call; one larger object is a batch of its own
const BATCH_SLACK_BYTES = 1 << 20; // room for the header lines of a batch
const HEADER_BYTES_PER_OBJECT = 64; // `<oid> <type> <size>\n` and the newline after the content
const NEWLINE = 0x0a;
const IMPORT_PACK = 'import.pack'; // in the temp folder while `git index-pack` reads it, then removed
const ROOT_TREE_LINE = /^tree ([0-9a-f]{40})\n/;
const INDEXED_PACK = /^(?:pack|keep)\t([0-9a-f]{40})$/; // what `git index-pack --stdin` prints

/**
 * One entry of GIT_ALTERNATE_OBJECT_DIRECTORIES. Git splits the value at the path delimiter and C-unquotes an entry that starts with a
 * double quote, so a folder whose path holds the delimiter (or starts with a quote) is written quoted; any other path is written as it is.
 */
export function alternatesEntry(path) {
  if (!path.includes(delimiter) && !path.startsWith('"')) return path;
  return `"${path.replace(/[\\"]/g, '\\$&')}"`;
}

/** The oids with their sizes as the lane reports them, cut into batches of at most MAX_BATCH_BYTES of content. */
function batchesOf(lane, oids) {
  const rows = listed(lane, ['cat-file', '--batch-check'], `${oids.join('\n')}\n`).split('\n').filter(Boolean);
  if (rows.length !== oids.length) throw untrusted(`git listed ${rows.length} of ${oids.length} objects`);
  const batches = [{ oids: [], bytes: 0 }];
  for (const row of rows) {
    const [oid, type, size] = row.split(' ');
    if (type === 'missing' || !(Number(size) >= 0)) throw untrusted(`object ${oid} is missing`);
    if (Number(size) > MAX_OBJECT_BYTES) throw untrusted(`object ${oid} is ${size} bytes, more than the ${MAX_OBJECT_BYTES} this tool checks`);
    if (batches.at(-1).oids.length > 0 && batches.at(-1).bytes + Number(size) > MAX_BATCH_BYTES) batches.push({ oids: [], bytes: 0 });
    batches.at(-1).oids.push(oid);
    batches.at(-1).bytes += Number(size);
  }
  return batches;
}

/**
 * Reads one batch from the lane and gives each object to `take(type, content)` once its sha1 (over `<type> <size>\0<content>`, as git
 * names it) equals the name it was asked by and its type is the one `wanted` holds for it.
 */
function readBatch(lane, { oids, bytes }, wanted, take) {
  const maxBytes = bytes + oids.length * HEADER_BYTES_PER_OBJECT + BATCH_SLACK_BYTES;
  const { status, stdout, stderr } = lane(['cat-file', '--batch'], { input: `${oids.join('\n')}\n`, maxBytes });
  if (status !== 0) throw untrusted(`git cat-file failed (${stderr.split('\n')[0]})`);
  let at = 0;
  for (const oid of oids) {
    const lineEnd = stdout.indexOf(NEWLINE, at);
    const [name, type, size] = lineEnd < 0 ? [] : stdout.toString('latin1', at, lineEnd).split(' ');
    if (name !== oid || !(Number(size) >= 0)) throw untrusted(`object ${oid} is missing or cannot be read`);
    const content = stdout.subarray(lineEnd + 1, lineEnd + 1 + Number(size));
    const actual = createHash('sha1').update(`${type} ${size}\0`).update(content).digest('hex');
    if (content.length !== Number(size) || actual !== oid) throw untrusted(`object ${oid} does not hash to its name (its content hashes to ${actual}): it was rewritten in place`);
    if (type !== wanted.get(oid)) throw untrusted(`object ${oid} is a ${type}, but what names it takes it for a ${wanted.get(oid)}`);
    take(type, content);
    at = lineEnd + 1 + Number(size) + 1;
  }
}

/** Writes the objects of `wanted` into the pack `file`, each read from the lane once and checked as readBatch says; gives the pack's hashes. */
function writePack(lane, file, wanted) {
  const pack = openPack(file, wanted.size);
  try {
    for (const batch of batchesOf(lane, [...wanted.keys()])) readBatch(lane, batch, wanted, pack.add);
    return pack.finish();
  } finally {
    pack.close();
  }
}

/** Copies the objects of `wanted` (oid -> type) into the tool's repository as one pack, indexed by git there. */
function importObjects(git, lane, wanted) {
  if (wanted.size === 0) return;
  const file = join(git.gitDir, IMPORT_PACK);
  try {
    const written = writePack(lane, file, wanted);
    const descriptor = openSync(file, 'r');
    try {
      // The pack is git's standard input as a file, so it is never held in memory a second time.
      const indexed = git.run(['index-pack', '--stdin'], { stdinFile: descriptor });
      const [, name] = INDEXED_PACK.exec(indexed.stdout.toString().trim()) ?? [];
      if (indexed.status !== 0 || name === undefined) throw new Error(`git index-pack failed: ${indexed.stderr.split('\n')[0]}`);
      git.notePack(`pack-${name}`, written);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** Adds each oid to `wanted` with its type; one name asked for as two types is refused (no object is both). */
function want(wanted, oids, type) {
  for (const oid of oids) {
    if (wanted.has(oid) && wanted.get(oid) !== type) throw untrusted(`object ${oid} is named as a ${wanted.get(oid)} and as a ${type}`);
    wanted.set(oid, type);
  }
}

/** The root tree a commit names, from its imported bytes (git starts a commit with its `tree` line; the tree itself need not be there yet). */
function rootTreeOf(git, commit) {
  const [, tree] = ROOT_TREE_LINE.exec(git.bytes(['cat-file', 'commit', commit]).toString('latin1')) ?? [];
  if (tree === undefined) throw untrusted(`commit ${commit} does not start with a tree line`);
  return tree;
}

/**
 * Every entry of every tree of `commit`, as the lane lists it. Git checks the hash of a root tree it lists and stops when it is wrong:
 * the root is then read and hashed here, so the refusal names it like any other rewritten object.
 */
function laneEntries(lane, commit, root) {
  const { status, stdout, stderr } = lane(['ls-tree', '-r', '-t', '-z', commit]);
  if (status === 0) return treeEntries(stdout.toString('latin1'), commit);
  for (const batch of batchesOf(lane, [root])) readBatch(lane, batch, new Map([[root, 'tree']]), () => {});
  throw untrusted(`git ls-tree failed (${stderr.split('\n')[0]})`);
}

/** What phase 2 copies for `plan`, listed on the lane's side: see the header. */
function snapshotObjects(git, lane, { tip, treeCommits, pairs, attributeSource }) {
  const wanted = new Map();
  for (const commit of new Set(treeCommits)) {
    const root = rootTreeOf(git, commit);
    const entries = laneEntries(lane, commit, root);
    want(wanted, [root, ...entries.filter(({ type }) => type === 'tree').map(({ oid }) => oid)], 'tree');
    if (commit === tip) want(wanted, fileBlobs(entries), 'blob');
    if (commit === attributeSource) want(wanted, attributeBlobs(entries), 'blob');
  }
  for (const [from, to] of pairs) want(wanted, changedBlobs(listed(lane, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', from, to]), `${from} and ${to}`), 'blob');
  return wanted;
}

/**
 * Opens the lane's object store for the import.
 * @param {object} git the trusted reader (lib/trusted-git.mjs): its repository receives the objects
 * @param {string} objectsDir the lane's object folder (`<common dir>/objects`), an absolute real path
 * @returns {{isCommit: Function, importCommits: Function, importSnapshot: Function}}
 *   `isCommit(sha)`: true when the lane holds a commit of that name whose content hashes to it, false for a missing object and for
 *   another type (a tag object, a tree); it reads the one object only, so it can be asked before anything is imported;
 *   `importCommits(endpoints)`: phase 1, for full shas `isCommit` accepted; after it ancestry can be asked of the trusted reader;
 *   `importSnapshot({ endpoints, tip, treeCommits, pairs, attributeSource })`: phase 2, for the commits whose every tree is read,
 *   the commit whose every file is read (`tip`), the pairs of commits that are diffed, and the commit attributes are read from
 * @throws {UsageError} from each of them, naming the object that is missing, rewritten or of the wrong type
 */
export function openLaneSource(git, objectsDir) {
  // The same temp repository, with the lane's objects borrowed: only the calls made here carry this environment.
  const laneEnv = { ...git.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesEntry(objectsDir) };
  const lane = (args, options) => spawnGit(git.gitDir, laneEnv, args, options);
  const known = new Map();
  // One object, asked by name: what the lane says its type and size are, then its content, hashed.
  const readsAsCommit = (sha) => {
    const [name, type, size] = listed(lane, ['cat-file', '--batch-check'], `${sha}\n`).trim().split(' ');
    if (name !== sha || type !== 'commit' || !(Number(size) >= 0)) return false;
    readBatch(lane, { oids: [sha], bytes: Number(size) }, new Map([[sha, 'commit']]), () => {});
    return true;
  };
  return {
    isCommit(sha) {
      if (!known.has(sha)) known.set(sha, readsAsCommit(sha));
      return known.get(sha);
    },
    importCommits(endpoints) {
      const commits = listed(lane, ['rev-list', ...new Set(endpoints)]).split('\n').filter(Boolean);
      importObjects(git, lane, new Map(commits.map((oid) => [oid, 'commit'])));
      git.checkFolder();
      checkCommitClosure(git, endpoints);
    },
    importSnapshot(plan) {
      importObjects(git, lane, snapshotObjects(git, lane, plan));
      git.checkFolder();
      checkSnapshotClosure(git, plan);
    },
  };
}
