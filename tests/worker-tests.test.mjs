// Self-test of tests/worker-tests.mjs: a test whose body did not run in its worker must fail, never pass unrun (review R6/S1 of
// lane faster-slow-tests). Each case loads a small fixture test file, written to a temp folder, in a worker through runTestInWorker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { runTestInWorker } from './worker-tests.mjs';

const HELPER_URL = new URL('./worker-tests.mjs', import.meta.url).href;
const FIXTURE_TESTS = `const { test, suite, runNamedBody } = workerTests(import.meta.url);
suite('fixture', { concurrency: true }, () => {
  test('passes', () => {});
  test('fails', () => { throw new Error('planted failure'); });
  test('exits early', () => { process.exit(0); });
  test('twice', () => {});
  test('twice', () => {});
});
`;

/** Writes a fixture test file that uses the helper; `withRunLine` false leaves out its last line `await runNamedBody();`. */
function fixture({ withRunLine }) {
  const file = join(makeTempDir('worker-tests-'), 'fixture.test.mjs');
  const runLine = withRunLine ? 'await runNamedBody();\n' : '';
  writeFileSync(file, `import { workerTests } from ${JSON.stringify(HELPER_URL)};\n${FIXTURE_TESTS}${runLine}`);
  return pathToFileURL(file).href;
}

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
