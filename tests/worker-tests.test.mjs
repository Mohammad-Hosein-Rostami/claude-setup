// Self-test of tests/worker-tests.mjs: a test whose body did not run in its worker must fail, never pass unrun (review R6/S1 of
// lane faster-slow-tests). Most cases load a small fixture test file, written to a temp folder, in a worker through runTestInWorker;
// one runs a fixture through `node --test`, so the main-thread side (the registered test) is checked too (review S2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { runTestInWorker } from './worker-tests.mjs';
import { cleanEnv } from './clean-env.mjs';

const HELPER_URL = new URL('./worker-tests.mjs', import.meta.url).href;
const FIXTURE_TESTS = `const { test, suite, runNamedBody } = workerTests(import.meta.url);
suite('fixture', { concurrency: true }, () => {
  test('passes', () => {});
  test('fails', () => { throw new Error('planted failure'); });
  test('exits early', () => { process.exit(0); });
  test('twice', () => {});
  test('twice', () => {});
  test('hangs', () => new Promise(() => {}));
  test('sets exit code', () => { process.exitCode = 1; });
});
`;

// Two tests in the two-argument suite form: one passes, one fails (run through `node --test` below).
const MAIN_THREAD_FIXTURE_TESTS = `const { test, suite, runNamedBody } = workerTests(import.meta.url);
suite('fixture', () => {
  test('passes', () => {});
  test('fails', () => { throw new Error('planted failure'); });
});
`;

/**
 * Writes a fixture test file that uses the helper; `withRunLine` false leaves out its last line `await runNamedBody();`.
 * @returns {{url: string, path: string}} the file as a URL and as a path
 */
function fixtureFile({ withRunLine, tests = FIXTURE_TESTS }) {
  const path = join(makeTempDir('worker-tests-'), 'fixture.test.mjs');
  const runLine = withRunLine ? 'await runNamedBody();\n' : '';
  writeFileSync(path, `import { workerTests } from ${JSON.stringify(HELPER_URL)};\n${tests}${runLine}`);
  return { url: pathToFileURL(path).href, path };
}
const fixture = (options) => fixtureFile(options).url;

test('a body that runs and passes passes (the control)', async () => {
  await runTestInWorker(fixture({ withRunLine: true }), 'passes');
});

test('a failing body fails with its own error', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'fails'), /planted failure/);
});

test('a name no test has fails: the worker ran no body', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'no such test'), /found 0 tests of that name, not 1/);
});

test('a name two tests share fails', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'twice'), /found 2 tests of that name, not 1/);
});

test('a file without its last line `await runNamedBody();` fails: the worker ends with code 0 but no body reported', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: false }), 'passes'), /exited with code 0 and its body never reported that it ran/);
});

test('a body that ends the worker with process.exit(0) fails: it never reported that it ran to the end', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'exits early'), /exited with code 0 and its body never reported that it ran/);
});

test('a body that never settles fails with exit code 13 instead of hanging', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'hangs'), /exited with code 13/);
});

test('a body that sets a failing exit code fails, though it reported that it ran', async () => {
  await assert.rejects(runTestInWorker(fixture({ withRunLine: true }), 'sets exit code'), /exited with code 1$/);
});

test('through node --test, the file registers its tests on the main thread: one passes, one fails with its own error, exit 1', () => {
  const { path } = fixtureFile({ withRunLine: true, tests: MAIN_THREAD_FIXTURE_TESTS });
  // without NODE_TEST_CONTEXT the nested run reports for itself instead of to this test runner
  const env = Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], { encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const line of ['# tests 2', '# pass 1', '# fail 1']) assert.match(result.stdout, new RegExp(`^${line}$`, 'm'), result.stdout);
  assert.match(result.stdout, /planted failure/);
});
