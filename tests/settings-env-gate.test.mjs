// Tests for the no-Fable gate of home/hooks/agent-model-guard.mjs on model variables set only in a settings file's `env`
// (lib/settings-env.mjs possibleEnvs): the user file, the shared project file (in CLAUDE_PROJECT_DIR and in the input cwd), the local
// file, and the main checkout's local file seen from a linked worktree; the hook env and the settings env each decide on their own;
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE from a settings file; values that are not text; odd paths and cwds. Each test has its own temp home
// and project folder (tests/settings-env-helpers.mjs); the hook runs as a process with the hook JSON on stdin.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FROM_AGENT } from './agent-call-origin.mjs';
import {
  ALIAS_TARGET_VARS, FABLE_ID, FORCE, FORCED_NOTE, NON_FABLE_ID, OPUS_VAR, SHIPPED_SUBAGENT_MODEL, SUBAGENT_MODEL, assertRuns, denyReason,
  devCall, guardSetup, helperCall, linkedWorktree, localFile, runHook, sharedFile, userFile, writeSettings,
} from './settings-env-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const OPUS_CALL = devCall({ model: 'opus' }); // a good model and a pinned type: only a Fable env can deny it
const aliasNote = (name, value) => `${name} points a model alias at \`${value}\``;

/**
 * Where a settings value can live. Each entry writes `settings` there for a fresh setup and returns the hook input fields of the call.
 * @type {Record<string, (setup: {project: string, env: object}, settings: object) => object>}
 */
const LOCATIONS = {
  'the user settings file': (setup, settings) => {
    writeSettings(userFile(setup), settings);
    return {};
  },
  'the shared project file in CLAUDE_PROJECT_DIR (the cwd elsewhere)': (setup, settings) => {
    writeSettings(sharedFile(setup.project), settings);
    return { cwd: makeTempDir('settings-env-elsewhere-') };
  },
  'the shared project file in the input cwd (CLAUDE_PROJECT_DIR elsewhere)': (setup, settings) => {
    const cwd = makeTempDir('settings-env-cwd-');
    writeSettings(sharedFile(cwd), settings);
    return { cwd };
  },
  'the local project file': (setup, settings) => {
    writeSettings(localFile(setup.project), settings);
    return {};
  },
  "the main checkout's local file, from a linked worktree": (setup, settings) => {
    const { main, worktree } = linkedWorktree();
    writeSettings(localFile(main), settings);
    setup.env.CLAUDE_PROJECT_DIR = worktree;
    return { cwd: worktree };
  },
};

test('precedence: a non-Fable alias variable in the hook env does not hide a Fable one in the user or local settings env', () => {
  for (const location of ['the user settings file', 'the local project file']) {
    const setup = guardSetup({ [OPUS_VAR]: NON_FABLE_ID });
    const extra = LOCATIONS[location](setup, { env: { [OPUS_VAR]: FABLE_ID } });
    const reason = denyReason(runHook(setup, OPUS_CALL, extra), location);
    assert.ok(reason.includes(aliasNote(OPUS_VAR, FABLE_ID)), `${location}: ${reason}`);
  }
});

test('precedence: a Fable alias variable in the hook env still denies when a settings env sets a non-Fable one', () => {
  for (const location of ['the user settings file', 'the local project file']) {
    const setup = guardSetup({ [OPUS_VAR]: FABLE_ID });
    const extra = LOCATIONS[location](setup, { env: { [OPUS_VAR]: NON_FABLE_ID } });
    const reason = denyReason(runHook(setup, OPUS_CALL, extra), location);
    assert.ok(reason.includes(aliasNote(OPUS_VAR, FABLE_ID)), `${location}: ${reason}`);
  }
});

test('each ANTHROPIC_DEFAULT_*_MODEL naming Fable in only one settings file denies a call with a good model, naming the variable', () => {
  for (const name of ALIAS_TARGET_VARS) {
    for (const [location, place] of Object.entries(LOCATIONS)) {
      const setup = guardSetup();
      const extra = place(setup, { env: { [name]: FABLE_ID } });
      const reason = denyReason(runHook(setup, OPUS_CALL, extra), `${name} in ${location}`);
      assert.ok(reason.includes(aliasNote(name, FABLE_ID)), `${name} in ${location}: ${reason}`);
    }
  }
});

test('each ANTHROPIC_DEFAULT_*_MODEL naming a non-Fable model in the same settings files lets the call run', () => {
  for (const name of ALIAS_TARGET_VARS) {
    for (const [location, place] of Object.entries(LOCATIONS)) {
      const setup = guardSetup();
      const extra = place(setup, { env: { [name]: NON_FABLE_ID } });
      assertRuns(runHook(setup, OPUS_CALL, extra), `${name} in ${location}`);
    }
  }
});

test('local over shared: a Fable value in the local file denies though the shared file sets a non-Fable one', () => {
  const setup = guardSetup();
  writeSettings(sharedFile(setup.project), { env: { [OPUS_VAR]: NON_FABLE_ID } });
  writeSettings(localFile(setup.project), { env: { [OPUS_VAR]: FABLE_ID } });
  assert.ok(denyReason(runHook(setup, OPUS_CALL)).includes(aliasNote(OPUS_VAR, FABLE_ID)));
});

