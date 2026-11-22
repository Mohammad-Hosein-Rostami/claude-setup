// Tests for home/tools/land-lane/lib/union-rows.mjs and its step in land-lane: after the rebase, a file marked `merge=union` that holds a
// table row key twice stops the landing (exit 12, keys named), and a tip with a missing object stops it too (exit 14).
// Union merge keeps both sides' lines, so two lanes that each add the row `dup` rebase "cleanly" into two `dup` rows.
// Cases: the two-lane duplicate (CLI), a clean second row lands (CLI), a missing tip object (unit + CLI), CRLF against LF is one key (unit),
//   a hostile 10k-character key with pipes and backticks is capped (unit), an unreadable file fails closed (unit), only `merge=union` files
//   are checked (CLI: the same duplicate in a plain file lands). Fix round R1-R7: a base that moves after the checks is checked again (CLI,
//   a post-rewrite hook moves the base), a lane that drops the attribute is still checked (CLI), empty first cells are no key, the object
//   walk stops at the base, a partial clone's promisor objects are not missing, control characters in file names are blanked, indented
//   tables are read.
// The real git-tidy, disk-free and status tools run on throw-away repos with a private HOME (tests/land-lane-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commit, git, makeRepo, snapshot } from './git-tidy-helpers.mjs';
import { landArgs, makeWorld, readRow } from './land-lane-helpers.mjs';
import { Stop } from '../home/tools/land-lane/lib/stop.mjs';
import { EXIT_DUPLICATE_ROWS, changedUnionFiles, checkTipRows, unionDuplicateKeys, verifyTipObjects } from '../home/tools/land-lane/lib/union-rows.mjs';

const TABLE_HEAD = '| Tool | Note |\n| ---- | ---- |\n';
const UNION_RULES = 'docs/catalog.md merge=union\n';
const KEY_CAP = 60;
const ESCAPE = '\u001b';

/** Deletes the loose object `sha` of the repo in `dir` (a commit made by the tests is always loose). */
const removeObject = (dir, sha) => rmSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
/** The rows of `file` on main whose first cell is `dup`. */
const dupRowsOnMain = (dir, file = 'docs/catalog.md') => git(dir, 'show', `main:${file}`).split('\n').filter((line) => line.startsWith('| dup ')).length;

/** A repo whose main holds `.gitattributes` (one union file) and `file` with a table of one row `first`. */
function worldWithCatalog(rules = UNION_RULES, file = 'docs/catalog.md') {
  const world = makeWorld();
  commit(world.dir, '.gitattributes', rules);
  mkdirSync(dirname(join(world.dir, file)), { recursive: true });
  commit(world.dir, file, `${TABLE_HEAD}| first | 1 |\n`);
  return world;
}

/** Main and a lane each append a row; returns the lane tip. The rows are `<laneRow>` on the lane and `<mainRow>` on main. */
function twoAppends(world, file, laneRow, mainRow) {
  const base = `${TABLE_HEAD}| first | 1 |\n`;
  git(world.dir, 'checkout', '-q', '-b', 'lane/rows');
  const tip = commit(world.dir, file, `${base}${laneRow}\n`);
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, file, `${base}${mainRow}\n`);
  return tip;
}

test('two lanes that add the same row key: exit 12 after the rebase, the key is named, nothing lands, the row stays open', () => {
  const world = worldWithCatalog();
  const tip = twoAppends(world, 'docs/catalog.md', '| dup | from the lane |', '| dup | from main |');
  const main = git(world.dir, 'rev-parse', 'main');
  const result = world.run(landArgs(world, 'lane/rows', tip));
  assert.equal(result.status, EXIT_DUPLICATE_ROWS, result.stdout + result.stderr);
  assert.equal(result.stdout.split('\n')[0], 'land: duplicate-rows');
  assert.match(result.stdout, /docs\/catalog\.md: duplicated row key "dup"/);
  assert.equal(git(world.dir, 'rev-parse', 'main'), main, 'the base did not move');
  assert.doesNotMatch(readRow(world), /landed/);
});

test('two lanes that add different row keys land: union keeps both rows and no key is twice', () => {
  const world = worldWithCatalog();
  const tip = twoAppends(world, 'docs/catalog.md', '| lane-row | 1 |', '| main-row | 2 |');
  const result = world.run(landArgs(world, 'lane/rows', tip));
  assert.match(result.stdout.split('\n')[0], /^land: landed/, result.stdout + result.stderr);
  assert.equal(git(world.dir, 'show', 'main:docs/catalog.md').split('\n').filter((line) => /^\| (lane|main)-row/.test(line)).length, 2);
});

test('a duplicated key in a file that is not merge=union is not this check\'s business: the lane lands', () => {
  const world = worldWithCatalog();
  git(world.dir, 'checkout', '-q', '-b', 'lane/rows');
  const tip = commit(world.dir, 'notes.md', `${TABLE_HEAD}| dup | a |\n| dup | b |\n`);
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'moved.txt');
  const result = world.run(landArgs(world, 'lane/rows', tip));
  assert.match(result.stdout.split('\n')[0], /^land: landed/, result.stdout + result.stderr);
});

