// Tests that review-tier's import takes an object only as the type its parent names (lane r7-delta, fix round 5, spec check K3): a tree
// entry that names a tree or a commit as a file, one that names a file or a commit as a folder, and a commit whose `tree` line names a
// file. Every such object hashes to its name, so the hash check passes; the type is what stops it. Each is exit 2, never a review.
// The objects are written with `git hash-object -t <type>`, which checks an object's own format but not what its entries point at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const PLAIN = 'export function run(x) {\n  return x;\n}\n';
const FILE_MODE = '100644';
const FOLDER_MODE = '40000';

/** Writes an object of `type` with exactly these bytes into the repository and returns its name. */
function storedAs(dir, type, bytes) {
  const stored = spawnSync('git', ['hash-object', '-t', type, '-w', '--stdin'], { cwd: dir, input: bytes, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(stored.status, 0, stored.stderr);
  return stored.stdout.trim();
}
const treeOf = (dir, entries) => storedAs(dir, 'tree', Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]))));
const commitOf = (dir, tree, parent) => storedAs(dir, 'commit', `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1 +0000\ncommitter t <t@t> 1 +0000\n\nfix: an odd object\n`);

/**
 * A lane with one honest commit (`reviewed`) and, on top, a commit made by `odd(names)`: `names` holds the oids an odd tree can point at.
 * @returns {{rounds: Function[], names: Object<string, string>}} `rounds`: the first review and the fix round, each returning the CLI result
 */
function oddLane(odd) {
  const { dir, raw, tier, write } = lane();
  const start = git(dir, 'rev-parse', 'main');
  const reviewed = write('src/p.mjs', PLAIN);
  const oid = (name) => git(dir, 'rev-parse', name);
  const names = { reviewed, start, baseFile: oid('HEAD:base.txt'), sourceFolder: oid('HEAD:src'), rootFolder: oid('HEAD^{tree}') };
  names.spareFolder = treeOf(dir, [[FILE_MODE, 'only.txt', names.baseFile]]); // a tree no commit of the lane uses as a folder
  git(dir, 'update-ref', 'refs/heads/lane', odd(dir, names));
  const prior = priorFile();
  return { names, rounds: [() => raw('main...HEAD', '--json'), () => tier('--delta', reviewed, '--base', start, '--prior', prior, '--lane-classes', 'logic', '--json')] };
}
/** A commit on the reviewed one whose root holds base.txt, `<mode> odd -> oid` and src/. */
const withEntry = (mode, pick) => (dir, names) => commitOf(dir, treeOf(dir, [[FILE_MODE, 'base.txt', names.baseFile], [mode, 'odd', pick(names)], [FOLDER_MODE, 'src', names.sourceFolder]]), names.reviewed);

function assertRefused(odd, said, name) {
  const { names, rounds } = oddLane(odd);
  for (const run of rounds) {
    const result = run();
    assert.equal(result.status, 2, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /the objects of this repository cannot be trusted: .*Nothing was read from them/, name);
    assert.ok(result.stderr.includes(said(names)), `${name}: ${result.stderr}`);
  }
}

test('the control: the same lane with an honest extra file is read (exit 0, two files)', () => {
  const { rounds } = oddLane(withEntry(FILE_MODE, ({ baseFile }) => baseFile));
  const first = rounds[0]();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).files, 2);
  assert.equal(rounds[1]().status, 0);
});

test('spec check K3: a tree entry that names a tree, or a commit, as a file is exit 2 naming the object and both types', () => {
  assertRefused(withEntry(FILE_MODE, ({ spareFolder }) => spareFolder), ({ spareFolder }) => `object ${spareFolder} is a tree, but what names it takes it for a blob`, 'a tree as a file');
  assertRefused(withEntry(FILE_MODE, ({ start }) => start), ({ start }) => `object ${start} is a commit, but what names it takes it for a blob`, 'a commit as a file');
});

test('spec check K3: a tree entry that names a file, or a commit, as a folder is exit 2: the lane\'s trees cannot be listed', () => {
  assertRefused(withEntry(FOLDER_MODE, ({ baseFile }) => baseFile), () => 'git ls-tree failed', 'a file as a folder');
  assertRefused(withEntry(FOLDER_MODE, ({ start }) => start), () => 'git ls-tree failed', 'a commit as a folder');
});

test('spec check K3: a commit whose tree line names a file is exit 2 naming the object and both types', () => {
  assertRefused((dir, names) => commitOf(dir, names.baseFile, names.reviewed), ({ baseFile }) => `object ${baseFile} is a blob, but what names it takes it for a tree`, 'a file as the root tree');
});
