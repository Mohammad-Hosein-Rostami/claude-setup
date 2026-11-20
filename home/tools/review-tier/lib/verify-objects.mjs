// Purpose: re-hash, in Node, every object a review-tier run relies on, before anything is read from it.
// Exports: verifyCommits(git, shas), verifyTrees(git, endpoints, head).
// Why: git does not check an object's hash when it reads it, and two trees that name the same blob are equal without reading it. A blob
//   rewritten in place in `objects/` (loose, or through a forged pack index) made a fix round look docs-only while the landed code lost
//   its guard (security B11 of lane r7-delta); a commit rewritten in place changes ancestry the same way.
// What is checked (a closure from the run's own shas, not the whole store): every commit reachable from the shas; every tree of the
//   endpoints' root trees; every blob of the head tree (what lands, unchanged files included); every blob that differs between two endpoints.
// Invariants: reads only through the trusted reader (lib/trusted-git.mjs), with `cat-file --batch` and sha1 here, never `git fsck`
//   (`--no-full` and `--connectivity-only` miss a forged pack, and `rev-list --verify-objects` exits 0 on a mismatch). A mismatch, a
//   missing object or a listing git cannot make is a UsageError (exit 2) that names the object. Memory is bounded: objects are read in
//   batches of MAX_BATCH_BYTES. Not covered: objects swapped after the check by a process that is still running.
import { createHash } from 'node:crypto';
import { UsageError } from '../../git-tidy/lib/git.mjs';

const MAX_BATCH_BYTES = 64 << 20; // objects read in one `cat-file --batch` call; one larger object is a batch of its own
const BATCH_SLACK_BYTES = 1 << 20; // room for the header lines of a batch
const HEADER_BYTES_PER_OBJECT = 64; // `<oid> <type> <size>\n` and the newline after the content
const NEWLINE = 0x0a;
const GITLINK_MODE = '160000'; // a submodule pointer: its commit lives in another repository
const NO_OBJECT = /^0+$/;
const TREE_ROW = /^(\d+) (\w+) ([0-9a-f]{40})\t/;
const RAW_ROW = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) /;

const untrusted = (what) => new UsageError(`the objects of this repository cannot be trusted: ${what}. Nothing was read from them: restore the repository (a fresh clone), or review by hand`);

/** The output of one listing command, as text with one byte per character; a failure of git there names what it could not read. */
function listing(git, args, input = undefined) {
  const { status, stdout, stderr } = git.run(args, { input });
  if (status !== 0) throw untrusted(`git ${args[0]} failed (${stderr.split('\n')[0]})`);
  return stdout.toString('latin1');
}

/** The oids with their sizes, cut into batches of at most MAX_BATCH_BYTES of content. */
function batchesOf(git, oids) {
  const rows = listing(git, ['cat-file', '--batch-check'], `${oids.join('\n')}\n`).split('\n').filter(Boolean);
  const batches = [{ oids: [], bytes: 0 }];
  for (const row of rows) {
    const [oid, type, size] = row.split(' ');
    if (type === 'missing' || !(Number(size) >= 0)) throw untrusted(`object ${oid} is missing`);
    if (batches.at(-1).oids.length > 0 && batches.at(-1).bytes + Number(size) > MAX_BATCH_BYTES) batches.push({ oids: [], bytes: 0 });
    batches.at(-1).oids.push(oid);
    batches.at(-1).bytes += Number(size);
  }
  if (rows.length !== oids.length) throw untrusted(`git listed ${rows.length} of ${oids.length} objects`);
  return batches;
}

