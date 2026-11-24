// Tests of scripts/share-check.mjs against the ways a private word slipped through its first version (review findings of lane
// share-scrub): UTF-16 and NUL-prefixed bytes (R1), fullwidth and zero-width-split words (R2), a name split over lines or by a
// no-break space (R3), words in file and folder names (R4), camelCase joins (extra), and the commit message being made (R8,
// `--commit-msg` and .githooks/commit-msg). Each case runs the tree, --staged and --history where the finding named them.
// Every repo is a throw-away one in the temp folder (tests/git-tidy-helpers.mjs); the deny words here are made-up, neutral ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { sharedToolDir } from './shared-tools.mjs';

const CLI = fileURLToPath(new URL('../scripts/share-check.mjs', import.meta.url));
const COMMIT_MSG_HOOK = fileURLToPath(new URL('../.githooks/commit-msg', import.meta.url));
const WORD = 'zebracorp';
const PAIR = 'Quokka Ltd';

const check = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: CLEAN_ENV });
const hitLines = (result) => result.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('share-check:'));

/** A repo with the main checkout's personal/share-deny.txt holding the two neutral entries (untracked, as the real one). */
function repoWithList() {
  const dir = makeRepo();
  mkdirSync(join(dir, 'personal'));
  writeFileSync(join(dir, 'personal', 'share-deny.txt'), `${WORD}\n${PAIR}\n`);
  return dir;
}

/** Writes and stages `files` ({ name: content }); returns the repo. */
function staged(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
    git(dir, 'add', '--', name);
  }
  return dir;
}

const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const utf16be = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

test('R1: UTF-16 with either BOM, BOM-less UTF-16 and NUL-prefixed bytes are searched, not skipped', () => {
  const dir = staged(repoWithList(), {
    'le.txt': utf16le(`one\n${WORD}\n`),
    'be.txt': utf16be(`${WORD}\n`),
    'nobom.txt': Buffer.from(`x ${WORD} y`, 'utf16le'),
    'nul.bin': Buffer.concat([Buffer.from([0, 0, 7]), Buffer.from(`${WORD}`)]),
  });
  const expected = ['be.txt:1: zebracorp', 'le.txt:2: zebracorp', 'nobom.txt:1: zebracorp', 'nul.bin:1: zebracorp'];
  const index = check(dir, '--staged');
  assert.equal(index.status, 1, index.stdout + index.stderr);
  assert.deepEqual(hitLines(index), expected);
  git(dir, 'commit', '-q', '-m', 'add encoded files');
  assert.deepEqual(hitLines(check(dir)), expected);
  const history = check(dir, '--history');
  assert.match(history.stdout, /^share-check: history zebracorp: 1 commits \(messages 0, changes 1\)/m);
});

test('R2: a fullwidth word, a zero-width-split word and a soft-hyphen-split word hit; a fullwidth list entry too', () => {
  const dir = staged(repoWithList(), {
    'a.md': 'ｚｅｂｒａｃｏｒｐ\nzebra​corp\nzebra­corp\nzebra⁠corp\nzebra corp\n',
  });
  assert.deepEqual(hitLines(check(dir, '--staged')), ['a.md:1: zebracorp', 'a.md:2: zebracorp', 'a.md:3: zebracorp', 'a.md:4: zebracorp']);
  const list = join(makeTempDir('share-list-'), 'deny.txt');
  writeFileSync(list, 'ｚｅｂｒａｃｏｒｐ\n');
  assert.equal(check(dir, '--staged', '--deny', list).status, 1, 'a list entry is folded like the text');
  const message = commit(dir, 'b.md', 'plain\n', 'docs: about Ｚｅｂｒａ​ｃｏｒｐ');
  assert.match(check(dir, '--history').stdout, new RegExp(`^share-check: history zebracorp: .*messages 1.*${message.slice(0, 12)}`, 'm'));
});

test('R3: a two-word entry split over two lines, by a no-break space or a double space hits at its first line', () => {
  const dir = staged(repoWithList(), { 'a.md': 'intro\nQuokka\nLtd\nquokka ltd\nQUOKKA  LTD\nQuokka\t\r\n  Ltd\nquokka-ltd\n' });
  assert.deepEqual(hitLines(check(dir, '--staged')), ['a.md:2: Quokka Ltd', 'a.md:4: Quokka Ltd', 'a.md:5: Quokka Ltd', 'a.md:6: Quokka Ltd']);
  git(dir, 'commit', '-q', '-m', 'the pair\nQuokka\nLtd');
  assert.match(check(dir, '--history').stdout, /^share-check: history Quokka Ltd: 1 commits \(messages 1, changes 1\)/m);
});

