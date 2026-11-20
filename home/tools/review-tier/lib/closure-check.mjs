// Purpose: prove, inside review-tier's own repository, that every object a read of the run needs was imported, before anything is read.
// Exports: checkCommitClosure(git, endpoints), checkSnapshotClosure(git, plan).
// Why: a missing object does not always make git fail. `git grep` skips a blob it cannot read (a message on stderr, exit 0, the other
//   matches still listed), attributes read through `--attr-source` are silently empty when their `.gitattributes` blob is missing, and
//   git before 2.45 can answer a merge base over a missing commit (spec check K1 of lane r7-delta, fix round 5). So "an object that was
//   not imported makes git fail" is not enough: the import's lists (lib/lane-import.mjs) are made on the lane's side from unchecked
//   objects, and this check lists the same needs again from the imported, verified objects, with no access to the lane's store.
// What is checked: (1) no commit reachable from the run's endpoints is missing; (2) every tree of every commit that is compared can be
//   listed; (3) every file of the tip, both sides of every changed path of every pair that is diffed, and every `.gitattributes` of the
//   attribute source exist as blobs.
// Invariants: reads only through the trusted reader (no alternate); the lists are made here, not taken from the import; any failure is
//   a UsageError (exit 2) naming the object.
import { attributeBlobs, changedBlobs, fileBlobs, listed, treeEntries, untrusted } from './object-listing.mjs';

const MISSING_MARK = '?'; // `rev-list --missing=print` prints a missing object as `?<oid>`

const notImported = (oid) => untrusted(`object ${oid} is needed and was not imported`);

/**
 * Checks that every commit reachable from `endpoints` is in the tool's repository. Run it before anything walks parents.
 * @param {object} git the trusted reader
 * @param {string[]} endpoints full shas of the commits the run names
 * @throws {UsageError} naming the first missing commit
 */
export function checkCommitClosure(git, endpoints) {
  const rows = listed(git.run, ['rev-list', '--missing=print', ...new Set(endpoints)]).split('\n');
  const missing = rows.find((row) => row.startsWith(MISSING_MARK));
  if (missing !== undefined) throw notImported(missing.slice(MISSING_MARK.length));
}

/** Throws unless every oid of `oids` is a blob in the tool's repository. */
function checkBlobs(git, oids) {
  if (oids.length === 0) return;
  const rows = listed(git.run, ['cat-file', '--batch-check'], `${oids.join('\n')}\n`).split('\n').filter(Boolean);
  if (rows.length !== oids.length) throw untrusted(`git listed ${rows.length} of ${oids.length} objects`);
  rows.forEach((row, at) => {
    const [oid, type] = row.split(' ');
    if (oid !== oids[at] || type === 'missing') throw notImported(oids[at]);
    if (type !== 'blob') throw untrusted(`object ${oid} is a ${type}, but a tree names it as a file`);
  });
}

/** The entries of every tree of `commit`. A full recursive listing reads each tree: a missing one, or a file where a folder is named, makes it fail. */
function everyEntryOf(git, commit) {
  const { status, stdout, stderr } = git.run(['ls-tree', '-r', '-t', '-z', commit]);
  if (status !== 0) throw untrusted(`a tree of commit ${commit} is needed and was not imported (git ls-tree: ${stderr.split('\n')[0]})`);
  return treeEntries(stdout.toString('latin1'), commit);
}

/**
 * Checks that everything the run's diffs, greps, file reads and attribute lookups need is in the tool's repository.
 * @param {object} git the trusted reader
 * @param {{endpoints: string[], tip: string, treeCommits: string[], pairs: string[][], attributeSource: string}} plan what the run
 *   reads: the commits it names, the commit whose every file is read, the commits whose every tree is read, the pairs it diffs, and the
 *   commit attributes are read from (full shas)
 * @throws {UsageError} naming the first object that is missing or of the wrong type
 */
export function checkSnapshotClosure(git, { endpoints, tip, treeCommits, pairs, attributeSource }) {
  checkCommitClosure(git, endpoints);
  const entriesOf = new Map([...new Set([...treeCommits, tip, attributeSource])].map((commit) => [commit, everyEntryOf(git, commit)]));
  const blobs = new Set([...fileBlobs(entriesOf.get(tip)), ...attributeBlobs(entriesOf.get(attributeSource))]);
  for (const [from, to] of pairs) {
    for (const oid of changedBlobs(listed(git.run, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', from, to]), `${from} and ${to}`)) blobs.add(oid);
  }
  checkBlobs(git, [...blobs]);
}
