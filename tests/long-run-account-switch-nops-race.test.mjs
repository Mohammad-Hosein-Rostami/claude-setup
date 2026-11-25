// Test of `resume --account` racing a plain `resume` whose driver starts inside the switch's writes, on a machine where ps cannot
// tell a process start (Windows, Git Bash; tests/no-ps-hook.mjs stands in for it) and, as the control, where ps shows starts. The
// switch takes no lock: it writes run.json and every driver follows it, with ps or without. A switch must never end recorded while a
// live driver keeps step one on the old account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resumeCommand } from '../home/tools/long-run/lib/cli-run.mjs';
import { RunBusy, driverAlive, readJson, readJsonLines } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP = 'one';
const DRIVER_WAIT_MS = 15000;
const SETTLE_WAIT_MS = 30000;
const SLICE_MS = 50;
// A driver spawned by the resume under test may still be starting when the first cleanup kill runs.
const CLEANUP_GAP_MS = 500;
const BUSY_LINE = /is busy: /;
const HOOK_URL = pathToFileURL(fileURLToPath(new URL('./no-ps-hook.mjs', import.meta.url))).href;

const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
// resumeCommand calls `write` synchronously inside its writes, so holding them open needs a blocking wait.
const blockFor = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The sandbox's env, with the no-ps hook added to NODE_OPTIONS so each node process the CLI starts loads it. */
const noPsEnv = (box) => ({ ...box.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${HOOK_URL}`].filter(Boolean).join(' ') });

/**
 * Runs `resume --account` and, from its `write` hook on the "reloaded" line (inside prepareResume, after run.json names the new
 * account), a plain `resume` through the CLI; waits there until that driver starts a boss or says the run is busy. Then checks the
 * invariant.
 */
async function switchRacesPlainResume(env, box) {
  box.script({ [STEP]: ['hang', 'done'] }); // a driver that keeps the step on its account hangs at it instead of finishing
  const job = { name: 'nops-race', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] };
  const jobPath = box.writeJob(job);
  const paths = createRun(box, job, { account: FROM });
  const log = () => (existsSync(paths.driverLog) ? readFileSync(paths.driverLog, 'utf8') : '');
  let plain = null;
  let driverSettled = false;
  const write = (line) => {
    if (plain !== null || !line.startsWith('reloaded')) return;
    plain = cli(box, ['resume', paths.runId], { env });
    const deadline = Date.now() + DRIVER_WAIT_MS;
    while (Date.now() < deadline && readCalls(box).length === 0 && !BUSY_LINE.test(log())) blockFor(SLICE_MS);
    driverSettled = readCalls(box).length > 0 || BUSY_LINE.test(log());
  };
  try {
    let refused = null;
    try {
      await resumeCommand({ runId: paths.runId, flags: { account: TO, 'reload-job': jobPath }, env, root: box.root, write });
    } catch (error) {
      if (!(error instanceof RunBusy)) throw error;
      refused = error;
    }
    assert.ok(plain !== null, 'setup: the switch reached its "reloaded" line');
    assert.equal(plain.status, 0, `setup: the plain resume started a driver: ${plain.stdout}${plain.stderr}`);
    assert.ok(driverSettled, `setup: the plain resume's driver started a boss or said busy within ${DRIVER_WAIT_MS} ms: ${log().trim().split('\n').at(-1)}`);
    if (refused === null) await waitFor(() => readCalls(box).length > 0, SETTLE_WAIT_MS, 'a boss start after the recorded switch');

    const switched = readJsonLines(paths.events).some((event) => event.event === 'account-switched');
    const starts = readCalls(box).map((call) => call.account);
    const journalAccount = journalOf(paths, STEP)?.account;
    const state = `exit ${refused ? `refused (${refused.message})` : 0}; run.json ${readJson(paths.run).account}; account-switched event ${switched}; driver alive ${driverAlive(paths)}; journal ${journalAccount}; starts ${JSON.stringify(starts)}`;
    if (refused !== null) {
      assert.equal(readJson(paths.run).account, FROM, `the refused switch changed the run: ${state}`);
      assert.equal(switched, false, `the refused switch left an account-switched event: ${state}`);
      return;
    }
    const keptOldAccount = journalAccount === FROM || starts.includes(FROM);
    assert.ok(!(switched && keptOldAccount), `switch recorded while the live driver runs step ${STEP} on ${FROM}: ${state}`);
    assert.deepEqual(starts.filter((account) => account !== TO), [], `a boss started on the old account: ${state}`);
  } finally {
    killRunProcesses(box, paths);
    await pause(CLEANUP_GAP_MS);
    killRunProcesses(box, paths);
  }
}

test('with no ps start, resume --account racing a plain resume\'s starting driver never records a switch while step one runs on the old account', async () => {
  const box = makeSandbox();
  try {
    await switchRacesPlainResume(noPsEnv(box), box);
  } finally {
    removeTempDir(box.dir);
  }
});

// Control: where ps shows starts, the same race must end the same way: the driver follows run.json, so no boss starts on the old account.
test('with ps starts, resume --account racing a plain resume\'s starting driver never records a switch while step one runs on the old account', async () => {
  const box = makeSandbox();
  try {
    await switchRacesPlainResume(box.env, box);
  } finally {
    removeTempDir(box.dir);
  }
});
