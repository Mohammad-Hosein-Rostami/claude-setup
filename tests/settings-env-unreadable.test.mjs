// Tests for the no-Fable gate of home/hooks/agent-model-guard.mjs on settings files it cannot read (lib/settings-env.mjs): a user or
// project settings file that exists but is not a readable settings object denies every Agent call, naming the file; a missing file,
// and a file where the `.claude` folder should be, are no settings; a SendMessage call is not touched. Each test has its own temp
// home and project folder (tests/settings-env-helpers.mjs); the hook runs as a process with the hook JSON on stdin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { FROM_AGENT } from './agent-call-origin.mjs';
import {
  FABLE_ID, FIX_THE_FILE, OPUS_VAR, assertRuns, denyReason, devCall, guardSetup, helperCall, localFile, runHook, sharedFile, userFile,
  writeSettings,
} from './settings-env-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const OPUS_CALL = devCall({ model: 'opus' }); // a good model and a pinned type: only the settings can deny it
const MAX_SETTINGS_BYTES = 1024 * 1024; // lib/settings-env.mjs reads at most 1 MiB
const ALIAS_NOTE = `${OPUS_VAR} points a model alias at \`${FABLE_ID}\``;
const UNREADABLE_NOTE = 'cannot be read';
const SEND_MESSAGE = { to: 'agent-dev-1', message: 'go on' };

// Settings content that is not a readable settings object, written as the file's text.
const BROKEN_CONTENTS = {
  'broken JSON': `{"env": {"${OPUS_VAR}": "x"`,
  'an array root': JSON.stringify([{ env: {} }]),
  'a null root': 'null',
  'an empty file': '',
  'env as text': JSON.stringify({ env: `${OPUS_VAR}=x` }),
  'env null': JSON.stringify({ env: null }),
  'env an array': JSON.stringify({ env: [] }),
  'an env value null': JSON.stringify({ env: { [OPUS_VAR]: null } }),
  'an env value an object': JSON.stringify({ env: { [OPUS_VAR]: { model: 'x' } } }),
  'an env value an array': JSON.stringify({ env: { [OPUS_VAR]: ['x'] } }),
  'valid JSON over 1 MiB': JSON.stringify({ env: {}, padding: 'x'.repeat(MAX_SETTINGS_BYTES) }),
};

/** Asserts a deny that names `file` as the settings file that cannot be read and says to fix it. */
function assertUnreadableDeny(out, file, label) {
  const reason = denyReason(out, label);
  assert.ok(reason.includes(`settings file \`${file}\` ${UNREADABLE_NOTE}`), `${label}: ${reason}`);
  assert.ok(reason.includes(FIX_THE_FILE), `${label}: ${reason}`);
}

/** Makes a FIFO at `path`; false where mkfifo is not available (Windows). */
function makeFifo(path) {
  mkdirSync(dirname(path), { recursive: true });
  return spawnSync('mkfifo', [path]).status === 0;
}

test('a user settings file that is not a readable settings object denies every Agent call, naming the file', () => {
  for (const [label, content] of Object.entries(BROKEN_CONTENTS)) {
    const setup = guardSetup();
    writeSettings(userFile(setup), content);
    assertUnreadableDeny(runHook(setup, OPUS_CALL), userFile(setup), `${label}: dev with model opus`);
    assertUnreadableDeny(runHook(setup, helperCall, FROM_AGENT), userFile(setup), `${label}: a general-purpose helper`);
  }
});

test('a folder named settings.json where the user settings file should be denies every Agent call, naming it', () => {
  const setup = guardSetup();
  mkdirSync(userFile(setup));
  assertUnreadableDeny(runHook(setup, OPUS_CALL), userFile(setup), 'dev with model opus');
  assertUnreadableDeny(runHook(setup, helperCall, FROM_AGENT), userFile(setup), 'a general-purpose helper');
});

const fifoSetup = guardSetup();
const hasFifo = makeFifo(userFile(fifoSetup));

test('a FIFO as the user settings file denies at once (never waits on it), naming it', { skip: !hasFifo && 'mkfifo is not available' }, () => {
  assertUnreadableDeny(runHook(fifoSetup, OPUS_CALL), userFile(fifoSetup), 'dev with model opus');
});

test('a shared or local project settings file that cannot be read denies every Agent call, naming that file', () => {
  for (const fileOf of [sharedFile, localFile]) {
    for (const [label, content] of Object.entries({ 'broken JSON': BROKEN_CONTENTS['broken JSON'], 'env null': BROKEN_CONTENTS['env null'] })) {
      const setup = guardSetup();
      const file = fileOf(setup.project);
      writeSettings(file, content);
      assertUnreadableDeny(runHook(setup, OPUS_CALL), file, `${file}, ${label}`);
      assertUnreadableDeny(runHook(setup, helperCall, FROM_AGENT), file, `${file}, ${label}: a helper`);
    }
  }
});

test('an unreadable user settings file does not touch a SendMessage call (regression guard: only Agent calls are gated)', () => {
  const setup = guardSetup();
  writeSettings(userFile(setup), BROKEN_CONTENTS['broken JSON']);
  assert.equal(runHook(setup, SEND_MESSAGE, { tool_name: 'SendMessage' }), null);
});

test('no settings files at all, and settings files with no env key or an empty env, let a normal call run (regression guard)', () => {
  assertRuns(runHook(guardSetup(), OPUS_CALL), 'no files');
  for (const content of [{}, { env: {} }, { permissions: { allow: [] } }]) {
    const setup = guardSetup();
    for (const file of [userFile(setup), sharedFile(setup.project), localFile(setup.project)]) writeSettings(file, content);
    assertRuns(runHook(setup, OPUS_CALL), JSON.stringify(content));
  }
});

test('a file where the project .claude folder should be is no settings: the user file still decides, never as unreadable', () => {
  const setup = guardSetup();
  writeFileSync(join(setup.project, '.claude'), 'not a folder');
  writeSettings(userFile(setup), { env: { [OPUS_VAR]: FABLE_ID } });
  const reason = denyReason(runHook(setup, OPUS_CALL));
  assert.ok(reason.includes(ALIAS_NOTE), reason);
});

test('a file where the user config folder should be is no settings: the local project file still decides, never as unreadable', () => {
  const setup = guardSetup();
  const configAsFile = join(makeTempDir('settings-env-config-file-'), 'config');
  writeFileSync(configAsFile, 'not a folder');
  setup.env.CLAUDE_CONFIG_DIR = configAsFile;
  writeSettings(localFile(setup.project), { env: { [OPUS_VAR]: FABLE_ID } });
  const reason = denyReason(runHook(setup, OPUS_CALL));
  assert.ok(reason.includes(ALIAS_NOTE), reason);
});
