// Tests for the settings-file lookup of the CLAUDE_GUARD_ASK switch (home/hooks/lib/timed-ask.mjs): when the hook's own env lacks the
// variable, `env.CLAUDE_GUARD_ASK` of $CLAUDE_CONFIG_DIR/settings.json (else HOME or USERPROFILE + /.claude/settings.json) decides.
// Every test writes its settings into fresh temp folders, never the real ~/.claude. The dialog tool is the fake popup of
// fake-dialog-tool.mjs (first on PATH), so no real dialog opens; its pid file tells whether a dialog was shown at all.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { answerAsk, askOwner } from '../home/hooks/lib/timed-ask.mjs';
import { fakePopup } from './fake-dialog-tool.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const TIMED_ASK_URL = new URL('../home/hooks/lib/timed-ask.mjs', import.meta.url).href;
// The documented names (home/hooks/README.md), written out so a renamed constant or file fails here.
const SWITCH = 'CLAUDE_GUARD_ASK';
const SETTINGS_FILE = 'settings.json';
const CONFIG_FOLDER = '.claude';
const SWITCH_ON = { env: { [SWITCH]: 'allow' } };
const SWITCH_ASK = { env: { [SWITCH]: 'ask' } };
const LOCATION_VARS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', SWITCH];
// The fake popup answers with these labels on macOS, so the request names them as its buttons (the switch ignores buttons).
const POPUP_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };
const PROJECT = resolve('/work/proj');
const request = { hook: 'pre-bash-guard', tool: 'Bash', reason: 'a command that asks', command: 'make clean-cache', cwd: PROJECT, sessionId: 'session-settings-1', buttons: POPUP_BUTTONS };
const outwardRequest = { ...request, reason: 'git push goes to a remote', command: 'git push origin main', outward: true };

/** Writes `content` (an object as JSON, a string as it is) to `<dir>/settings.json`; undefined writes no file. */
function writeSettings(dir, content) {
  if (content === undefined) return;
  writeFileSync(join(dir, SETTINGS_FILE), typeof content === 'string' ? content : JSON.stringify(content));
}

/** @returns {string} a fresh config dir (CLAUDE_CONFIG_DIR) holding `content` as its settings.json */
function configDirWith(content) {
  const dir = makeTempDir('guard-ask-config-');
  writeSettings(dir, content);
  return dir;
}

/** @returns {string} a fresh home folder holding `content` as .claude/settings.json */
function homeWith(content) {
  const home = makeTempDir('guard-ask-home-');
  mkdirSync(join(home, CONFIG_FOLDER));
  writeSettings(join(home, CONFIG_FOLDER), content);
  return home;
}

/**
 * The env of one hook run with the fake popup on PATH. HOME, USERPROFILE, CLAUDE_CONFIG_DIR and CLAUDE_GUARD_ASK come only from
 * `vars` (an absent or undefined one is removed), so the runner's own values never leak in.
 * @returns {{env: Record<string, string | undefined>, dialogShown: () => boolean, log: () => object[]}}
 */
function hookRun(popupResult, vars) {
  const popup = fakePopup(popupResult);
  const env = { ...popup.env };
  for (const name of LOCATION_VARS) delete env[name];
  for (const [name, value] of Object.entries(vars)) if (value !== undefined) env[name] = value;
  return {
    env,
    dialogShown: () => popup.pid() !== undefined,
    log: () => readFileSync(env.CLAUDE_GUARD_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
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

test('settings file switch: allow in $CLAUDE_CONFIG_DIR/settings.json and no switch in the hook env allows at once, with no dialog', () => {
  const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith() });
  assertSwitchAllow(answerAsk(request, run.env), run, 'answerAsk');
});

test('settings file switch: askOwner prints no decision and logs switch-allow when only the settings file says allow', () => {
  const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith() });
  assert.equal(askOwner(request, run.env), '');
  assert.equal(run.dialogShown(), false);
  assert.deepEqual(run.log().map((line) => [line.decision, line.outcome]), [['allow', 'switch-allow']]);
});

test('settings file switch: a hook env that sets the switch at all wins over the file (empty, off, deny keep the dialog; allow wins over ask)', () => {
  for (const hookSwitch of ['', 'off', 'deny']) {
    const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith(), [SWITCH]: hookSwitch });
    assertDialogDeny(answerAsk(request, run.env), run, `hook env ${SWITCH}=${JSON.stringify(hookSwitch)}`);
  }
  const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ASK), HOME: homeWith(), [SWITCH]: 'allow' });
  assertSwitchAllow(answerAsk(request, run.env), run, 'hook env allow, file ask');
});

