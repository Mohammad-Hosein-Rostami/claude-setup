// Tests for tests/temp-dir-helpers.mjs: folders are removed when the process ends (normally, by exit(), or by a throw),
// early removal works, the TMPDIR of the launcher is honoured, and no test file calls mkdtemp itself (the guard test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TEMP_PREFIX, makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const HELPER_URL = new URL('./temp-dir-helpers.mjs', import.meta.url).href;
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Runs `code` in a child node process whose TMPDIR is a fresh folder; returns the child's result and the folder's leftover names. */
function runChild(code) {
  const sandbox = makeTempDir('sandbox-');
  const script = `import { makeTempDir, removeTempDir } from ${JSON.stringify(HELPER_URL)};\nconst dir = makeTempDir('child-'); console.log(dir);\n${code}`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: sandbox } });
  return { run, dir: run.stdout.trim(), sandbox, leftovers: readdirSync(sandbox) };
}

test('makeTempDir makes the folder under os.tmpdir() with the shared prefix, then the process-exit hook removes it', () => {
  const { run, dir, sandbox, leftovers } = runChild('');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(dir.startsWith(join(sandbox, `${TEST_TEMP_PREFIX}child-`)), `folder ${dir} is not under the child's TMPDIR with the prefix`);
  assert.deepEqual(leftovers, []);
});

test('a test that throws still gets its folders removed', () => {
  const { run, leftovers } = runChild("makeTempDir('second-'); throw new Error('boom');");
  assert.notEqual(run.status, 0);
  assert.deepEqual(leftovers, []);
});

test('process.exit(1) in the middle of a test still removes the folders', () => {
  const { run, leftovers } = runChild('process.exit(1);');
  assert.equal(run.status, 1);
  assert.deepEqual(leftovers, []);
});

test('a folder with files and subfolders in it is removed whole', () => {
  const { run, leftovers } = runChild("import('node:fs').then(({ mkdirSync, writeFileSync }) => { mkdirSync(dir + '/a/b', { recursive: true }); writeFileSync(dir + '/a/b/f.txt', 'x'); });");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(leftovers, []);
});

test('removeTempDir removes a folder at once and a second call is harmless', () => {
  const dir = makeTempDir('early-');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'f.txt'), 'x');
  removeTempDir(dir);
  assert.equal(existsSync(dir), false);
  removeTempDir(dir);
});

/** Test files (and test helpers) that may call mkdtemp themselves, each with the reason. */
const MKDTEMP_ALLOWED = new Map([
  ['temp-dir-helpers.mjs', 'the helper itself'],
  ['temp-dir-helpers.test.mjs', 'this file names the call in its own checks'],
]);

test('no test file calls mkdtemp or mkdtempSync directly: they use makeTempDir', () => {
  const offenders = readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.mjs') && !MKDTEMP_ALLOWED.has(name))
    .filter((name) => /\bmkdtemp(Sync)?\b/.test(readFileSync(join(TESTS_DIR, name), 'utf8')));
  assert.deepEqual(offenders, [], 'use makeTempDir from ./temp-dir-helpers.mjs (or allow-list the file here with a reason)');
});
