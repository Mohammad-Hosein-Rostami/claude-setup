// Tests for .githooks/pre-commit, run through real `git commit` in throw-away repos. The hook is the safety floor only: gitleaks on
// the staged changes, the person's private words in the staged files (scripts/share-check.mjs --staged) and `node --check` on each
// staged hook file under home/hooks/. It runs no test.
// Two kinds of repo: one holding a copy of .githooks without scripts/ beside it (share-check says "not run"), and one whose hooks
// folder holds only a pre-commit that runs this repo's own .githooks/pre-commit, so the hook finds the real share-check script and
// the repo's own deny list (personal/share-deny.txt, untracked), and commit-msg (which refuses a bad list too) cannot stand in for
// it. gitleaks is a stub on PATH, except in the one test of the repo's .gitleaks.toml, which needs the real one; its made-up token
// is built at run time, so no file of this repo holds one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { sharedToolDir } from './shared-tools.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skip = process.platform === 'win32' && 'bash hooks';
const HAS_GITLEAKS = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const WORD = 'zebracorp'; // a made-up, neutral deny word
const { NODE_TEST_CONTEXT: _outerRunner, ...OUTSIDE_A_TEST_RUN } = CLEAN_ENV; // else a node child reports to this run

function write(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

/** A folder holding a gitleaks stub that exits with `exitCode`, to put first on PATH (shared: a new executable is slow to start). */
const stubGitleaks = (exitCode) => realpathSync(sharedToolDir({ gitleaks: `#!/bin/sh\nexit ${exitCode}\n` }));

/** A shared copy of this repo's .githooks folder (both hooks), with no scripts/ beside it. */
const hooksCopy = () =>
  realpathSync(sharedToolDir(Object.fromEntries(['pre-commit', 'commit-msg'].map((name) => [name, readFileSync(join(ROOT, '.githooks', name), 'utf8')]))));

/** A repo on branch feat with the hook installed (core.hooksPath), two hook files and a test file that fails if it ever runs. */
function makeHookRepo({ gitleaksExit = 0 } = {}) {
  const repo = makeRepo();
  const bin = stubGitleaks(gitleaksExit);
  write(repo, {
    'home/hooks/a.mjs': 'export const a = 1;\n',
    'home/hooks/lib/b.mjs': 'export const b = 1;\n',
    'tests/a.test.mjs': "import test from 'node:test';\ntest('a', () => { throw new Error('a test ran in the commit hook'); });\n",
  });
  git(repo, 'config', 'core.hooksPath', hooksCopy());
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'seed');
  git(repo, 'switch', '-q', '-c', 'feat');
  const env = { ...OUTSIDE_A_TEST_RUN, PATH: `${bin}:${process.env.PATH}` };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  return { repo, sh };
}

test('pre-commit lets a commit of a hook file that parses through, and runs no test', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  const result = sh('commit', '-q', '-m', 'change a');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'change a');
  // a copy of .githooks with no scripts/ beside it: share-check says so instead of failing, once in pre-commit, once in commit-msg
  assert.equal(result.stderr.match(/^share-check: not run \(no .*scripts\/share-check\.mjs beside the hooks\)$/gm)?.length, 2, result.stderr);
});

test('pre-commit blocks a hook file that does not parse, in a folder below home/hooks too, and names the file', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  for (const file of ['home/hooks/a.mjs', 'home/hooks/lib/b.mjs']) {
    writeFileSync(join(repo, file), 'export const = ;\n');
    git(repo, 'add', file);
    const blocked = sh('commit', '-q', '-m', `break ${file}`);
    assert.notEqual(blocked.status, 0, file);
    assert.match(blocked.stderr, new RegExp(`pre-commit: ${file.replace(/\./g, '\\.')} does not parse`), file);
    assert.equal(git(repo, 'log', '--format=%s', '-1'), 'seed', file);
    git(repo, 'restore', '--staged', '--worktree', file);
  }
});

test('pre-commit checks the staged text, not the working copy', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const = ;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 9;\n');
  assert.notEqual(sh('commit', '-q', '-m', 'staged text is broken').status, 0);
});