test('settings file switch: any file value other than env.CLAUDE_GUARD_ASK = "allow" is off', () => {
  const contents = [
    SWITCH_ASK,
    { env: { [SWITCH]: true } },
    { env: { [SWITCH]: ['allow'] } },
    { env: { nested: { [SWITCH]: 'allow' } } },
    { [SWITCH]: 'allow' }, // at the top level, not under env
    { env: `${SWITCH}=allow` },
  ];
  for (const content of contents) {
    const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(content), HOME: homeWith() });
    assertDialogDeny(answerAsk(request, run.env), run, JSON.stringify(content));
  }
});

test('settings file switch: a broken, empty, array or null file, a missing file or folder, and a folder named settings.json are off, never a throw', () => {
  const missingDir = join(makeTempDir('guard-ask-gone-'), 'absent');
  const folderAsFile = makeTempDir('guard-ask-folder-');
  mkdirSync(join(folderAsFile, SETTINGS_FILE));
  const configDirs = {
    'broken JSON': configDirWith(`{"env": {"${SWITCH}": "allow"`),
    'empty file': configDirWith(''),
    array: configDirWith([SWITCH_ON]),
    null: configDirWith('null'),
    'missing config dir': missingDir,
    'config dir with no settings.json': configDirWith(),
    'settings.json is a folder': folderAsFile,
  };
  for (const [label, configDir] of Object.entries(configDirs)) {
    const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDir, HOME: homeWith() });
    assertDialogDeny(answerAsk(request, run.env), run, label);
  }
});

test('settings file switch: an outward request still gets the dialog when the file says allow', () => {
  const run = hookRun('allow', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith() });
  const answer = answerAsk(outwardRequest, run.env);
  assert.deepEqual([answer.decision, answer.outcome], ['allow', 'allow'], 'the owner clicked accept, not the switch');
  assert.equal(run.dialogShown(), true);
});

test('settings file switch: a Deny in the dialog stays a deny when the file says allow (answerAsk and askOwner)', () => {
  const asked = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith() });
  assertDialogDeny(answerAsk(outwardRequest, asked.env), asked, 'answerAsk');
  const owner = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith() });
  const out = JSON.parse(askOwner(outwardRequest, owner.env)).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(owner.log().map((line) => [line.decision, line.outcome]), [['deny', 'deny']]);
});

test('settings file switch: with no CLAUDE_CONFIG_DIR the file under HOME, else USERPROFILE, applies; with neither nor a config dir it is off', () => {
  const byHome = hookRun('deny', { HOME: homeWith(SWITCH_ON) });
  assertSwitchAllow(answerAsk(request, byHome.env), byHome, 'HOME/.claude/settings.json');
  const byProfile = hookRun('deny', { USERPROFILE: homeWith(SWITCH_ON) });
  assertSwitchAllow(answerAsk(request, byProfile.env), byProfile, 'USERPROFILE/.claude/settings.json');
  const nowhere = hookRun('deny', {});
  assertDialogDeny(answerAsk(request, nowhere.env), nowhere, 'no HOME, USERPROFILE or CLAUDE_CONFIG_DIR');
});

test('settings file switch: CLAUDE_CONFIG_DIR wins over the file under HOME, in both directions', () => {
  const silent = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith({ env: {} }), HOME: homeWith(SWITCH_ON) });
  assertDialogDeny(answerAsk(request, silent.env), silent, 'config dir without the switch, HOME allow');
  const noFile = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(), HOME: homeWith(SWITCH_ON) });
  assertDialogDeny(answerAsk(request, noFile.env), noFile, 'config dir without settings.json, HOME allow');
  const allows = hookRun('deny', { CLAUDE_CONFIG_DIR: configDirWith(SWITCH_ON), HOME: homeWith(SWITCH_ASK) });
  assertSwitchAllow(answerAsk(request, allows.env), allows, 'config dir allow, HOME ask');
});

// One hook run is one node process: it calls answerAsk, the settings file then changes, and it calls answerAsk again.
const TWO_ASKS = `
import { writeFileSync } from 'node:fs';
import { answerAsk } from ${JSON.stringify(TIMED_ASK_URL)};
const [file, changed, asked] = process.argv.slice(1);
const request = JSON.parse(asked);
const first = answerAsk(request, process.env).outcome;
writeFileSync(file, changed);
const second = answerAsk(request, process.env).outcome;
process.stdout.write(JSON.stringify([first, second]));
`;

test('settings file switch: the file is read at most once per hook run; the next run reads it again', () => {
  const configDir = configDirWith(SWITCH_ON);
  const file = join(configDir, SETTINGS_FILE);
  const hookProcess = () => {
    const run = hookRun('deny', { CLAUDE_CONFIG_DIR: configDir, HOME: homeWith() });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', TWO_ASKS, file, JSON.stringify(SWITCH_ASK), JSON.stringify(request)], { encoding: 'utf8', env: run.env });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(hookProcess(), ['switch-allow', 'switch-allow'], 'the second ask keeps the value read first');
  assert.deepEqual(hookProcess(), ['deny', 'deny'], 'a new hook run sees the changed file');
});
