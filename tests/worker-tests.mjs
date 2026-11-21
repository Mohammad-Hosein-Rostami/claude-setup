// Runs each test body of a test file in a worker thread of its own, so synchronous tests (a tool run through spawnSync) run side by
// side inside a describe with { concurrency: true }: node:test runs synchronous bodies one after another even there.
// Exports: workerTests(fileUrl) -> { test, suite, runNamedBody }; runTestInWorker(fileUrl, name) (the self-test calls it directly).
// How: on the main thread `test` registers the test with node:test and its body runs in a worker that loads the same file with the
// test's name; there `test` only collects the body of that name, `suite` only calls its function, and the file's last line
// `await runNamedBody();` runs that body, then posts RAN_MESSAGE. The main thread passes a test only on exit code 0 with that
// message, so a worker that ran no body (no name or two names matched, the last line missing, a process.exit in the body) fails.
// Invariants: test names in such a file are static and unique; a body gets no test context `t`; a failure's TAP `location:` is the
// nodeTest call in this file (the stack still names the body's own line). Tests self-check: tests/worker-tests.test.mjs.
import { describe, test as nodeTest } from 'node:test';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const RAN_MESSAGE = 'ran';

/**
 * Loads `fileUrl` in a worker thread that runs the body of the test `name`.
 * @param {string} fileUrl the test file (its import.meta.url)
 * @param {string} name the test's name
 * @returns {Promise<void>} resolves when the body completed; rejects with the body's error, or when the worker ended without
 *   reporting a body run (exit code 0 included)
 */
export function runTestInWorker(fileUrl, name) {
  return new Promise((resolve, reject) => {
    let ran = false;
    const worker = new Worker(new URL(fileUrl), { workerData: { testName: name } });
    worker.on('message', (message) => { ran = message === RAN_MESSAGE; });
    worker.once('error', reject); // a failed assert in the body arrives here with its message and stack
    worker.once('exit', (code) => {
      if (code === 0 && ran) resolve();
      else reject(new Error(`the worker of "${name}" exited with code ${code}${ran ? '' : ' and its body never reported that it ran'}`));
    });
  });
}

/**
 * The `test` and `suite` a test file declares its tests with, and the runner of its last line (see the header).
 * @param {string} fileUrl the calling test file's import.meta.url
 * @returns {{ test: Function, suite: Function, runNamedBody: () => Promise<void> }}
 */
export function workerTests(fileUrl) {
  const namedBodies = []; // worker thread: the bodies of the tests named like the one this worker was started for
  const testInWorker = (name, ...optionsAndBody) => {
    const options = optionsAndBody.length > 1 ? optionsAndBody[0] : {};
    nodeTest(name, options, () => runTestInWorker(fileUrl, name));
  };
  const collectIfNamed = (name, ...optionsAndBody) => {
    if (name === workerData.testName) namedBodies.push(optionsAndBody.at(-1));
  };
  /** Worker thread: runs the one collected body and reports it; none or two is an error. Main thread: nothing. */
  async function runNamedBody() {
    if (isMainThread) return;
    if (namedBodies.length !== 1) throw new Error(`the worker for "${workerData.testName}" found ${namedBodies.length} tests of that name, not 1`);
    await namedBodies[0](); // a body that never settles ends the worker with exit code 13, which fails the test
    parentPort.postMessage(RAN_MESSAGE);
  }
  return {
    test: isMainThread ? testInWorker : collectIfNamed,
    suite: isMainThread ? describe : (name, options, body) => body(),
    runNamedBody,
  };
}
