// A boss whose only safe point after a recorded switch is its final `result` line keeps the verdict it gave: the driver does not
// end that start as `switched` and does not start the finished step again on the new account. The same holds for a `tell`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP_WAIT_MS = 60000;
const CONTROL_POLL_MS = 100;
// The boss runs this long without a tool call, so the poll sees the switch before the boss gives its result.
const BOSS_RUN_MS = 3000;
const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });

const TELL_MESSAGE = 'Reply with the word PELICAN';

// Runs the one-step job; with `switchTo`, run.json names that account while the boss runs, as a `resume --account` would write it;
// with `tellMessage`, the owner tells the step that message while the boss runs. `bossMode` is the boss's first call; a second
// call (a restart of the step) would answer `done`, so a thrown-away verdict shows as a second start.
async function runOneStep(name, switchTo, { bossMode = `sleep:${BOSS_RUN_MS}`, tellMessage = null } = {}) {
  const box = makeSandbox();
  box.script({ one: [bossMode, 'done'] });
  const env = { ...box.env, CLAUDE_LONG_RUN_CONTROL_POLL_MS: String(CONTROL_POLL_MS) };
  const started = cli(box, ['start', box.writeJob(oneStep(box, name))], { env });
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length === 1, STEP_WAIT_MS, 'the boss runs on acct-a');
    if (switchTo) writeJson(paths.run, { ...readJson(paths.run), account: switchTo });
    if (tellMessage) {
      const told = cli(box, ['tell', paths.runId, 'one', tellMessage], { env });
      assert.equal(told.status, 0, told.stderr);
    }
    await waitFor(() => ['done', 'held'].includes(readJson(paths.driver)?.status), STEP_WAIT_MS, 'run end');
    return { calls: readCalls(box), journal: journalOf(paths, 'one'), queuedTells: readdirSync(paths.control).filter((file) => file.endsWith('.tell')) };
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

// The fake's boss gives its verdict only after BOSS_RUN_MS, so the switch is recorded and seen by the poll before the verdict.
for (const verdict of ['blocked', 'needs-owner']) {
  test(`a ${verdict} verdict given after run.json names acct-b is kept: one start on acct-a, outcome ${verdict}, no second start on acct-b`, async () => {
    const run = await runOneStep(`verdict${verdict.replace('-', '')}`, TO, { bossMode: `sleep-then:${BOSS_RUN_MS}:${verdict}` });

    assert.deepEqual(run.journal.startsLog.map((entry) => entry.outcome), [verdict], `the ${verdict} verdict was thrown away (${describeRun(run)})`);
    assert.deepEqual(run.calls.map((call) => call.account), [FROM], `the ${verdict} step started again (${describeRun(run)})`);
    assert.equal(run.journal.final.status, verdict, describeRun(run));
  });
}

test('a tell queued while the boss is about to give a done result keeps the verdict: one start, outcome done, the message stays queued unread', async () => {
  const run = await runOneStep('verdicttell', null, { tellMessage: TELL_MESSAGE });

  assert.deepEqual(run.journal.startsLog.map((entry) => entry.outcome), ['done'], `the done result was thrown away (${describeRun(run)})`);
  assert.equal(run.calls.length, 1, `the done step started again (${describeRun(run)})`);
  assert.equal(run.journal.final.status, 'done');
  // The step is finished, so no start takes the message: it is kept in the run's control folder, never sent to a boss.
  assert.equal(run.queuedTells.length, 1, 'the told text stays queued');
  assert.ok(!run.calls[0].stdin.includes(TELL_MESSAGE), 'the first start did not carry the message');
});