test('R4: a deny word in a file or folder name hits in the tree, the index and the history, with a clean content', () => {
  const dir = staged(repoWithList(), { [`${WORD}-notes.md`]: 'clean\n', [`docs/${WORD}/readme.md`]: 'clean\n' });
  const expected = [`docs/${WORD}/readme.md:name: ${WORD}`, `${WORD}-notes.md:name: ${WORD}`];
  const index = check(dir, '--staged');
  assert.equal(index.status, 1, index.stdout);
  assert.deepEqual(hitLines(index), expected);
  const added = commit(dir, 'other.md', 'clean\n', 'add other');
  assert.deepEqual(hitLines(check(dir)), expected);
  git(dir, 'rm', '-q', '-r', '--', `${WORD}-notes.md`, 'docs');
  git(dir, 'commit', '-q', '-m', 'remove them');
  assert.equal(check(dir).status, 0, 'the tree is clean once the files are gone');
  const history = check(dir, '--history');
  assert.match(history.stdout, /^share-check: history zebracorp: 2 commits \(messages 0, changes 2\)/m);
  assert.ok(history.stdout.includes(added.slice(0, 12)), 'the commit that added the named files counts');
});

test('extra: a camelCase, acronym or digit join holds the word; a longer word or a lower-case join does not', () => {
  const dir = staged(repoWithList(), {
    'a.ts': 'const ZebracorpFrontend = 1;\nconst myZebracorp = 2;\nZEBRACORPService\nzebracorp2\nQuokkaLtd\n',
    'b.ts': 'zebracorps\nmyzebracorp\nZebracorpish\nquokkaltd\n',
  });
  assert.deepEqual(hitLines(check(dir, '--staged')), [
    'a.ts:1: zebracorp', 'a.ts:2: zebracorp', 'a.ts:3: zebracorp', 'a.ts:4: zebracorp', 'a.ts:5: Quokka Ltd',
  ]);
});

test('R8: --commit-msg checks the message as git commits it, without comments or the part below the scissors', () => {
  const dir = repoWithList();
  const folder = makeTempDir('share-msg-');
  const message = (name, text) => {
    writeFileSync(join(folder, name), text);
    return join(folder, name);
  };
  const hit = check(dir, '--commit-msg', message('hit', `docs: plain subject\n\nabout ${WORD.toUpperCase()} here\n`));
  assert.equal(hit.status, 1, hit.stdout + hit.stderr);
  assert.deepEqual(hitLines(hit), ['commit message:3: zebracorp']);
  assert.doesNotMatch(hit.stdout, /plain subject|about/);
  const commented = `docs: plain\n# ${WORD} in a comment line\n# ------------------------ >8 ------------------------\n+${WORD}\n`;
  const clean = check(dir, '--commit-msg', message('clean', commented));
  assert.equal(clean.status, 0, clean.stdout);
  assert.match(clean.stdout, /^share-check: commit message clean \(2 words\)$/m);
  assert.equal(check(dir, '--commit-msg', join(folder, 'missing')).status, 2, 'a missing message file fails closed');
  assert.equal(check(dir, '--commit-msg', message('x', 'x\n'), '--staged').status, 2, 'one check at a time');
  assert.equal(check(dir, '--commit-msg', message('y', 'y\n'), 'a.md').status, 2, 'no path with --commit-msg');
});

test('R8: the commit-msg hook refuses a commit whose message holds a deny word and lets a clean one through', () => {
  const dir = repoWithList();
  const wrapper = `#!/usr/bin/env bash\nexec bash ${JSON.stringify(COMMIT_MSG_HOOK)} "$@"\n`;
  // POSIX: one shared hooks folder (shared-tools.mjs: no first-run check per run); git only reads it
  let hooks;
  if (process.platform === 'win32') {
    hooks = makeTempDir('share-hooks-');
    writeFileSync(join(hooks, 'commit-msg'), wrapper, { mode: 0o755 });
  } else hooks = sharedToolDir({ 'commit-msg': wrapper });
  git(dir, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(dir, 'a.md'), 'clean\n');
  git(dir, 'add', 'a.md');
  const refused = spawnSync('git', ['commit', '-q', '-m', `docs: name ${WORD}`], { cwd: dir, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /^commit message:1: zebracorp$/m); // git sends a hook's output to stderr
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'add base.txt', 'no commit was made');
  git(dir, 'commit', '-q', '-m', 'docs: a clean subject');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'docs: a clean subject');
});