test('FORCE=1 and a Fable CLAUDE_CODE_SUBAGENT_MODEL only in a settings file deny a dev call with no model, though its file pins opus', () => {
  for (const location of ['the user settings file', 'the local project file']) {
    const setup = guardSetup(); // the hook env keeps the shipped non-Fable CLAUDE_CODE_SUBAGENT_MODEL and no force
    const extra = LOCATIONS[location](setup, { env: { [FORCE]: '1', [SUBAGENT_MODEL]: FABLE_ID } });
    const reason = denyReason(runHook(setup, devCall(), extra), location);
    assert.ok(reason.includes(`${FORCED_NOTE}, so every agent runs on ${SUBAGENT_MODEL} \`${FABLE_ID}\``), `${location}: ${reason}`);
  }
});

test('FORCE=1 only in a settings file, with no CLAUDE_CODE_SUBAGENT_MODEL anywhere, denies a dev call with no model', () => {
  for (const location of ['the user settings file', 'the local project file']) {
    const setup = guardSetup({ [SUBAGENT_MODEL]: undefined });
    const extra = LOCATIONS[location](setup, { env: { [FORCE]: '1' } });
    const reason = denyReason(runHook(setup, devCall(), extra), location);
    assert.ok(reason.includes(`${FORCED_NOTE} and ${SUBAGENT_MODEL} names no model`), `${location}: ${reason}`);
  }
});

test('FORCE on only in the user settings file: the routing adds no model to a general-purpose call', () => {
  const setup = guardSetup();
  writeSettings(userFile(setup), { env: { [FORCE]: '1', [SUBAGENT_MODEL]: SHIPPED_SUBAGENT_MODEL } });
  assert.equal(runHook(setup, helperCall, FROM_AGENT), null, 'the call runs as sent, with no updatedInput');
});

test('types: FORCE written as JSON true or 1 in the user settings counts as on', () => {
  for (const force of [true, 1]) {
    const setup = guardSetup({ [SUBAGENT_MODEL]: undefined });
    writeSettings(userFile(setup), { env: { [FORCE]: force } });
    const reason = denyReason(runHook(setup, devCall()), JSON.stringify(force));
    assert.ok(reason.includes(FORCED_NOTE), `${JSON.stringify(force)}: ${reason}`);
  }
});

test('types: a Fable value in the settings env in any case or padded denies, naming the variable', () => {
  for (const value of [' Claude-FABLE-1 ', 'FABLE', 'fable\n']) {
    const setup = guardSetup();
    writeSettings(userFile(setup), { env: { [OPUS_VAR]: value } });
    const reason = denyReason(runHook(setup, OPUS_CALL), JSON.stringify(value));
    assert.ok(reason.includes(`${OPUS_VAR} points a model alias at`), `${JSON.stringify(value)}: ${reason}`);
  }
});

test('a project folder whose path has spaces, as CLAUDE_PROJECT_DIR and as cwd, has its settings read', () => {
  const setup = guardSetup();
  const spaced = join(makeTempDir('settings env spaced-'), 'my project');
  writeSettings(sharedFile(spaced), { env: { [OPUS_VAR]: FABLE_ID } });
  setup.env.CLAUDE_PROJECT_DIR = spaced;
  assert.ok(denyReason(runHook(setup, OPUS_CALL, { cwd: spaced }), 'both').includes(aliasNote(OPUS_VAR, FABLE_ID)));
  const byCwd = guardSetup();
  assert.ok(denyReason(runHook(byCwd, OPUS_CALL, { cwd: spaced }), 'cwd only').includes(aliasNote(OPUS_VAR, FABLE_ID)));
});

test('a cwd that is not text or is missing never throws: CLAUDE_PROJECT_DIR, else the user file alone, still decides', () => {
  for (const cwd of [42, null, ['x'], undefined]) {
    const byProject = guardSetup();
    writeSettings(sharedFile(byProject.project), { env: { [OPUS_VAR]: FABLE_ID } });
    const reason = denyReason(runHook(byProject, OPUS_CALL, { cwd }), `cwd ${JSON.stringify(cwd)}`);
    assert.ok(reason.includes(aliasNote(OPUS_VAR, FABLE_ID)), `cwd ${JSON.stringify(cwd)}: ${reason}`);
    const byUser = guardSetup({ CLAUDE_PROJECT_DIR: undefined });
    writeSettings(userFile(byUser), { env: { [OPUS_VAR]: FABLE_ID } });
    const userReason = denyReason(runHook(byUser, OPUS_CALL, { cwd }), `no project dir, cwd ${JSON.stringify(cwd)}`);
    assert.ok(userReason.includes(aliasNote(OPUS_VAR, FABLE_ID)), `no project dir, cwd ${JSON.stringify(cwd)}: ${userReason}`);
  }
});
