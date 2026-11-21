// Tests for .githooks/pre-commit and .githooks/pre-push, run through real `git commit` in a throw-away repo that holds copies of the
// hooks, scripts/affected-tests.mjs and the test-pass tool. gitleaks is a stub on PATH (the real one is not what is tested here).
// Each test file of that repo appends its own name to $RAN_LOG, so the log shows exactly which tests a commit ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, SWITCH_MODULE_FILES, git, makeRepo, turnChecksOn } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSION_ID = 'githooks-test-session';
const skip = process.platform === 'win32' && 'bash hooks';
const { NODE_TEST_CONTEXT: _outerRunner, ...OUTSIDE_A_TEST_RUN } = CLEAN_ENV; // else the inner `node --test` reports to this run and exits 0
const recordsRan = (name) => `import { appendFileSync } from 'node:fs';\nimport '../home/hooks/${name}.mjs';\nappendFileSync(process.env.RAN_LOG, '${name}\\n');\n`;

function write(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

/**
 * A repo on branch feat with the hooks installed (core.hooksPath), tests a and b (each reaching only its own hook script).
 * `checksOn` is what the owner's /check switch turns on for the session the hooks run in (none: only gitleaks runs).
 */
function makeHookRepo({ gitleaksExit = 0, checksOn = ['test'] } = {}) {
  const repo = makeRepo();
  const bin = realpathSync(makeTempDir('githooks-bin-'));
  writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh\nexit ${gitleaksExit}\n`);
  chmodSync(join(bin, 'gitleaks'), 0o755);
  for (const path of ['.githooks', 'scripts/affected-tests.mjs', 'home/tools/test-pass', 'home/tools/disk-free/with-run-tmp.mjs', 'home/hooks/lib/session-store.mjs', 'scripts/test-integrity.mjs', 'home/tools/review-tier', 'home/tools/git-tidy/lib', ...SWITCH_MODULE_FILES]) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    cpSync(join(ROOT, path), join(repo, path), { recursive: true });
  }
  write(repo, {
    'home/hooks/a.mjs': 'export const a = 1;\n',
    'home/hooks/b.mjs': 'export const b = 1;\n',
    'tests/a.test.mjs': `import test from 'node:test';\ntest('a', () => {});\n${recordsRan('a')}`,
    'tests/b.test.mjs': `import test from 'node:test';\ntest('b', () => {});\n${recordsRan('b')}`,
    'package.json': JSON.stringify({ scripts: { test: 'node --test tests/*.test.mjs' } }),
  });
  git(repo, 'config', 'core.hooksPath', '.githooks');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'seed');
  git(repo, 'switch', '-q', '-c', 'feat');
  const log = join(repo, '..', 'ran.log');
  writeFileSync(log, '');
  const home = join(repo, '..', 'home');
  if (checksOn.length > 0) turnChecksOn(home, SESSION_ID, checksOn);
  const env = { ...OUTSIDE_A_TEST_RUN, PATH: `${bin}:${process.env.PATH}`, RAN_LOG: log, HOME: home, CLAUDE_CODE_SESSION_ID: SESSION_ID };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
  const ran = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).sort();
  return { repo, sh, ran, env };
}

test('pre-commit runs only the tests that reach the staged file', { skip }, () => {
  const { repo, sh, ran } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  const result = sh('commit', '-q', '-m', 'change a');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(ran(), ['a']);
});

test('pre-commit on a partial commit (git commit -- <path>) runs only that path\'s tests', { skip }, () => {
  const { repo, sh, ran } = makeHookRepo();
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'home/hooks/b.mjs'), 'export const b = 2;\n');
  git(repo, 'add', '.');
  const result = sh('commit', '-q', '-m', 'only b', '--', 'home/hooks/b.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(ran(), ['b']);
});

test('pre-commit says there are no affected tests for a documents-only commit and runs none', { skip }, () => {
  const { repo, sh, ran } = makeHookRepo();
  write(repo, { 'docs/notes.md': '# notes\n' });
  git(repo, 'add', 'docs/notes.md');
  const result = sh('commit', '-m', 'docs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pre-commit: no affected tests/);
  assert.deepEqual(ran(), []);
});

test('pre-commit blocks the commit when an affected test fails, and not when only an unrelated test would fail', { skip }, () => {
  const { repo, sh } = makeHookRepo();
  write(repo, { 'tests/b.test.mjs': "import test from 'node:test';\nimport '../home/hooks/b.mjs';\ntest('b', () => { throw new Error('red b'); });\n" });
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 3;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  assert.equal(sh('commit', '-q', '-m', 'a only').status, 0, 'b is red but a does not reach it');
  writeFileSync(join(repo, 'home/hooks/b.mjs'), 'export const b = 3;\n');
  git(repo, 'add', 'home/hooks/b.mjs');
  const blocked = sh('commit', '-q', '-m', 'b');
  assert.notEqual(blocked.status, 0);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'a only');
});

test('pre-commit runs only gitleaks and no test while the test check is off', { skip }, () => {
  const { repo, sh, ran } = makeHookRepo({ checksOn: [] });
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 5;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  const result = sh('commit', '-q', '-m', 'change a, check off');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pre-commit: gitleaks only/);
  assert.deepEqual(ran(), []);
});

test('pre-commit stops the commit when gitleaks finds something', { skip }, () => {
  const { repo, sh, ran } = makeHookRepo({ gitleaksExit: 1 });
  writeFileSync(join(repo, 'home/hooks/a.mjs'), 'export const a = 4;\n');
  git(repo, 'add', 'home/hooks/a.mjs');
  assert.notEqual(sh('commit', '-q', '-m', 'leak').status, 0);
  assert.deepEqual(ran(), []);
});

test('pre-push runs the declared suite through test-pass and records the pass; a second push does not rerun it', { skip }, () => {
  const { repo, ran, env } = makeHookRepo();
  const push = () => spawnSync('bash', ['.githooks/pre-push', 'origin', 'none'], { cwd: repo, encoding: 'utf8', env });
  const first = push();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(ran(), ['a', 'b']);
  const second = push();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /already passed on this tree/);
  assert.deepEqual(ran(), ['a', 'b'], 'no new run');
  assert.ok(existsSync(join(repo, '..', 'home', '.claude', 'state', 'test-pass')));
});

test('pre-push fails when the suite fails', { skip }, () => {
  const { repo, env } = makeHookRepo();
  write(repo, { 'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => { throw new Error('red'); });\n" });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '--no-verify', '-m', 'red suite');
  const result = spawnSync('bash', ['.githooks/pre-push', 'origin', 'none'], { cwd: repo, encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
});

test('pre-push runs no suite while the test check is off', { skip }, () => {
  const { repo, ran, env } = makeHookRepo({ checksOn: [] });
  const result = spawnSync('bash', ['.githooks/pre-push', 'origin', 'none'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /suite not run \(test check off/);
  assert.deepEqual(ran(), []);
});