test('pre-commit does not parse-check files outside home/hooks', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  write(repo, { 'scripts/odd.mjs': 'export const = ;\n', 'docs/notes.md': '# notes\n' });
  git(repo, 'add', '.');
  const result = sh('commit', '-q', '-m', 'docs and a script');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('pre-commit stops the commit when gitleaks finds something', { skip }, () => {
  const { repo, sh } = makeHookRepo({ gitleaksExit: 1 });
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 4;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  assert.notEqual(sh('commit', '-q', '-m', 'leak').status, 0);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'seed');
});

/**
 * A repo whose only hook is this repo's .githooks/pre-commit (so the real share-check runs) with `seed` committed past the hooks.
 * `list`: the text of personal/share-deny.txt, or 'no-personal' (nothing at personal/), 'no-list' (personal/ without the list) or
 * 'dangling' (personal is a link that leads nowhere).
 * `gitleaks`: 'stub' (exits 0) or 'real' (the installed one, with this repo's .gitleaks.toml committed in the seed).
 */
function makeLiveHookRepo({ list = `${WORD}\n`, gitleaks = 'stub', seed = {} } = {}) {
  const repo = makeRepo();
  if (list === 'dangling') symlinkSync(join(repo, '..', 'gone'), join(repo, 'personal'));
  else if (list !== 'no-personal') mkdirSync(join(repo, 'personal'));
  if (!['no-personal', 'no-list', 'dangling'].includes(list)) writeFileSync(join(repo, 'personal', 'share-deny.txt'), list);
  const files = { 'docs/a.md': 'clean\n', ...seed };
  write(repo, files);
  if (gitleaks === 'real') copyFileSync(join(ROOT, '.gitleaks.toml'), join(repo, '.gitleaks.toml'));
  git(repo, 'add', '--', ...Object.keys(files), ...(gitleaks === 'real' ? ['.gitleaks.toml'] : []));
  git(repo, 'commit', '-q', '--no-verify', '-m', 'seed');
  const hooks = realpathSync(sharedToolDir({ 'pre-commit': `#!/usr/bin/env bash\nexec bash ${JSON.stringify(join(ROOT, '.githooks', 'pre-commit'))} "$@"\n` }));
  git(repo, 'config', 'core.hooksPath', hooks);
  const path = gitleaks === 'real' ? process.env.PATH : `${stubGitleaks(0)}:${process.env.PATH}`;
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...OUTSIDE_A_TEST_RUN, PATH: path } });
  return { repo, sh };
}

const lastSubject = (repo) => git(repo, 'log', '--format=%s', '-1');

test('pre-commit refuses a staged file holding a deny word and names it; a clean file commits', { skip }, () => {
  const { repo, sh } = makeLiveHookRepo();
  write(repo, { 'docs/b.md': `first\nabout ${WORD.toUpperCase()} here\n` });
  git(repo, 'add', 'docs/b.md');
  const refused = sh('commit', '-q', '-m', 'add b');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^docs\/b\.md:2: zebracorp$/m); // git sends a hook's output to stderr
  assert.equal(lastSubject(repo), 'seed');
  write(repo, { 'docs/b.md': 'first\nnothing private here\n' });
  git(repo, 'add', 'docs/b.md');
  const clean = sh('commit', '-q', '-m', 'add b');
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /^share-check: clean \(1 staged files checked/m);
  assert.equal(lastSubject(repo), 'add b');
});

test('pre-commit checks what `git commit -- <path>` commits (its own index), not only what was added before', { skip }, () => {
  const { repo, sh } = makeLiveHookRepo();
  write(repo, { 'docs/a.md': `${WORD}\n` });
  const refused = sh('commit', '-q', '-m', 'change a', '--', 'docs/a.md');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^docs\/a\.md:1: zebracorp$/m);
  assert.equal(lastSubject(repo), 'seed');
});

