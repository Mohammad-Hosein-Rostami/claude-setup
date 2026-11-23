// Tests of scripts/share-check.mjs (lane share-scrub, spec layering §4): hits print `<file>:<line>: <word>` and never the line or the
// list; a missing list is "not run" (exit 0); an unreadable list or a git failure is exit 2; binary and over-2-MiB files are listed as
// skipped; --staged reads index blobs; --history counts commits per word; CRLF lists, `#` comments, literal and word-bounded matching.
// Every repo is a throw-away one in the temp folder (tests/git-tidy-helpers.mjs); the deny words here are made-up, neutral ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_MAX_BYTES, findHits, parseDenyList, wordPattern } from '../scripts/share-check.mjs';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/share-check.mjs', import.meta.url));
const WORD = 'zebracorp';
const LINE_TEXT = 'the quiet harbour line'; // text beside a hit that must never be printed

const check = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: CLEAN_ENV });

/** A repo with the main checkout's personal/share-deny.txt holding `list` (untracked, as the git-ignored real one). */
function repoWithList(list = `${WORD}\nQuokka Ltd\n`) {
  const dir = makeRepo();
  mkdirSync(join(dir, 'personal'));
  writeFileSync(join(dir, 'personal', 'share-deny.txt'), list);
  return dir;
}

/** A list file outside any repo. */
function listFile(text) {
  const path = join(makeTempDir('share-list-'), 'deny.txt');
  writeFileSync(path, text);
  return path;
}

test('a hit exits 1 with file:line: word, and prints neither the line nor the rest of the list', () => {
  const dir = repoWithList();
  commit(dir, 'notes.md', `first\n${LINE_TEXT} ${WORD.toUpperCase()} here\n`);
  const result = check(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^notes\.md:2: zebracorp$/m);
  assert.match(result.stdout, /^share-check: 1 hits in 1 files \(2 files checked, 0 skipped, 2 words\)/m);
  assert.doesNotMatch(result.stdout + result.stderr, /quiet harbour|Quokka/);
});

test('no list: not run, exit 0; an empty or comment-only list: not run too', () => {
  const dir = makeRepo();
  commit(dir, 'notes.md', `${WORD}\n`);
  const missing = check(dir);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, `share-check: not run (no deny list at ${join(dir, 'personal', 'share-deny.txt')})\n`);
  const empty = check(dir, '--deny', listFile('# only a comment\r\n\r\n'));
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /^share-check: not run \(no words in .*deny\.txt\)$/m);
});

test('a lane worktree without personal/ finds the main checkout list through git', () => {
  const dir = repoWithList();
  commit(dir, 'notes.md', `${WORD}\n`);
  const lane = addWorktree(dir, 'lane', 'lane/x');
  const result = check(lane);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^notes\.md:1: zebracorp$/m);
});

test('an unreadable or missing named list and a git failure exit 2 with why, never 0', () => {
  const dir = repoWithList();
  const missing = check(dir, '--deny', join(dir, 'nope.txt'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^share-check: error: deny list .*nope\.txt not readable \(ENOENT\)$/m);
  const folder = check(dir, '--deny', join(dir, 'personal'));
  assert.equal(folder.status, 2);
  assert.match(folder.stderr, /not readable/);
  const outside = check(makeTempDir('share-norepo-'));
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /^share-check: error: git rev-parse exited/m);
  const unknown = check(dir, '--everything');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^share-check: error: /m);
});

