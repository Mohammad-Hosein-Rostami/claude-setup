// Repro tests of runAccount and a live driver when run.json is not a regular file. The driver reads run.json in its 2 s control timer,
// at each attempt and in each wait slice; a blocking read that follows links hangs on a FIFO, so a `long-run pause` is never served and
// the beat stops, and it follows a symlink to whatever it names. Like driver.lock, run.json is read only when it is a regular file;
// anything else is "no change" (null). A FIFO and a symlink are POSIX only; the unit cases run runAccount in a child so a hang cannot
// freeze this runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureRunDirs, readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { POSIX_ONLY } from './process-group-helpers.mjs';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const RUN_STORE_URL = pathToFileURL(join(import.meta.dirname, '..', 'home', 'tools', 'long-run', 'lib', 'run-store.mjs')).href;
const RUN_ID = 'fifo-20261125-100000';
const OTHER_ACCOUNT = 'acct-b';
// A read that returns takes milliseconds; one that blocks on a FIFO with no writer never returns.
const CHILD_TIMEOUT_MS = 5000;
const SETUP_WAIT_MS = 30000;
// Two control polls (every 2 s), so the driver reads run.json while it is a FIFO before `pause` is asked.
const POLL_SPAN_MS = 5000;
const PAUSE_CLI_TIMEOUT_MS = 15000;
const PAUSED_WITHIN_MS = 20000;
const WATCH_SLICE_MS = 100;
const CASE_TIMEOUT_MS = 90000;
// The child prints what runAccount returned (JSON), or the error it threw.
const CHILD_CODE = `
const [storeUrl, root, runId] = process.argv.slice(1);
const { runAccount, runPaths } = await import(storeUrl);
console.log(JSON.stringify(runAccount(runPaths(root, runId))));
`;

/** Makes a FIFO at `path`; false when this system has no mkfifo. */
function makeFifo(path) {
  const made = spawnSync('mkfifo', [path]);
  if (made.error?.code === 'ENOENT') return false;
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr}`);
  return true;
}

/** runAccount of the run folder `root`/RUN_ID, run in a child that is killed after CHILD_TIMEOUT_MS. */
function runAccountInChild(root) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_CODE, RUN_STORE_URL, root, RUN_ID], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
}

/** A temp state folder holding the run folder of RUN_ID; the caller removes `root`. */
function makeRunFolder() {
  const root = makeTempDir('long-run-fifo-');
  const paths = runPaths(root, RUN_ID);
  ensureRunDirs(paths);
  return { root, paths };
}

test('runAccount returns null at once when run.json is a FIFO with no writer', POSIX_ONLY, (context) => {
  const { root, paths } = makeRunFolder();
  try {
    if (!makeFifo(paths.run)) return context.skip('no mkfifo on this system');
    const child = runAccountInChild(root);
    assert.deepEqual(
      { status: child.status, signal: child.signal, stdout: child.stdout.trim() },
      { status: 0, signal: null, stdout: 'null' },
      `runAccount blocked or threw on a FIFO run.json (a driver timer would hang): ${child.error?.code ?? ''} ${child.stderr}`,
    );
  } finally {
    removeTempDir(root);
  }
});

test('runAccount returns null for run.json that is a symlink to a file naming another account', POSIX_ONLY, () => {
  const { root, paths } = makeRunFolder();
  try {
    const target = join(paths.dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ account: OTHER_ACCOUNT }));
    symlinkSync(target, paths.run);
    const child = runAccountInChild(root);
    assert.deepEqual(
      { status: child.status, signal: child.signal, stdout: child.stdout.trim() },
      { status: 0, signal: null, stdout: 'null' },
      `runAccount followed a run.json symlink and read the account it names (${OTHER_ACCOUNT}), not "no change": ${child.error?.code ?? ''} ${child.stderr}`,
    );
  } finally {
    removeTempDir(root);
  }
});

test('a live driver whose run.json becomes a FIFO still serves long-run pause', { ...POSIX_ONLY, timeout: CASE_TIMEOUT_MS }, async (context) => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const started = cli(box, ['start', box.writeJob({ name: 'fifo', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  let fifoMade = false;
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length > 0, SETUP_WAIT_MS, 'setup: step one running');
    rmSync(paths.run);
    fifoMade = makeFifo(paths.run);
    if (!fifoMade) return context.skip('no mkfifo on this system');
    await new Promise((done) => { setTimeout(done, POLL_SPAN_MS); });

    const paused = cli(box, ['pause', paths.runId], { timeout: PAUSE_CLI_TIMEOUT_MS });
    const deadline = Date.now() + PAUSED_WITHIN_MS;
    while (readJson(paths.driver)?.status !== 'paused' && Date.now() < deadline) {
      await new Promise((done) => { setTimeout(done, WATCH_SLICE_MS); });
    }
    const driver = readJson(paths.driver);
    assert.equal(driver?.status, 'paused', `the driver did not serve pause within ${PAUSED_WITHIN_MS} ms of a FIFO run.json: driver status ${driver?.status}, beatAt ${driver?.beatAt}, now ${new Date().toISOString()}; pause exit ${paused.status}: ${(paused.stdout + paused.stderr).trim().slice(0, 160)}`);
  } finally {
    if (fifoMade) unblockReader(paths.run);
    killRunProcesses(box, paths);
    removeTempDir(box.dir);
  }
});

/** Gives a driver blocked reading the FIFO its end of file, so the kill that follows finds it as it is. No reader (ENXIO) is fine. */
function unblockReader(fifo) {
  let fd;
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENXIO') return;
    throw error;
  }
  try {
    writeSync(fd, '{}');
  } finally {
    closeSync(fd);
  }
}
