// Tests of one step's outcome table (spec 7.2, 7.3, acceptance 2): the driver runs in this process on a fake clock with the fake
// claude of long-run-fake-claude.mjs; every wait is a jump of the clock, so nothing here waits for real minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs } from '../home/tools/long-run/lib/step.mjs';
import { classify } from '../home/tools/long-run/lib/claude-run.mjs';
import { readJson } from '../home/tools/long-run/lib/run-store.mjs';
import { createRun, driveRun, fakeClock, journalOf, makeSandbox, readCalls, stdinsOf } from './long-run-helpers.mjs';

const steps3 = (box) => ({ name: 'three', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Do one.' }, { id: 'two', prompt: 'Do two.' }, { id: 'three', prompt: 'Do three.' }] });
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test('a 3-step run ends done, each step one fresh session, default model claude-opus-5-5, the wrapper and earlier summaries on stdin', async () => {
  const box = makeSandbox();
  const paths = createRun(box, steps3(box));
  assert.equal(await driveRun(box, paths), 'done');
  const calls = readCalls(box);
  assert.deepEqual(calls.map((call) => call.step), ['one', 'two', 'three']);
  for (const call of calls) {
    assert.equal(flagValue(call.args, '--model'), 'claude-opus-5-5');
    assert.ok(call.args.includes('--session-id') && !call.args.includes('--resume'));
    assert.deepEqual(call.args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
    for (const banned of ['--bare', '--max-turns', '--permission-mode', '--dangerously-skip-permissions']) assert.ok(!call.args.includes(banned), banned);
  }
  assert.match(calls[0].stdin, /^Do one\.\n\nYou run unattended inside long-run \(run three-\d{8}-\d{6}, step one\)/);
  assert.match(calls[2].stdin, /Earlier steps:\n- one: Did one\.\n- two: Did two\./);
  assert.equal(readJson(paths.driver).status, 'done');
});

test('limit "resets 3:45pm": waits until the next 15:47 local and resumes the same session with attempts unchanged', async () => {
  const box = makeSandbox();
  box.script({ one: ['limit', 'done'] });
  const paths = createRun(box, { name: 'lim', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Do one.' }] });
  const start = new Date(2026, 10, 24, 10, 0, 0);
  const clock = fakeClock(start.toISOString());
  assert.equal(await driveRun(box, paths, { clock }), 'done');
  const calls = readCalls(box);
  assert.equal(calls.length, 2);
  assert.equal(flagValue(calls[1].args, '--resume'), flagValue(calls[0].args, '--session-id'));
  assert.equal(calls[1].stdin, 'The usage limit has reset; continue where you stopped.');
  const journal = journalOf(paths, 'one');
  assert.equal(journal.attempts, 0, 'a limit wait is not an attempt');
  const resumedAt = new Date(journal.startsLog[1].at);
  assert.deepEqual([resumedAt.getDate(), resumedAt.getHours(), resumedAt.getMinutes()], [24, 15, 47]);
  assert.ok(clock.slept.every((ms) => ms <= 30000), 'waits are cut in 30 s slices');
});

test('crash then done resumes the same session with --resume and the restart follow-up; backoff 60 s on the first failure', async () => {
  const box = makeSandbox();
  box.script({ one: ['crash', 'done'] });
  const paths = createRun(box, { name: 'crash', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Do one.' }] });
  const clock = fakeClock();
  assert.equal(await driveRun(box, paths, { clock }), 'done');
  const calls = readCalls(box);
  assert.equal(flagValue(calls[1].args, '--resume'), flagValue(calls[0].args, '--session-id'));
  assert.match(calls[1].stdin, /The runner paused or restarted this session/);
  assert.equal(clock.slept.reduce((sum, ms) => sum + ms, 0), 60000);
  assert.equal(journalOf(paths, 'one').attempts, 1);
});

test('backoff is 60 s then 240 s, within +-20% jitter, capped at the maximum', () => {
  const retry = { firstDelaySeconds: 60, factor: 4, maxDelaySeconds: 1800 };
  assert.equal(backoffMs(retry, 1, () => 0.5), 60000);
  assert.equal(backoffMs(retry, 2, () => 0.5), 240000);
  assert.equal(backoffMs(retry, 1, () => 0), 48000);
  assert.ok(backoffMs(retry, 1, () => 0.999999) <= 72000);
  assert.ok(backoffMs(retry, 2, () => 0) >= 192000 && backoffMs(retry, 2, () => 0.999999) <= 288000);
  assert.equal(backoffMs(retry, 9, () => 0.5), 1800000);
});

test('maxAttempts reached: held with "loop guard"', async () => {
  const box = makeSandbox();
  box.script({ one: ['crash'] });
  const paths = createRun(box, { name: 'guard', cwd: box.work('repo'), loopGuards: { maxAttempts: 2 }, steps: [{ id: 'one', prompt: 'Do one.' }] });
  assert.equal(await driveRun(box, paths), 'held');
  assert.equal(readCalls(box).length, 2);
  const { hold } = readJson(paths.driver);
  assert.equal(hold.status, 'failed');
  assert.match(hold.reason, /^loop guard: 2 attempts$/);
});

test('maxStarts reached: held with "loop guard" (no-verdict answers are retried until the start count stops them)', async () => {
  const box = makeSandbox();
  box.script({ one: ['no-verdict'] });
  const paths = createRun(box, { name: 'starts', cwd: box.work('repo'), loopGuards: { maxAttempts: 10, maxStarts: 3 }, steps: [{ id: 'one', prompt: 'Do one.' }] });
  assert.equal(await driveRun(box, paths), 'held');
  assert.equal(readCalls(box).length, 3);
  assert.match(readJson(paths.driver).hold.reason, /^loop guard: 3 starts$/);
  assert.equal(stdinsOf(box, 'one')[1], 'Give your STEP-RESULT line for this step.');
});

test('blocked: held at once, no retry', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked'] });
  const paths = createRun(box, steps3(box));
  assert.equal(await driveRun(box, paths), 'held');
  assert.equal(readCalls(box).length, 1);
  assert.deepEqual([readJson(paths.driver).hold.status, readJson(paths.driver).hold.reason], ['blocked', 'the API key is missing']);
});

test('needs-owner: held with the question; resume --answer x sends "The owner answered: x" to the same session', async () => {
  const box = makeSandbox();
  box.script({ one: ['needs-owner', 'done'] });
  const paths = createRun(box, steps3(box));
  assert.equal(await driveRun(box, paths), 'held');
  assert.equal(readJson(paths.driver).hold.question, 'Which colour should the button be?');
  assert.equal(await driveRun(box, paths, { reply: { action: 'answer', text: 'x' } }), 'done');
  const calls = readCalls(box).filter((call) => call.step === 'one');
  assert.equal(calls[1].stdin, 'The owner answered: x');
  assert.equal(flagValue(calls[1].args, '--resume'), flagValue(calls[0].args, '--session-id'));
});

test('--skip goes on with the next step; --abandon ends the run abandoned', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked'] });
  const paths = createRun(box, steps3(box));
  await driveRun(box, paths);
  assert.equal(await driveRun(box, paths, { reply: { action: 'skip' } }), 'done');
  assert.deepEqual(readCalls(box).map((call) => call.step), ['one', 'two', 'three']);
  const other = makeSandbox();
  other.script({ one: ['blocked'] });
  const second = createRun(other, steps3(other));
  await driveRun(other, second);
  assert.equal(await driveRun(other, second, { reply: { action: 'abandon' } }), 'abandoned');
  assert.equal(readCalls(other).length, 1);
});

test('auth: held with "login missing or refused for a", no retry', async () => {
  const box = makeSandbox();
  box.script({ one: ['auth'] });
  const paths = createRun(box, steps3(box));
  assert.equal(await driveRun(box, paths), 'held');
  assert.equal(readCalls(box).length, 1);
  assert.equal(readJson(paths.driver).hold.reason, 'login missing or refused for a');
});

test('check-failed: the session is resumed with the check command, its exit code and its output', async () => {
  const box = makeSandbox();
  const folder = box.work('repo');
  const check = `node -e "const fs=require('fs');const n=fs.existsSync('ran')?2:1;fs.writeFileSync('ran','x');console.log('check output '+n);process.exit(n===1?3:0)"`;
  const paths = createRun(box, { name: 'checked', cwd: folder, steps: [{ id: 'one', prompt: 'Do one.', check: { command: check } }] });
  assert.equal(await driveRun(box, paths), 'done');
  const [, second] = stdinsOf(box, 'one');
  assert.match(second, /^The step check `node -e .*` failed \(exit 3\)\. Last 40 lines:\ncheck output 1\nFix it and finish\.$/s);
});

test('no step timeout unless the job sets one: a 1.5 s step ends done; a timeout end classifies as timeout (retried)', async () => {
  const box = makeSandbox();
  box.script({ one: ['sleep:1500'] });
  const paths = createRun(box, { name: 'slow', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'Do one.' }] });
  assert.equal(await driveRun(box, paths), 'done');
  assert.equal(readCalls(box)[0].ended, 'exit');
  assert.equal(classify({ endedBy: 'timeout', result: null, exitCode: 130, stderrTail: '', error: null }).outcome, 'timeout');
});

test('a resume that finds no conversation starts fresh once, with the earlier summaries, and says so in the journal', async () => {
  const box = makeSandbox();
  box.script({ two: ['crash', 'no-conversation', 'done'] });
  const paths = createRun(box, steps3(box));
  assert.equal(await driveRun(box, paths), 'done');
  const calls = readCalls(box).filter((call) => call.step === 'two');
  assert.ok(calls[2].args.includes('--session-id'));
  assert.notEqual(flagValue(calls[2].args, '--session-id'), flagValue(calls[0].args, '--session-id'));
  assert.match(calls[2].stdin, /Earlier steps:\n- one: Did one\./);
  assert.ok(journalOf(paths, 'two').notes.includes('resume found no conversation: fresh start'));
});