test('pre-commit refuses a deny word in a staged binary file and in a renamed file; a deleted one commits', { skip }, () => {
  const { repo, sh } = makeLiveHookRepo({ seed: { 'docs/old.md': `${WORD}\n`, 'docs/gone.md': `${WORD}\n` } });
  writeFileSync(join(repo, 'docs/blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(` ${WORD} `), Buffer.from([0])]));
  git(repo, 'add', 'docs/blob.bin');
  const binary = sh('commit', '-q', '-m', 'add blob');
  assert.notEqual(binary.status, 0, 'binary');
  assert.match(binary.stderr, /^docs\/blob\.bin:1: zebracorp$/m);
  git(repo, 'rm', '-q', '--cached', 'docs/blob.bin');
  git(repo, 'mv', 'docs/old.md', 'docs/new.md');
  const renamed = sh('commit', '-q', '-m', 'rename');
  assert.notEqual(renamed.status, 0, 'rename');
  assert.match(renamed.stderr, /^docs\/new\.md:1: zebracorp$/m);
  git(repo, 'mv', 'docs/new.md', 'docs/old.md');
  git(repo, 'rm', '-q', 'docs/gone.md');
  const deleted = sh('commit', '-q', '-m', 'remove gone', '--', 'docs/gone.md');
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(lastSubject(repo), 'remove gone');
});

test('pre-commit refuses every commit while the deny list cannot be read', { skip }, () => {
  const { repo, sh } = makeLiveHookRepo({ list: 'no-list' });
  mkdirSync(join(repo, 'personal', 'share-deny.txt')); // a folder where the list should be: not a readable file
  write(repo, { 'docs/a.md': 'still clean\n' });
  git(repo, 'add', 'docs/a.md');
  const refused = sh('commit', '-q', '-m', 'change a');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^share-check: error: deny list .*share-deny\.txt not readable/m);
  assert.equal(lastSubject(repo), 'seed');
});

test('pre-commit: no list says "not run" in a clone without personal/, and fails with the fix where personal/ exists', { skip }, () => {
  const clone = makeLiveHookRepo({ list: 'no-personal' });
  write(clone.repo, { 'docs/a.md': `${WORD}\n` });
  git(clone.repo, 'add', 'docs/a.md');
  const notRun = clone.sh('commit', '-q', '-m', 'change a');
  assert.equal(notRun.status, 0, notRun.stderr);
  assert.match(notRun.stderr, /^share-check: not run \(no deny list at .*personal\/share-deny\.txt\)$/m);

  for (const list of ['no-list', 'dangling']) {
    const owner = makeLiveHookRepo({ list });
    write(owner.repo, { 'docs/a.md': `${WORD}\nmore\n` });
    git(owner.repo, 'add', 'docs/a.md');
    const refused = owner.sh('commit', '-q', '-m', 'change a');
    assert.notEqual(refused.status, 0, list);
    assert.match(refused.stderr, /^share-check: error: no deny list at .*share-deny\.txt, but .*personal exists; .*cp '.*personal\.example\/share-deny\.txt'/m, list);
    assert.equal(lastSubject(owner.repo), 'seed', list);
  }
});

test('pre-commit with the real gitleaks refuses a made-up login token at tests/recall-x.test.mjs (no allowlist)', { skip: skip || (!HAS_GITLEAKS && 'gitleaks is not installed') }, () => {
  const { repo, sh } = makeLiveHookRepo({ gitleaks: 'real' });
  const token = `${['sk', 'ant', 'oat01', ''].join('-')}${'MadeUpGitleaksQ7x'.repeat(6).slice(0, 95)}`;
  write(repo, { 'tests/recall-x.test.mjs': `export const TOKEN = '${token}';\n` });
  git(repo, 'add', 'tests/recall-x.test.mjs');
  const refused = sh('commit', '-q', '-m', 'add recall fixture');
  assert.notEqual(refused.status, 0);
  const output = refused.stdout + refused.stderr;
  assert.match(output, /^File:\s+tests\/recall-x\.test\.mjs$/m, 'the finding is shown (--verbose), so a leak of its text would show');
  assert.match(output, /^Secret:.*REDACTED/m); // gitleaks colours the word, also into a pipe
  assert.ok(!output.includes(token.slice(-20)), 'the hook output redacts the token');
  assert.equal(lastSubject(repo), 'seed');
});