test('verifyTipObjects: a complete tip is ok; a deleted blob is named; a sha that is no commit names itself', () => {
  const world = makeWorld();
  const tip = commit(world.dir, 'only-here.txt', 'content that exists once\n');
  assert.deepEqual(verifyTipObjects(world.dir, tip), { ok: true });
  const blob = git(world.dir, 'rev-parse', `${tip}:only-here.txt`);
  const objects = join(world.dir, '.git', 'objects');
  rmSync(join(objects, blob.slice(0, 2), blob.slice(2)));
  assert.deepEqual(verifyTipObjects(world.dir, tip), { ok: false, object: blob });
  const nothing = '0'.repeat(40);
  assert.deepEqual(verifyTipObjects(world.dir, nothing), { ok: false, object: nothing });
});

test('a tip whose blob is missing from the repository is never landed (exit 14), the base and the row stay as they were', () => {
  const world = makeWorld();
  git(world.dir, 'checkout', '-q', '-b', 'lane/broken');
  const tip = commit(world.dir, 'lost.txt', 'content of a lost object\n');
  git(world.dir, 'checkout', '-q', 'main');
  const blob = git(world.dir, 'rev-parse', `${tip}:lost.txt`);
  rmSync(join(world.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const before = snapshot(world.dir);
  const result = world.run(landArgs(world, 'lane/broken', tip));
  assert.equal(result.status, 14, result.stdout + result.stderr);
  assert.equal(snapshot(world.dir), before);
  assert.doesNotMatch(readRow(world), /landed/);
});

test('F2 CRLF: a row with a carriage return is the same key as one without', () => {
  const world = makeWorld();
  const tip = commit(world.dir, 'table.md', '| Tool | Note |\r\n| ---- | ---- |\r\n| dup | a |\r\n| dup | b |\n| dup |\r\n| solo | c |\r\n');
  const [found] = unionDuplicateKeys(world.dir, ['table.md'], tip);
  assert.deepEqual(found, { file: 'table.md', keys: ['dup'] });
});

test('F1 hostile keys: a 10k-character key with pipes-escaped text and backticks is capped, control characters are blanked', () => {
  const world = makeWorld();
  const hostile = `\`${'x'.repeat(10_000)}\\|y\`\u001b[31m`;
  const text = `${TABLE_HEAD}| ${hostile} | a |\n| ${hostile} | b |\n`;
  const tip = commit(world.dir, 'big.md', text);
  const [found] = unionDuplicateKeys(world.dir, ['big.md'], tip);
  assert.equal(found.keys.length, 1);
  assert.ok(found.keys[0].length <= KEY_CAP + 3, `capped, was ${found.keys[0].length}`);
  assert.doesNotMatch(found.keys[0], /\u001b/);
});

test('a header-only table and text outside tables hold no keys', () => {
  const world = makeWorld();
  const tip = commit(world.dir, 'plain.md', `text\n\n${TABLE_HEAD}\nmore text\n\n${TABLE_HEAD}| a | 1 |\n`);
  assert.deepEqual(unionDuplicateKeys(world.dir, ['plain.md'], tip), []);
});

test('P3 fail closed: a file that git cannot read at the tip is a Stop with exit 14, not an empty answer', () => {
  const world = makeWorld();
  const tip = commit(world.dir, 'there.md', '| a |\n');
  assert.throws(() => unionDuplicateKeys(world.dir, ['gone.md'], tip), (error) => error instanceof Stop && error.code === 14);
});

test('changedUnionFiles lists only changed merge=union files that still exist at the tip', () => {
  const world = worldWithCatalog(`${UNION_RULES}other.md merge=union\n`);
  const base = git(world.dir, 'rev-parse', 'HEAD');
  commit(world.dir, 'docs/catalog.md', `${TABLE_HEAD}| first | 1 |\n| second | 2 |\n`);
  const tip = commit(world.dir, 'plain.md', 'x\n');
  assert.deepEqual(changedUnionFiles(world.dir, base, tip), ['docs/catalog.md']);
});

test('R1 a base that moves after the checks: only the checked tip may land, so land-lane rebases, checks again and stops on the duplicate', () => {
  const world = worldWithCatalog();
  git(world.dir, 'checkout', '-q', '-b', 'lane/rows');
  const tip = commit(world.dir, 'docs/catalog.md', `${TABLE_HEAD}| first | 1 |\n| dup | from the lane |\n`);
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'moved.txt'); // so the rebase of step 4 rewrites the lane and git runs the post-rewrite hook
  const marker = join(world.home, 'base-moved-once').replaceAll('\\', '/');
  const base = world.dir.replaceAll('\\', '/');
  // The hook runs after land-lane's own rebase, before its checks: main gains its own `dup` row once, as another lane landing would add it.
  const hook = `#!/bin/sh\n[ -f "${marker}" ] && exit 0\n: > "${marker}"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n`
    + `cd "${base}" && printf '| dup | from main |\\n' >> docs/catalog.md && git commit -q -am 'main adds dup'\n`;
  writeFileSync(join(world.dir, '.git', 'hooks', 'post-rewrite'), hook, { mode: 0o755 });
  const result = world.run(landArgs(world, 'lane/rows', tip));
  assert.ok(existsSync(marker), 'the base moved after the first rebase');
  assert.equal(result.status, EXIT_DUPLICATE_ROWS, result.stdout + result.stderr);
  assert.match(result.stdout, /docs\/catalog\.md: duplicated row key "dup"/);
  assert.equal(dupRowsOnMain(world.dir), 1, 'main holds only its own dup row: the unchecked rebased tip never landed');
  assert.doesNotMatch(readRow(world), /landed/);
});

test('R2 a lane that drops merge=union from .gitattributes is still checked: the base\'s attributes count too (exit 12)', () => {
  const world = worldWithCatalog();
  git(world.dir, 'checkout', '-q', '-b', 'lane/rows');
  commit(world.dir, 'docs/catalog.md', `${TABLE_HEAD}| first | 1 |\n| dup | from the lane |\n`);
  const tip = commit(world.dir, '.gitattributes', '');
  git(world.dir, 'checkout', '-q', 'main');
  commit(world.dir, 'docs/catalog.md', `${TABLE_HEAD}| first | 1 |\n| dup | from main |\n`);
  const main = git(world.dir, 'rev-parse', 'main');
  const result = world.run(landArgs(world, 'lane/rows', tip));
  assert.equal(result.status, EXIT_DUPLICATE_ROWS, result.stdout + result.stderr);
  assert.equal(git(world.dir, 'rev-parse', 'main'), main, 'the base did not move');
});

test('R3 rows whose first cell is empty (continuation rows) are no key and never a duplicate', () => {
  const dir = makeRepo();
  const tip = commit(dir, 't.md', '| Name | Notes |\n| --- | --- |\n| a | first |\n|  | continued |\n|  | more |\n| | again |\n');
  assert.deepEqual(unionDuplicateKeys(dir, ['t.md'], tip), []);
});

test('R4 verifyTipObjects walks only what the lane adds over the base: a hole in the base history is not the lane\'s, a hole in the lane is', () => {
  const dir = makeRepo();
  const old = commit(dir, 'old.txt', 'only in the base history\n');
  commit(dir, 'old.txt', 'replaced\n');
  git(dir, 'checkout', '-q', '-b', 'lane/x');
  const tip = commit(dir, 'new.txt', 'what the lane adds\n');
  removeObject(dir, git(dir, 'rev-parse', `${old}:old.txt`));
  assert.deepEqual(verifyTipObjects(dir, tip, 'refs/heads/main'), { ok: true });
  assert.equal(verifyTipObjects(dir, tip).ok, false, 'with no base the whole history is walked and the hole is seen');
  const added = git(dir, 'rev-parse', `${tip}:new.txt`);
  removeObject(dir, added);
  assert.deepEqual(verifyTipObjects(dir, tip, 'refs/heads/main'), { ok: false, object: added });
});

test('R5 a blobless partial clone: the blobs its promisor remote holds are not missing objects', () => {
  const source = makeRepo();
  commit(source, 'a.txt');
  commit(source, 'b.txt');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  const clone = join(source, '..', 'partial');
  git(join(source, '..'), 'clone', '-q', '--no-checkout', '--filter=blob:none', pathToFileURL(source).href, clone);
  const objects = git(clone, 'rev-list', '--objects', '--missing=print', 'HEAD', '--').split('\n');
  assert.ok(objects.some((line) => line.startsWith('?')), 'the clone lacks the blobs (it is partial)');
  assert.deepEqual(verifyTipObjects(clone, git(clone, 'rev-parse', 'HEAD')), { ok: true });
});

test('R6 control characters in a file name are blanked in what a stop prints (exit 12 and exit 14)', () => {
  const dir = makeRepo();
  commit(dir, '.gitattributes', '*.md merge=union\n');
  writeFileSync(join(dir, 'rows.txt'), `${TABLE_HEAD}| dup | a |\n| dup | b |\n`);
  const blob = git(dir, 'hash-object', '-w', 'rows.txt');
  // The name exists only in git's tree (built with plumbing), so the test needs no file system that allows it.
  git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},x${ESCAPE}[31m.md`);
  const tip = git(dir, 'commit-tree', git(dir, 'write-tree'), '-p', 'main', '-m', 'hostile name');
  git(dir, 'read-tree', 'HEAD');
  const cleanStop = (code) => (error) => error instanceof Stop && error.code === code && !error.lines.join('\n').includes(ESCAPE);
  assert.throws(() => checkTipRows({ repo: dir, base: 'main' }, tip), cleanStop(EXIT_DUPLICATE_ROWS));
  assert.throws(() => unionDuplicateKeys(dir, [`gone${ESCAPE}[31m.md`], tip), cleanStop(14));
});

test('R7 a table indented inside a list is read like any other', () => {
  const dir = makeRepo();
  const tip = commit(dir, 'list.md', '- item\n\n  | Tool | Note |\n  | --- | --- |\n  | dup | a |\n  | dup | b |\n');
  assert.deepEqual(unionDuplicateKeys(dir, ['list.md'], tip), [{ file: 'list.md', keys: ['dup'] }]);
});
