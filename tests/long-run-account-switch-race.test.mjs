// Test of `resume --account` racing a plain `resume` (a controller, resumeStale or tell): once resume --account has passed its
// driver check, a plain resume may start a driver before the switch is written. The switch must then either be refused or reach
// the live step; it must never be recorded while that driver keeps the step on the old account in the old account's limit wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resumeCommand } from '../home/tools/long-run/lib/cli-run.mjs';
import { RunBusy, driverAlive, isPidAlive, readJson, readJsonLines, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { TOKEN_A, cli, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const SETUP_WAIT_MS = 30000;
// Long enough for a fixed driver to notice the switch on its next control poll (driver.mjs CONTROL_POLL_MS, 2 s by default).
const SETTLE_MS = 10000;
const SLICE_MS = 50;
// A driver spawned by the resume under test may still be starting when the first cleanup kill runs.
const CLEANUP_GAP_MS = 500;

const hash = (token) => createHash('sha256').update(token).digest('hex');
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
// resumeCommand calls `write` synchronously inside its gap, so holding the gap open needs a blocking wait.
const blockFor = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class SetupError extends Error {}

test('resume --account racing a plain resume never records a switch that the live driver ignores', async () => {
  const box = makeSandbox();
  box.script({ one: ['limit', 'done'] });
  const jobPath = box.writeJob({ name: 'race', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  const started = cli(box, ['start', jobPath]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'waiting-limit', SETUP_WAIT_MS, 'setup: the first limit wait');
    assert.equal(cli(box, ['pause', paths.runId]).status, 0, 'setup: pause');
    const firstPid = readJson(paths.driver).pid;
    await waitFor(() => readJson(paths.driver)?.status === 'paused' && !isPidAlive(firstPid), SETUP_WAIT_MS, 'setup: the paused driver gone');

    const otherDriverWaits = () => {
      const driver = readJson(paths.driver);
      return driver?.pid !== firstPid && driver?.live?.one?.state === 'waiting-limit' && driverAlive(paths);
    };
    const runPlainResume = () => {
      const plain = cli(box, ['resume', paths.runId]);
      if (plain.status !== 0) throw new SetupError(`setup: the plain resume exited ${plain.status}: ${plain.stderr}`);
      const deadline = Date.now() + SETUP_WAIT_MS;
      while (!otherDriverWaits()) {
        if (Date.now() > deadline) throw new SetupError('setup: the plain resume\'s driver never reached its limit wait');
        blockFor(SLICE_MS);
      }
    };
    // The window is resumeCommand's gap between its driverAlive check and prepareResume's acquireLock: the token read of
    // accountToken (the Keychain or store in real use) and the open-session check sit there. resumeCommand's first env read is
    // that token read, so the plain resume runs to its end on that first read, with its driver in the limit wait before the switch
    // takes the lock. The plain resume itself gets box.env, not the proxy, so it does not trigger again.
    let plainResumed = false;
    const env = new Proxy(box.env, {
      get(target, key, receiver) {
        if (!plainResumed) {
          plainResumed = true;
          runPlainResume();
        }
        return Reflect.get(target, key, receiver);
      },
    });
    let refused = null;
    try {
      await resumeCommand({ runId: paths.runId, flags: { account: TO, 'reload-job': jobPath }, env, root: box.root, write: () => {} });
    } catch (error) {
      if (error instanceof SetupError || !(error instanceof RunBusy)) throw error;
      refused = error;
    }
    if (!plainResumed) throw new SetupError('setup: resumeCommand never read env, so the plain resume was not run in the gap');

    const switchIgnored = () => {
      const journal = journalOf(paths, 'one');
      const switched = readJsonLines(paths.events).some((event) => event.event === 'account-switched');
      return readJson(paths.run).account === TO && switched && driverAlive(paths) && journal.account === FROM && journal.waitUntil !== null;
    };
    // At the tip this never turns false; a fix that applies the switch to the live step turns it false within a control poll.
    const settleBy = Date.now() + SETTLE_MS;
    while (switchIgnored() && Date.now() < settleBy) await pause(SLICE_MS);

    assert.ok(!switchIgnored(), 'switch recorded, but the live driver keeps step one on acct-a in its limit wait');
    const run = readJson(paths.run);
    if (refused) {
      assert.equal(run.account, FROM, 'a refused resume --account leaves run.json on the old account');
      assert.equal(run.switches, undefined, 'a refused resume --account records no switch');
      assert.ok(!readJsonLines(paths.events).some((event) => event.event === 'account-switched'), 'a refused resume --account writes no event');
    } else if (run.account === TO) {
      const switchedAt = Date.parse(run.switches.at(-1).at);
      const afterSwitch = readCalls(box).filter((call) => call.start >= switchedAt);
      assert.deepEqual(afterSwitch.filter((call) => call.tokenHash === hash(TOKEN_A)), [], 'a start after the switch to acct-b used acct-a\'s token');
    }
  } finally {
    killRunProcesses(box, paths);
    await pause(CLEANUP_GAP_MS);
    killRunProcesses(box, paths);
  }
});
