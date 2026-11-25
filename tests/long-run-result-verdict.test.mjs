// A boss whose only safe point after a recorded switch is its final `result` line keeps the verdict it gave: the driver does not
// end that start as `switched` and does not start the finished step again on the new account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP_WAIT_MS = 60000;
const CONTROL_POLL_MS = 100;
// The boss runs this long without a tool call, so the poll sees the switch before the boss gives its result.
const BOSS_RUN_MS = 3000;
const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });

// Runs the one-step job; with `switchTo`, run.json names that account while the boss runs, as a `resume --account` would write it.
async function runOneStep(name, switchTo) {
  const box = makeSandbox();
  box.script({ one: [`sleep:${BOSS_RUN_MS}`, 'done'] });
  const env = { ...box.env, CLAUDE_LONG_RUN_CONTROL_POLL_MS: String(CONTROL_POLL_MS) };
  const started = cli(box, ['start', box.writeJob(oneStep(box, name))], { env });
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length === 1, STEP_WAIT_MS, 'the boss runs on acct-a');
    if (switchTo) writeJson(paths.run, { ...readJson(paths.run), account: switchTo });
    await waitFor(() => ['done', 'held'].includes(readJson(paths.driver)?.status), STEP_WAIT_MS, 'run end');
    return { calls: readCalls(box), journal: journalOf(paths, 'one') };
  } finally {
    killRunProcesses(box, paths);
  }
}

const describeRun = ({ calls, journal }) => `calls: ${calls.map((call) => `${call.account}/${call.mode}`).join(', ')}; outcomes: ${journal.startsLog.map((entry) => entry.outcome).join(', ')}; final ${journal.final?.status}`;

test('a done result given after run.json names acct-b keeps its verdict: one start on acct-a, outcome done, no second start on acct-b', async () => {
  const run = await runOneStep('verdictswitch', TO);

  assert.deepEqual(run.journal.startsLog.map((entry) => entry.outcome), ['done'], `the done result was thrown away (${describeRun(run)})`);
  assert.deepEqual(run.calls.map((call) => call.account), [FROM], `the done step started again (${describeRun(run)})`);
  assert.equal(run.journal.final.status, 'done');
});

test('control: a done result with no switch recorded is one start with outcome done', async () => {
  const run = await runOneStep('verdictcontrol', null);

  assert.deepEqual(run.journal.startsLog.map((entry) => entry.outcome), ['done'], describeRun(run));
  assert.deepEqual(run.calls.map((call) => call.account), [FROM], describeRun(run));
  assert.equal(run.journal.final.status, 'done');
});
