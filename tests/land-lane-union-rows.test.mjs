// Tests for home/tools/land-lane/lib/union-rows.mjs and its step in land-lane: after the rebase, a file marked `merge=union` that holds a
// table row key twice stops the landing (exit 12, keys named), and a tip with a missing object stops it too (exit 14).
// Union merge keeps both sides' lines, so two lanes that each add the row `dup` rebase "cleanly" into two `dup` rows.
// Cases: the two-lane duplicate (CLI), a clean second row lands (CLI), a missing tip object (unit + CLI), CRLF against LF is one key (unit),
//   a hostile 10k-character key with pipes and backticks is capped (unit), an unreadable file fails closed (unit), only `merge=union` files
//   are checked (CLI: the same duplicate in a plain file lands).
// The real git-tidy, disk-free and status tools run on throw-away repos with a private HOME (tests/land-lane-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commit, git, snapshot } from './git-tidy-helpers.mjs';
import { landArgs, makeWorld, readRow } from './land-lane-helpers.mjs';
import { Stop } from '../home/tools/land-lane/lib/stop.mjs';
import { EXIT_DUPLICATE_ROWS, changedUnionFiles, unionDuplicateKeys, verifyTipObjects } from '../home/tools/land-lane/lib/union-rows.mjs';

const TABLE_HEAD = '| Tool | Note |\n| ---- | ---- |\n';
const UNION_RULES = 'docs/catalog.md merge=union\n';
const KEY_CAP = 60;

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
