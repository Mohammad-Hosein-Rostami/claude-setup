// Tests of rule 2 of the run-lock model (plan long-run-lock-model): a live driver follows the account run.json names, whoever
// wrote it and however the driver got the run. In a limit wait the wait ends within one slice; a running boss ends at its next
// safe point; in both the step continues its own session on the new account and no attempt is counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { TOKEN_A, TOKEN_B, cli, createRun, driveRun, fakeClock, journalOf, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP_WAIT_MS = 30000;
// step.mjs's wait slice: a wait looks at run.json this often.
const WAIT_SLICE_MS = 30 * 1000;
// The boss's tool call and result are this far apart, so the poll finds it between its start and its safe point.
const TOOL_MS = 1500;
const CONTROL_POLL_MS = 100;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];
const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
const recordAccount = (paths, account) => writeJson(paths.run, { ...readJson(paths.run), account });

test('a driver in a limit wait of acct-a drops the wait within one slice when run.json names acct-b, and resumes the same session on acct-b', async () => {
  const box = makeSandbox();
  box.script({ one: ['limit', 'done'] });
  const paths = createRun(box, oneStep(box, 'followwait'), { account: FROM });
  const clock = fakeClock();
  // The switch lands while the driver sleeps in the wait, as a `resume --account` of another process would write it.
  let switchedAt = null;
  const sleep = async (ms) => {
    if (switchedAt === null) {
      switchedAt = clock.slept.length;
      recordAccount(paths, TO);
    }
    await clock.sleep(ms);
  };
  await driveRun(box, paths, { clock: { ...clock, sleep } });

  assert.equal(switchedAt, 0, 'the switch was written from the first slice of the wait');
  assert.deepEqual(clock.slept, [WAIT_SLICE_MS], 'the wait ended after that one slice, not at the limit reset');
  const calls = readCalls(box);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].account, calls[0].tokenHash], [FROM, hash(TOKEN_A)]);
  assert.deepEqual([calls[1].account, calls[1].tokenHash], [TO, hash(TOKEN_B)]);
  assert.equal(flagValue(calls[1].args, '--resume'), flagValue(calls[0].args, '--session-id'), 'the second start resumes the first one\'s session');
  const journal = journalOf(paths, 'one');
  assert.ok(journal.notes.includes(`account ${FROM} -> ${TO}: limit wait dropped`), JSON.stringify(journal.notes));
  assert.equal(journal.waitUntil, null);
  assert.equal(journal.final.status, 'done');
});

test('a boss running on acct-a ends at its next safe point when run.json names acct-b, and starts again on acct-b with the same session, no attempt counted, outcome switched', async () => {
  const box = makeSandbox();
  box.script({ one: [`tool:${TOOL_MS}`, 'done'] });
  const env = { ...box.env, CLAUDE_LONG_RUN_CONTROL_POLL_MS: String(CONTROL_POLL_MS) };
  const started = cli(box, ['start', box.writeJob(oneStep(box, 'followboss'))], { env });
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length === 1, STEP_WAIT_MS, 'the boss runs on acct-a');
    assert.equal(readCalls(box)[0].account, FROM);
    recordAccount(paths, TO);
    await waitFor(() => readJson(paths.driver)?.status === 'done', STEP_WAIT_MS, 'run done');

    const [first, second] = readCalls(box);
    assert.equal(readCalls(box).length, 2);
    assert.deepEqual([first.account, first.tokenHash], [FROM, hash(TOKEN_A)]);
    assert.deepEqual([second.account, second.tokenHash], [TO, hash(TOKEN_B)]);
    assert.equal(first.ended, 'SIGINT', 'the first boss was interrupted, it did not finish');
    // The tool result is the first safe point: ending sooner would cut the boss in the middle of its tool call.
    assert.ok(first.end - first.start >= TOOL_MS, `the first boss ran ${first.end - first.start} ms, less than its ${TOOL_MS} ms tool call`);
    assert.equal(flagValue(second.args, '--resume'), flagValue(first.args, '--session-id'), 'the second start resumes the first one\'s session');
    const journal = journalOf(paths, 'one');
    assert.equal(journal.attempts, 0, 'a switch is not an attempt');
    assert.equal(journal.account, TO);
    assert.deepEqual(journal.startsLog.map((entry) => [entry.mode, entry.outcome]), [['fresh', 'switched'], ['resume', 'done']]);
  } finally {
    killRunProcesses(box, paths);
  }
});
