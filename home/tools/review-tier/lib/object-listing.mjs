// Purpose: read git's object listings for review-tier (`ls-tree -z`, `diff-tree -z --raw`, `cat-file --batch-check`) and hold the one
//   error every refusal of the lane's objects uses.
// Exports: GITLINK_MODE, ATTRIBUTES_FILE, untrusted(what), listed(run, args, input), treeEntries(text, of), changedBlobs(text, between),
//   attributeBlobs(entries), fileBlobs(entries).
// Used twice, on purpose with different readers: the import lists what to copy by asking the lane's side (lib/lane-import.mjs), the
//   closure check lists what must be there by asking the tool's own repository (lib/closure-check.mjs). Only these row parsers are shared.
// Invariants: listings are read as text with one byte per character (latin1), so a path is its bytes; a row that is no row of the
//   command is a UsageError (exit 2), never skipped. A submodule pointer (mode 160000) names a commit of another repository: it is no
//   object of this one and is never listed as one.
import { UsageError } from '../../git-tidy/lib/git.mjs';

export const GITLINK_MODE = '160000';
/** The file git reads attributes from, at any depth of a tree. */
export const ATTRIBUTES_FILE = '.gitattributes';
const NO_OBJECT = /^0+$/;
const TREE_ROW = /^(\d+) (\w+) ([0-9a-f]{40})\t([^]*)$/;
const RAW_ROW = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) /;

/**
 * The error of a lane whose objects cannot be relied on (exit 2).
 * @param {string} what what was found, with the object's name
 */
export const untrusted = (what) => new UsageError(`the objects of this repository cannot be trusted: ${what}. Nothing was read from them: restore the repository (a fresh clone), or review by hand`);

/**
 * The output of one listing command as latin1 text.
 * @param {Function} run `run(args, { input })` of a git reader, giving `{ status, stdout, stderr }`
 * @throws {UsageError} when git exits non-zero: a listing that cannot be made is never an empty one
 */
export function listed(run, args, input = undefined) {
  const { status, stdout, stderr } = run(args, { input });
  if (status !== 0) throw untrusted(`git ${args[0]} failed (${stderr.split('\n')[0]})`);
  return stdout.toString('latin1');
}

/**
 * The entries of an `ls-tree -z` listing.
 * @param {string} text the listing (latin1)
 * @param {string} of the commit it lists, for the error
 * @returns {{mode: string, type: string, oid: string, path: string}[]}
 */
export function treeEntries(text, of) {
  return text.split('\0').filter((row) => row !== '').map((row) => {
    const [, mode, type, oid, path] = TREE_ROW.exec(row) ?? [];
    if (oid === undefined) throw untrusted(`git ls-tree printed a row that is no tree entry for ${of}`);
    return { mode, type, oid, path };
  });
}

/** The oids of the files among tree entries. `ls-tree` calls a file and a symlink `blob`, a folder `tree` and a submodule pointer `commit`. */
export const fileBlobs = (entries) => entries.filter(({ type }) => type === 'blob').map(({ oid }) => oid);

/** The oids of every `.gitattributes` entry among tree entries, at any depth, as a file or as a symlink. */
export const attributeBlobs = (entries) => fileBlobs(entries.filter(({ path }) => path.slice(path.lastIndexOf('/') + 1) === ATTRIBUTES_FILE));

/**
 * The blob oids on either side of every path of a `diff-tree -r -z --raw --no-renames --no-abbrev` listing.
 * @param {string} text the listing (latin1): each entry is its row, then its path
 * @param {string} between the two commits, for the error
 */
export function changedBlobs(text, between) {
  const oids = [];
  const fields = text.split('\0');
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, oldMode, newMode, oldOid, newOid] = RAW_ROW.exec(fields[at]) ?? [];
    if (oldOid === undefined) throw untrusted(`git diff-tree printed a row that is no change between ${between}`);
    if (oldMode !== GITLINK_MODE && !NO_OBJECT.test(oldOid)) oids.push(oldOid);
    if (newMode !== GITLINK_MODE && !NO_OBJECT.test(newOid)) oids.push(newOid);
  }
  return oids;
}