/** Reads one batch and compares each object's sha1 (over `<type> <size>\0<content>`, as git names it) with its name. */
function rehashBatch(git, { oids, bytes }) {
  const maxBytes = bytes + oids.length * HEADER_BYTES_PER_OBJECT + BATCH_SLACK_BYTES;
  const { status, stdout, stderr } = git.run(['cat-file', '--batch'], { input: `${oids.join('\n')}\n`, maxBytes });
  if (status !== 0) throw untrusted(`git cat-file failed (${stderr.split('\n')[0]})`);
  let at = 0;
  for (const oid of oids) {
    const lineEnd = stdout.indexOf(NEWLINE, at);
    const [name, type, size] = lineEnd < 0 ? [] : stdout.toString('latin1', at, lineEnd).split(' ');
    if (name !== oid || !(Number(size) >= 0)) throw untrusted(`object ${oid} is missing or cannot be read`);
    const content = stdout.subarray(lineEnd + 1, lineEnd + 1 + Number(size));
    const actual = createHash('sha1').update(`${type} ${size}\0`).update(content).digest('hex');
    if (content.length !== Number(size) || actual !== oid) throw untrusted(`object ${oid} does not hash to its name (its content hashes to ${actual}): it was rewritten in place`);
    at = lineEnd + 1 + Number(size) + 1;
  }
}

function rehash(git, oids) {
  if (oids.length === 0) return;
  for (const batch of batchesOf(git, oids)) rehashBatch(git, batch);
}

/**
 * Checks every commit reachable from `shas`. Run it before anything walks parents (an ancestry suffix, a merge base, an ancestor test).
 * @param {object} git the trusted reader
 * @param {string[]} shas full shas of commits that exist
 * @throws {UsageError} naming the first object that is missing or does not hash to its name
 */
export function verifyCommits(git, shas) {
  rehash(git, listing(git, ['rev-list', ...new Set(shas)]).split('\n').filter(Boolean));
}

/** The tree oids of `end` (root and below) and, for the head, its blob oids. */
function treeOids(git, end, withBlobs) {
  const oids = [listing(git, ['rev-parse', '--verify', `${end}^{tree}`]).trim()];
  for (const row of listing(git, ['ls-tree', '-r', '-t', '-z', end]).split('\0')) {
    const [, mode, type, oid] = TREE_ROW.exec(row) ?? [];
    if (row !== '' && oid === undefined) throw untrusted(`git ls-tree printed a row that is no tree entry for ${end}`);
    if (type === 'tree' || (type === 'blob' && withBlobs && mode !== GITLINK_MODE)) oids.push(oid);
  }
  return oids;
}

/** The blob oids on either side of every path that differs between two commits. */
function differingBlobs(git, a, b) {
  const oids = [];
  // -z: each entry is its row, then its path; without renames there is exactly one path per row.
  const fields = listing(git, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', a, b]).split('\0');
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, oldMode, newMode, oldOid, newOid] = RAW_ROW.exec(fields[at]) ?? [];
    if (oldOid === undefined) throw untrusted(`git diff-tree printed a row that is no change between ${a} and ${b}`);
    if (oldMode !== GITLINK_MODE && !NO_OBJECT.test(oldOid)) oids.push(oldOid);
    if (newMode !== GITLINK_MODE && !NO_OBJECT.test(newOid)) oids.push(newOid);
  }
  return oids;
}

/**
 * Checks the trees and blobs the run reads: every tree of each endpoint, every blob of `head`, every blob that differs between two endpoints.
 * @param {object} git the trusted reader
 * @param {string[]} endpoints the commits whose trees are compared (base, reviewed, head), full shas already checked by verifyCommits
 * @param {string} head the endpoint that lands: all its blobs are checked, also the ones no diff shows
 * @throws {UsageError} naming the first object that is missing or does not hash to its name
 */
export function verifyTrees(git, endpoints, head) {
  const ends = [...new Set(endpoints)];
  const wanted = new Set(ends.flatMap((end) => treeOids(git, end, end === head)));
  ends.forEach((a, at) => ends.slice(at + 1).forEach((b) => differingBlobs(git, a, b).forEach((oid) => wanted.add(oid))));
  rehash(git, [...wanted]);
}
