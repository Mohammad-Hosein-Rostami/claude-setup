// Tests for max's click-only rule at the Artifact hook (plan M2b, case 3): a publish or delete from max runs only after a click on
// Allow (a timeout, a failed dialog and no GUI deny; CLAUDE_GUARD_ASK=allow still opens the dialog), and with no max running the
// other agents (dev, lex, tess) and the main session keep today's timed allow at the Artifact hook and at the Bash guard.
// Every hook runs with a fake dialog tool and a temp HOME; nothing is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideArtifact } from '../home/hooks/artifact-ask.mjs';
import { fakeDialog, hookAnswer, MAX_AGENT, REAL_TIMEOUT, runArtifact, runGuard, shownText } from './outward-deploy-helpers.mjs';

const MAX = { agent_type: 'max', agent_id: MAX_AGENT };
const PUBLISH = { action: 'publish', file_path: '/x/a.html' };
const DELETE = { action: 'delete', url: 'https://claude.ai/artifact/1' };
const PUBLISH_REASON = decideArtifact(PUBLISH);
const OWN_NOTE = 'an outward action from max runs only after a click on Allow';
const notRun = (head, reason = PUBLISH_REASON) => `${head}; ${OWN_NOTE}, so it did not run (${reason})`;
const OTHER_CALLERS = [['dev', { agent_type: 'dev', agent_id: 'agentdev0001' }], ['lex', { agent_type: 'lex', agent_id: 'agentlex0001' }],
  ['tess', { agent_type: 'tess', agent_id: 'agenttess001' }], ['the main session', {}]];
const DEPLOY = 'terraform apply';

const artifactLine = (dialog) => dialog.log().find((line) => line.hook === 'artifact-ask');

test('Artifact publish reason is the hook\'s own fixed text (sanity for the rows below)', () => {
  assert.equal(PUBLISH_REASON, 'Artifact publish creates a hosted page');
});

test('max Artifact publish: a click on Allow lets it run, and the dialog says no answer does not run it', () => {
  const dialog = fakeDialog('allow');
  assert.deepEqual(hookAnswer(runArtifact(PUBLISH, dialog.env, MAX)), { decision: 'allow', reason: '' });
  assert.match(shownText(dialog), new RegExp(`it does not run \\(${OWN_NOTE}\\)\\.`));
});

test('max Artifact publish: a click on Deny denies', () => {
  const dialog = fakeDialog('deny');
  assert.deepEqual(hookAnswer(runArtifact(PUBLISH, dialog.env, MAX)), { decision: 'deny', reason: `denied by the owner in the dialog (${PUBLISH_REASON})` });
});

test('max Artifact publish and delete: a full timeout denies instead of going ahead', () => {
  for (const input of [PUBLISH, DELETE]) {
    const dialog = fakeDialog('timeout', REAL_TIMEOUT);
    assert.deepEqual(hookAnswer(runArtifact(input, dialog.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s', decideArtifact(input)) }, input.action);
    assert.equal(artifactLine(dialog).outcome, 'timeout', input.action);
  }
});

test('max Artifact publish: a failed or killed dialog denies', () => {
  for (const result of ['fail', 'kill']) {
    const dialog = fakeDialog(result);
    assert.deepEqual(hookAnswer(runArtifact(PUBLISH, dialog.env, MAX)), { decision: 'deny', reason: notRun('the dialog failed') }, result);
  }
});

test('max Artifact publish: with no GUI it denies and opens no dialog', () => {
  for (const [name, value] of [['SSH_CONNECTION', '10.0.0.1 50000 10.0.0.2 22'], ['CI', 'true']]) {
    const dialog = fakeDialog('allow', { [name]: value });
    assert.deepEqual(hookAnswer(runArtifact(PUBLISH, dialog.env, MAX)), { decision: 'deny', reason: notRun('no dialog can be shown here') }, name);
    assert.equal(dialog.opened(), false, name);
  }
});

test('max Artifact publish: CLAUDE_GUARD_ASK=allow in the env or only in the user settings file still opens the dialog', () => {
  const inEnv = fakeDialog('timeout', { ...REAL_TIMEOUT, CLAUDE_GUARD_ASK: 'allow' });
  assert.deepEqual(hookAnswer(runArtifact(PUBLISH, inEnv.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s') });
  assert.equal(inEnv.opened(), true);
  const inFile = fakeDialog('timeout', REAL_TIMEOUT);
  mkdirSync(join(inFile.env.HOME, '.claude'), { recursive: true });
  writeFileSync(join(inFile.env.HOME, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_GUARD_ASK: 'allow' } }));
  assert.deepEqual(hookAnswer(runArtifact(PUBLISH, inFile.env, MAX)), { decision: 'deny', reason: notRun('no answer in 1 s') });
  assert.equal(inFile.opened(), true);
});

test('max Artifact read or list: no dialog and no decision', () => {
  for (const input of [{ action: 'read', url: 'https://claude.ai/artifact/1' }, { action: 'list' }]) {
    const dialog = fakeDialog('deny');
    assert.deepEqual(hookAnswer(runArtifact(input, dialog.env, MAX)), { decision: 'allow', reason: '' }, input.action);
    assert.equal(dialog.opened(), false, input.action);
  }
});

for (const [name, who] of OTHER_CALLERS) {
  test(`no max running: an Artifact publish from ${name} keeps the timed allow (a full timeout goes ahead)`, () => {
    const dialog = fakeDialog('timeout', REAL_TIMEOUT);
    assert.deepEqual(hookAnswer(runArtifact(PUBLISH, dialog.env, who)), { decision: 'allow', reason: '' });
    assert.match(shownText(dialog), /With no answer in 1 s it goes ahead\./);
    assert.equal(artifactLine(dialog).outcome, 'timeout');
  });

  test(`no max running: a deploy from ${name} keeps the timed allow at the Bash guard`, () => {
    const dialog = fakeDialog('timeout', REAL_TIMEOUT);
    assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, who)), { decision: 'allow', reason: '' });
    assert.match(shownText(dialog), /With no answer in 1 s it goes ahead\./);
  });
}

test('no max running: a deploy from dev still opens its dialog under CLAUDE_GUARD_ASK=allow (outward keeps the dialog)', () => {
  const dialog = fakeDialog('deny', { CLAUDE_GUARD_ASK: 'allow' });
  assert.equal(hookAnswer(runGuard(DEPLOY, dialog.env, OTHER_CALLERS[0][1])).decision, 'deny');
  assert.equal(dialog.opened(), true);
});
