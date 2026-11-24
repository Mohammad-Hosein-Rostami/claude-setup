// Tests for the CLAUDE_GUARD_ASK switch of home/hooks/lib/timed-ask.mjs as lib/settings-env.mjs envValue reads it: the hook env first,
// else the user settings file only; a project's own settings files never turn it on, and a user file that is not a readable settings
// object leaves it off. Every test writes its settings into fresh temp folders, never the real ~/.claude. The dialog tool is the fake
// popup of fake-dialog-tool.mjs (first on PATH), so no real dialog opens; its pid file tells whether a dialog was shown at all.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerAsk } from '../home/hooks/lib/timed-ask.mjs';
import { fakePopup } from './fake-dialog-tool.mjs';
import { localFile, sharedFile, writeSettings } from './settings-env-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SWITCH = 'CLAUDE_GUARD_ASK';
const SETTINGS_FILE = 'settings.json';
const SWITCH_ON = { env: { [SWITCH]: 'allow' } };
const SWITCH_ASK = { env: { [SWITCH]: 'ask' } };
const MAX_SETTINGS_BYTES = 1024 * 1024; // lib/settings-env.mjs reads at most 1 MiB
const LOCATION_VARS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', SWITCH];
// The fake popup answers with these labels on macOS, so the request names them as its buttons (the switch ignores buttons).
const POPUP_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };

/**
 * One hook run: a fresh config dir holding `user` as its settings.json (undefined: no file), a fresh project folder (CLAUDE_PROJECT_DIR
 * and the request's cwd), the fake popup on PATH answering `popupResult`, and `hookSwitch` as the hook env's switch (undefined: unset).
 */
function askRun({ popupResult = 'deny', user, hookSwitch } = {}) {
  const configDir = makeTempDir('settings-env-ask-config-');
  const project = makeTempDir('settings-env-ask-proj-');
  if (user !== undefined) writeSettings(join(configDir, SETTINGS_FILE), user);
  const popup = fakePopup(popupResult);
  const env = { ...popup.env };
  for (const name of LOCATION_VARS) delete env[name];
  Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, CLAUDE_PROJECT_DIR: project, HOME: makeTempDir('settings-env-ask-home-') });
  if (hookSwitch !== undefined) env[SWITCH] = hookSwitch;
  const request = { hook: 'pre-bash-guard', tool: 'Bash', reason: 'a command that asks', command: 'make clean-cache', cwd: project, sessionId: 'settings-env-ask-1', buttons: POPUP_BUTTONS };
  return { env, project, request, ask: (extra = {}) => answerAsk({ ...request, ...extra }, env), dialogShown: () => popup.pid() !== undefined };
}

/** Asserts the switch allowed at once: outcome switch-allow and no dialog shown. */
function assertSwitchAllow(answer, run, label) {
  assert.deepEqual([answer.decision, answer.outcome], ['allow', 'switch-allow'], label);
  assert.equal(run.dialogShown(), false, `${label}: no dialog`);
}

/** Asserts the switch was off: the dialog was shown and its Deny decided (the popup answers deny). */
function assertDialogDeny(answer, run, label) {
  assert.deepEqual([answer.decision, answer.outcome], ['deny', 'deny'], label);
  assert.equal(run.dialogShown(), true, `${label}: the dialog was shown`);
}

test('ask switch: the hook env wins over the user file in both directions (regression guard)', () => {
  const asks = askRun({ user: SWITCH_ON, hookSwitch: 'ask' });
  assertDialogDeny(asks.ask(), asks, 'hook ask, file allow');
  const allows = askRun({ user: SWITCH_ASK, hookSwitch: 'allow' });
  assertSwitchAllow(allows.ask(), allows, 'hook allow, file ask');
});

test('ask switch: the user file alone turns it on (regression guard)', () => {
  const run = askRun({ user: SWITCH_ON });
  assertSwitchAllow(run.ask(), run, 'user file allow');
});

test('ask switch: allow in the project settings.json or settings.local.json alone never turns it on (regression guard)', () => {
  for (const fileOf of [sharedFile, localFile]) {
    const run = askRun();
    writeSettings(fileOf(run.project), SWITCH_ON);
    assertDialogDeny(run.ask(), run, fileOf(run.project));
  }
});

test('ask switch: an outward request still gets the dialog when the user file says allow (regression guard)', () => {
  const run = askRun({ popupResult: 'allow', user: SWITCH_ON });
  const answer = run.ask({ reason: 'git push goes to a remote', command: 'git push origin main', outward: true });
  assert.deepEqual([answer.decision, answer.outcome], ['allow', 'allow'], 'the owner clicked accept, not the switch');
  assert.equal(run.dialogShown(), true);
});

test('ask switch: a user file that lists allow but is not a readable settings object leaves it off', () => {
  const contents = {
    'another env value null': JSON.stringify({ env: { [SWITCH]: 'allow', OTHER: null } }),
    'another env value an object': JSON.stringify({ env: { [SWITCH]: 'allow', OTHER: { x: 1 } } }),
    'over 1 MiB': JSON.stringify({ env: { [SWITCH]: 'allow' }, padding: 'x'.repeat(MAX_SETTINGS_BYTES) }),
  };
  for (const [label, user] of Object.entries(contents)) {
    const run = askRun({ user });
    assertDialogDeny(run.ask(), run, label);
  }
});

test('ask switch: a broken project settings file does not change the switch either way (regression guard)', () => {
  const on = askRun({ user: SWITCH_ON });
  writeSettings(sharedFile(on.project), '{');
  writeSettings(localFile(on.project), 'null');
  assertSwitchAllow(on.ask(), on, 'user allow, broken project files');
  const off = askRun();
  writeSettings(sharedFile(off.project), '{');
  assertDialogDeny(off.ask(), off, 'no user file, broken project file');
});
