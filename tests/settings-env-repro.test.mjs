// Repro tests for three findings on the settings `env` reading of home/hooks/agent-model-guard.mjs (lib/settings-env.mjs,
// lib/agent-model-gates.mjs): R1 the model routing is dropped when the force is on under only one env the session may run with;
// R2 the force from one env and CLAUDE_CODE_SUBAGENT_MODEL from another are never checked together, so a Fable run passes;
// R3 an empty, whitespace-only or BOM-prefixed settings file, which Claude Code loads as settings, denies every Agent call.
// Each test has its own temp home and project folder (tests/settings-env-helpers.mjs); the hook runs as a process.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FROM_AGENT } from './agent-call-origin.mjs';
import {
  FABLE_ID, FORCE, SHIPPED_SUBAGENT_MODEL, SUBAGENT_MODEL, assertRuns, denyReason, devCall, guardSetup, helperCall, localFile, runHook,
  sharedFile, userFile, writeSettings,
} from './settings-env-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROUTED_MODEL = 'sonnet'; // what the routing adds to a general-purpose call with no model
const FORCED_TO_SONNET = { env: { [FORCE]: '1', [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } };
const UTF8_BOM = '﻿';

test('repro R1: force on only in the cwd folder settings (a clone under the project) keeps the sonnet routing of a general-purpose call', () => {
  const setup = guardSetup(); // the hook env has no force
  const clone = join(setup.project, 'clone');
  writeSettings(sharedFile(clone), FORCED_TO_SONNET);
  const out = runHook(setup, helperCall, { ...FROM_AGENT, cwd: clone });
  assert.equal(out?.updatedInput?.model, ROUTED_MODEL, `the routing must stay while the force may be off: ${JSON.stringify(out)}`);
});

test('R1 control: force on in the hook env itself adds no model to a general-purpose call', () => {
  const setup = guardSetup({ [FORCE]: '1' });
  writeSettings(sharedFile(join(setup.project, 'clone')), FORCED_TO_SONNET);
  assert.equal(runHook(setup, helperCall, { ...FROM_AGENT, cwd: join(setup.project, 'clone') }), null, 'the call runs as sent');
});

test('repro R2: force and a non-Fable model in the user settings, a Fable CLAUDE_CODE_SUBAGENT_MODEL in the hook env, deny a dev call', () => {
  const setup = guardSetup({ [SUBAGENT_MODEL]: FABLE_ID }); // no force in the hook env
  writeSettings(userFile(setup), FORCED_TO_SONNET);
  denyReason(runHook(setup, devCall()), 'force from the settings, the Fable model from the shell');
});

test('repro R2: force only in the start folder file and a Fable CLAUDE_CODE_SUBAGENT_MODEL only in another cwd folder file deny a dev call', () => {
  const setup = guardSetup();
  const cwd = makeTempDir('settings-env-repro-cwd-');
  writeSettings(sharedFile(setup.project), { env: { [FORCE]: '1' } });
  writeSettings(sharedFile(cwd), { env: { [SUBAGENT_MODEL]: FABLE_ID } });
  denyReason(runHook(setup, devCall(), { cwd }), 'force in CLAUDE_PROJECT_DIR, the Fable model in the cwd');
});

test('repro R3: an empty or whitespace-only user settings file is loaded as {} by Claude Code, so a normal dev call runs', () => {
  for (const content of ['', '  \n']) {
    const setup = guardSetup();
    writeSettings(userFile(setup), content);
    assertRuns(runHook(setup, devCall()), `user settings ${JSON.stringify(content)}`);
  }
});

test('repro R3: an empty project settings.local.json is loaded as {} by Claude Code, so a normal dev call runs', () => {
  const setup = guardSetup();
  writeSettings(localFile(setup.project), '');
  assertRuns(runHook(setup, devCall()), 'empty settings.local.json');
});

test("repro R3: a BOM-prefixed {\"env\":{}} user settings file runs a normal dev call (BOM, expected from Claude Code's reader)", () => {
  const setup = guardSetup();
  writeSettings(userFile(setup), `${UTF8_BOM}{"env":{}}`);
  assertRuns(runHook(setup, devCall()), 'BOM-prefixed settings.json');
});
