// Tests for answerAskAsync (home/hooks/lib/timed-ask-async.mjs): the popup the question loop opens. It answers like the sync answerAsk
// and, unlike it, can be closed from outside: an abort signal kills the popup and reports outcome "closed" (decision "ask"), and
// closeLiveDialogs() kills every popup this process still has open (the hook calls it when Claude Code stops the hook).
// The dialog tool is faked on PATH (tests/fake-dialog-tool.mjs): a "hang" popup stays open until killed, so a test sees its pid go away.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerAskAsync, closeLiveDialogs } from '../home/hooks/lib/timed-ask-async.mjs';
import { fakePopup } from './fake-dialog-tool.mjs';

const QUESTION_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };
const request = { tool: 'AskUserQuestion', reason: 'Claude asks 1 question', title: 'Claude Code: question', buttons: QUESTION_BUTTONS, details: [{ label: 'Question 1', value: 'Ship it?' }], timeoutS: 120 };
const FULL_WAIT_STEP_MS = 121_000; // each clock reading moves this far: the dialog "waited" longer than its 120 s
const POLL_MS = 20;
const WAIT_LIMIT_MS = 5000;

/** Waits until `check()` is true or the limit passes; a test never waits on a fixed sleep. */
async function until(check) {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  return check();
}

test('Use recommended -> allow, Answer in terminal -> deny, like the sync dialog', async () => {
  assert.deepEqual(await answerAskAsync(request, fakePopup('allow').env), { decision: 'allow', outcome: 'allow', reason: `allowed by the owner in the dialog (${request.reason})` });
  const declined = await answerAskAsync(request, fakePopup('deny').env);
  assert.equal(declined.decision, 'deny');
  assert.equal(declined.outcome, 'deny');
});

test('a full wait with no answer -> allow with outcome "timeout"; a timeout reported early is "dialog-failed"', async () => {
  let clock = 0;
  const waited = await answerAskAsync(request, fakePopup('timeout').env, { now: () => (clock += FULL_WAIT_STEP_MS) });
  assert.equal(waited.outcome, 'timeout');
  assert.equal(waited.decision, 'allow');
  const early = await answerAskAsync(request, fakePopup('timeout').env);
  assert.equal(early.outcome, 'dialog-failed');
  assert.equal(early.decision, 'ask');
});

test('no GUI or a platform with no dialog tool: decision "ask", no popup started', async () => {
  const popup = fakePopup('hang');
  assert.equal((await answerAskAsync(request, { ...popup.env, SSH_CONNECTION: 'x' })).outcome, 'no-gui');
  assert.equal((await answerAskAsync(request, popup.env, { platform: 'freebsd' })).outcome, 'no-gui');
  assert.equal(popup.pid(), undefined);
});

test('an abort while the popup is open kills it and reports "closed" (the terminal was answered)', async () => {
  const popup = fakePopup('hang');
  const controller = new AbortController();
  const pending = answerAskAsync(request, popup.env, { signal: controller.signal });
  assert.ok(await until(popup.alive), 'the popup opened');
  controller.abort();
  const result = await pending;
  assert.equal(result.decision, 'ask');
  assert.equal(result.outcome, 'closed');
  assert.ok(await until(() => !popup.alive()), 'the popup process is gone');
});

test('a signal that is already aborted opens no popup', async () => {
  const popup = fakePopup('hang');
  const result = await answerAskAsync(request, popup.env, { signal: AbortSignal.abort() });
  assert.equal(result.outcome, 'closed');
  assert.equal(popup.pid(), undefined);
});

test('closeLiveDialogs kills a popup that is still open (Claude Code stopped the hook)', async () => {
  const popup = fakePopup('hang');
  const pending = answerAskAsync(request, popup.env);
  assert.ok(await until(popup.alive));
  closeLiveDialogs();
  assert.equal((await pending).outcome, 'closed');
  assert.ok(await until(() => !popup.alive()));
});
