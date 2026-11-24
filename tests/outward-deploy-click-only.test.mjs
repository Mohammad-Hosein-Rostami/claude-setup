// Tests for max's click-only rule at the Bash guard hook (plan M2b, case 3; owner: max never acts outward by itself and its popups
// never auto-allow): an outward ask from max runs only after a click on Allow. A full timeout, a failed or killed dialog and no GUI
// deny; CLAUDE_GUARD_ASK=allow (in the env or only in the user settings file) still opens the dialog; a non-outward ask from max keeps
// today's timed allow and its CLAUDE_GUARD_ASK=allow skip. Every hook runs with a fake dialog tool and a temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerAsk } from '../home/hooks/lib/timed-ask.mjs';
import { fakeDialog, hookAnswer, isolatedEnv, MAX_AGENT, REAL_TIMEOUT, runGuard, shownText } from './outward-deploy-helpers.mjs';

const MAX = { agent_type: 'max', agent_id: MAX_AGENT };
const DEPLOY = 'kubectl apply -f x';
const DEPLOY_REASON = 'kubectl apply deploys or changes live infrastructure; confirm with the owner';
const OWN_NOTE = 'an outward action from max runs only after a click on Allow';
const notRun = (head) => `${head}; ${OWN_NOTE}, so it did not run (${DEPLOY_REASON})`;
// A non-outward ask: rm -r outside the project (the temp HOME is not /etc). Nothing runs: the guard only reads the string.
const LOCAL_ASK = 'rm -rf /etc/zq-guard-test';
const NO_GUI_ENVS = [['SSH_CONNECTION', '10.0.0.1 50000 10.0.0.2 22'], ['SSH_TTY', '/dev/ttys001'], ['CI', 'true'], ['NODE_TEST_CONTEXT', 'child-v8']];

const guardLine = (dialog) => dialog.log().find((line) => line.hook === 'pre-bash-guard' && line.decision !== undefined);

/** Writes `{"env": {...}}` as the user settings file under the temp HOME (the hook reads it when the env does not set the switch). */
function writeUserSettings(home, env) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env }));
}

test('max deploy: a click on Allow lets it run (no decision), and the dialog says no answer does not run it', () => {
  const dialog = fakeDialog('allow');
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'allow', reason: '' });
  assert.match(shownText(dialog), new RegExp(`it does not run \\(${OWN_NOTE}\\)\\.`));
  assert.equal(guardLine(dialog).outcome, 'allow');
});

test('max deploy: a click on Deny denies', () => {
  const dialog = fakeDialog('deny');
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: `denied by the owner in the dialog (${DEPLOY_REASON})` });
});

test('max deploy: a full timeout denies instead of going ahead', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s') });
  assert.equal(guardLine(dialog).outcome, 'timeout');
});

test('max deploy: a failed, killed or early-timeout dialog denies instead of falling back to Claude Code\'s prompt', () => {
  for (const result of ['fail', 'kill', 'timeout']) { // a "timeout" answered at once is not believed: the dialog failed
    const dialog = fakeDialog(result);
    assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: notRun('the dialog failed') }, result);
    assert.equal(guardLine(dialog).outcome, 'dialog-failed', result);
  }
});

test('max deploy: with no GUI (ssh, CI, a test runner) it denies and opens no dialog', () => {
  for (const [name, value] of NO_GUI_ENVS) {
    const dialog = fakeDialog('allow', { [name]: value });
    assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: notRun('no dialog can be shown here') }, name);
    assert.equal(dialog.opened(), false, name);
    assert.equal(guardLine(dialog).outcome, 'no-gui', name);
  }
});

test('max deploy on Linux with no DISPLAY or WAYLAND_DISPLAY denies as no GUI (answerAsk on the linux platform)', () => {
  const request = { hook: 'pre-bash-guard', tool: 'Bash', reason: DEPLOY_REASON, command: DEPLOY, outward: true, agentType: 'max' };
  assert.deepEqual(answerAsk(request, isolatedEnv(), 'linux'), { decision: 'deny', outcome: 'no-gui', reason: notRun('no dialog can be shown here') });
});

test('max deploy: CLAUDE_GUARD_ASK=allow in the env still opens the dialog, and its timeout still denies', () => {
  const dialog = fakeDialog('timeout', { ...REAL_TIMEOUT, CLAUDE_GUARD_ASK: 'allow' });
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s') });
  assert.equal(dialog.opened(), true);
});

test('max deploy: CLAUDE_GUARD_ASK=allow only in the user settings file still opens the dialog, and its timeout still denies', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeUserSettings(dialog.env.HOME, { CLAUDE_GUARD_ASK: 'allow' });
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s') });
  assert.equal(dialog.opened(), true);
});

test('max deploy: CLAUDE_GUARD_ASK=allow does not turn a Deny click into an allow', () => {
  const dialog = fakeDialog('deny', { CLAUDE_GUARD_ASK: 'allow' });
  assert.equal(hookAnswer(runGuard(DEPLOY, dialog.env, MAX)).decision, 'deny');
});

test('max, other outward asks (git push, npm publish) follow the same rule: a full timeout denies', () => {
  for (const command of ['git push origin main', 'npm publish']) {
    const dialog = fakeDialog('timeout', REAL_TIMEOUT);
    const { decision, reason } = hookAnswer(runGuard(command, dialog.env, MAX));
    assert.equal(decision, 'deny', command);
    assert.match(reason, new RegExp(`^no answer in 1 s; ${OWN_NOTE}, so it did not run \\(`), command);
  }
});

test('max, non-outward ask: a full timeout still goes ahead as today (no click-only line in the dialog)', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  assert.deepEqual(hookAnswer(runGuard(LOCAL_ASK, dialog.env, MAX)), { decision: 'allow', reason: '' });
  assert.doesNotMatch(shownText(dialog), /it does not run/);
  assert.equal(guardLine(dialog).outcome, 'timeout');
});

test('max, non-outward ask: with no GUI it falls back to Claude Code\'s prompt as today, not a deny', () => {
  const dialog = fakeDialog('allow', { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' });
  assert.equal(hookAnswer(runGuard(LOCAL_ASK, dialog.env, MAX)).decision, 'ask');
});

test('max, non-outward ask: CLAUDE_GUARD_ASK=allow (env or settings file) still skips its dialog', () => {
  const inEnv = fakeDialog('deny', { CLAUDE_GUARD_ASK: 'allow' });
  assert.deepEqual(hookAnswer(runGuard(LOCAL_ASK, inEnv.env, MAX)), { decision: 'allow', reason: '' });
  assert.equal(inEnv.opened(), false);
  assert.equal(guardLine(inEnv).outcome, 'switch-allow');
  const inFile = fakeDialog('deny');
  writeUserSettings(inFile.env.HOME, { CLAUDE_GUARD_ASK: 'allow' });
  assert.deepEqual(hookAnswer(runGuard(LOCAL_ASK, inFile.env, MAX)), { decision: 'allow', reason: '' });
  assert.equal(inFile.opened(), false);
});

test('no max anywhere: a deploy from the main session keeps the timed allow (a full timeout goes ahead)', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env)), { decision: 'allow', reason: '' });
  assert.doesNotMatch(shownText(dialog), /it does not run/);
});
