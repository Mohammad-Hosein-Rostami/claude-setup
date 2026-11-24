// Tests of `tell` (spec 19.2; acceptance 14): a running step is ended at its next safe point (a tool_result or result line, at most
// 120 s) and resumed in the same session with the message; a waiting step gets it first in its next prompt; a held step is resumed
// with it; a done step refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { join } from 'node:path';
import { startClaude } from '../home/tools/long-run/lib/claude-run.mjs';
import { queueTell } from '../home/tools/long-run/lib/control.mjs';
import { readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { TOKEN_A, cli, createRun, driveRun, fakeClock, journalOf, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const MESSAGE = 'Reply with the word PELICAN';
const TOLD = `Message from the owner, sent while you worked: ${MESSAGE}. Take it into account, continue the step, and end with your STEP-RESULT line.`;
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('running step: ended only after its next tool_result line, resumed in the same session with the message, counted as a start', async () => {
  const box = makeSandbox();
  box.script({ one: ['tool:2500', 'echo'] });
  const started = cli(box, ['start', box.writeJob({ name: 'tell', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running', 20000, 'one running');
  const told = cli(box, ['tell', paths.runId, 'one', MESSAGE]);
  assert.equal(told.status, 0, told.stderr);
  assert.match(told.stdout, /gets it at its next safe point/);
  await waitFor(() => readJson(paths.driver)?.status === 'done', 30000, 'run done');
  const calls = readCalls(box);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ended, 'SIGINT');
  const firstLog = readFileSync(join(paths.logs, 'one.1.jsonl'), 'utf8');
  assert.ok(firstLog.includes('"tool_result"'), 'the child reached its safe point before it was ended');
  assert.ok(!firstLog.includes('"type":"result"'), 'it was ended at the safe point, before its own result');
  assert.equal(flagValue(calls[1].args, '--resume'), flagValue(calls[0].args, '--session-id'));
  assert.equal(calls[1].stdin, TOLD);
  const journal = journalOf(paths, 'one');
  assert.deepEqual([journal.starts, journal.attempts], [2, 0]);
  assert.match(journal.summary, /You said: .*PELICAN/);
});

test('safe point: a child that never reaches one is ended after the wait cap (120 s in the runner, injected short here)', async () => {
  const box = makeSandbox();
  box.script({ hang: ['hang'] });
  const handle = startClaude({ args: ['-p', '--session-id', 'cap-session'], prompt: 'x', cwd: box.work('h'), env: box.env, token: TOKEN_A,
    added: { LONG_RUN_STEP: 'hang' }, logBase: join(makeTempDir('logs-', box.dir), 'hang.1') });
  await waitFor(() => readCalls(box).length === 1, 10000, 'fake started');
  handle.endAtSafePoint('tell', 300);
  const run = await handle.done;
  assert.deepEqual([run.endedBy, run.endedHow], ['tell', 'SIGINT']);
});

test('waiting step: the message comes first in the next prompt, and a backoff wait does not hold it back', async () => {
  const box = makeSandbox();
  box.script({ one: ['crash', 'echo'] });
  const paths = createRun(box, { name: 'wait', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  const clock = fakeClock();
  const sleep = clock.sleep;
  clock.sleep = async (ms) => {
    if (clock.slept.length === 0) queueTell(paths, 'one', MESSAGE);
    await sleep(ms);
  };
  assert.equal(await driveRun(box, paths, { clock }), 'done');
  const [, second] = readCalls(box);
  assert.ok(second.stdin.startsWith(`${TOLD}\n\nThe runner paused or restarted this session`), second.stdin);
  assert.ok(clock.slept.reduce((sum, ms) => sum + ms, 0) < 60000, 'the 60 s backoff was cut short by the message');
});

test('held step: tell queues the message and resumes the run; the step gets it with its follow-up', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked', 'echo'] });
  const paths = createRun(box, { name: 'held', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  assert.equal(await driveRun(box, paths), 'held');
  const told = cli(box, ['tell', paths.runId, 'one', MESSAGE, '--foreground']);
  assert.equal(told.status, 0, told.stderr);
  assert.match(told.stdout, /resuming run/);
  const [, second] = readCalls(box);
  assert.ok(second.stdin.startsWith(TOLD));
  assert.equal(readJson(paths.driver).status, 'done');
});

test('done step: tell exits 1 and points at rerun', async () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'over', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  await driveRun(box, paths);
  const told = cli(box, ['tell', paths.runId, 'one', MESSAGE]);
  assert.equal(told.status, 1);
  assert.match(told.stderr, /step one is done; use rerun --from one/);
});