test('a binary file and one over 2 MiB are listed as skipped, not read and not counted clean silently', () => {
  const dir = repoWithList();
  writeFileSync(join(dir, 'logo.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(WORD)]));
  writeFileSync(join(dir, 'big.txt'), `${WORD}\n${'x'.repeat(FILE_MAX_BYTES)}`);
  git(dir, 'add', 'logo.bin', 'big.txt');
  git(dir, 'commit', '-q', '-m', 'add files');
  const result = check(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^share-check: skipped big\.txt \(over 2 MiB\)$/m);
  assert.match(result.stdout, /^share-check: skipped logo\.bin \(binary\)$/m);
  assert.match(result.stdout, /^share-check: clean \(1 files checked, 2 skipped, 2 words\)$/m);
  const staged = check(dir, '--staged');
  assert.match(staged.stdout, /^share-check: clean \(0 staged files: nothing added or changed in the index\)$/m);
});

test('--staged reads the index blobs, not the working tree, and names with spaces and unicode', () => {
  const dir = repoWithList();
  const name = 'two words ü.md';
  writeFileSync(join(dir, name), `ok\n${WORD}\n`);
  git(dir, 'add', '--', name);
  writeFileSync(join(dir, name), 'ok\nclean now\n');
  const staged = check(dir, '--staged');
  assert.equal(staged.status, 1, staged.stdout + staged.stderr);
  assert.match(staged.stdout, new RegExp(`^${name}:2: zebracorp$`, 'm'));
  assert.equal(check(dir).status, 0, 'the working tree copy is clean');
  git(dir, 'add', '--', name);
  writeFileSync(join(dir, 'other.md'), `${WORD}\n`);
  assert.equal(check(dir, '--staged').status, 0, 'an untracked file is not in the commit');
});

test('--history prints the commits per word, from messages and from changes', () => {
  const dir = repoWithList();
  const named = commit(dir, 'a.md', 'plain\n', `docs: mention ${WORD}`);
  const added = commit(dir, 'b.md', `${WORD}\n`, 'add b');
  const removed = commit(dir, 'b.md', 'gone\n', 'clean b');
  const result = check(dir, '--history');
  assert.equal(result.status, 1, result.stderr);
  const line = result.stdout.split('\n').find((text) => text.startsWith(`share-check: history ${WORD}:`));
  assert.ok(line, result.stdout);
  assert.match(line, /: 3 commits \(messages 1, changes 2\): /);
  for (const sha of [named, added, removed]) assert.ok(line.includes(sha.slice(0, 12)), sha);
  assert.match(result.stdout, /^share-check: history: 1 words found \(4 commits, 2 words\)$/m);
  assert.equal(check(dir, '--history', '--deny', listFile('nothinglikeit\n')).status, 0);
  assert.equal(check(dir, '--history', '--staged').status, 2);
});

test('CRLF list, # comments, literal regex characters and word bounds: ice never hits service', () => {
  const dir = makeRepo();
  commit(dir, 'a.md', 'customer service\nslice of nice\naxb\nskipped\nan ice-cream\n');
  commit(dir, 'b.md', 'pure c++ code\nicepath\nsnake_ice_case\n');
  const list = listFile('﻿# skipped\r\nice\r\na.b\r\nc++\r\n\r\n');
  const result = check(dir, '--deny', list);
  assert.equal(result.status, 1);
  const hits = result.stdout.split('\n').filter((text) => !text.startsWith('share-check:') && text !== '');
  assert.deepEqual(hits, ['a.md:5: ice', 'b.md:1: c++', 'b.md:3: ice']);
  assert.equal(check(dir, '--deny', listFile('ice\n'), 'base.txt').status, 0, 'a path limits the check');
});

test('a tracked symlink is checked by its target, and a repo with no tracked file is clean with 0 files', () => {
  const dir = repoWithList();
  symlinkSync(`/somewhere/${WORD}/x`, join(dir, 'link'));
  git(dir, 'add', 'link');
  git(dir, 'commit', '-q', '-m', 'link');
  assert.match(check(dir).stdout, /^link:1: zebracorp$/m);
  const empty = join(realpathSync(makeTempDir('share-empty-')), 'repo');
  git(join(empty, '..'), 'init', '-q', empty);
  const result = check(empty, '--deny', listFile(`${WORD}\n`));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'share-check: clean (0 files: nothing tracked)\n');
});

test('parseDenyList and findHits: one entry per word, case-insensitive, once per line', () => {
  assert.deepEqual(parseDenyList('Zebracorp\r\n  zebracorp  \n# note\nQuokka Ltd\n'), ['Zebracorp', 'Quokka Ltd']);
  const denied = ['Zebracorp', 'Quokka Ltd'].map((word) => ({ word, pattern: wordPattern(word) }));
  assert.deepEqual(findHits('zebracorp and ZEBRACORP\nquokka ltd\nzebracorps\n', denied), [
    { line: 1, word: 'Zebracorp' }, { line: 2, word: 'Quokka Ltd' },
  ]);
});
