// Tests that the settings layers (settings/base.json and the OS files) keep the owner's full-access setup: bypass mode, no
// permission-gating hooks, no ask list, no sandbox, workflows off, and only hooks whose script exists under home/.
// Exports: none (node:test file). Reads the files as they are in the repo; nothing is merged or run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const LAYER_NAMES = ['base', 'macos', 'linux', 'windows'];
const layers = Object.fromEntries(LAYER_NAMES.map((name) => [name, JSON.parse(readFileSync(join(REPO, 'settings', `${name}.json`), 'utf8'))]));
const base = layers.base;
const BASE_HOOK_EVENTS = ['Notification', 'PostToolUse', 'SessionStart', 'StopFailure'];
const GATING_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest'];
const WORKFLOW_RULE = /workflow/i;
const HOME_PLACEHOLDER = '{{CLAUDE_HOME}}';
const HOME_SCRIPT = /\{\{CLAUDE_HOME\}\}\/([^"\s]+)/;
const ASK_TIMEOUT = '5m';

const hookCommands = (settings) =>
  Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));

test('base mode is bypassPermissions', () => {
  assert.equal(base.permissions.defaultMode, 'bypassPermissions');
});

for (const name of LAYER_NAMES) {
  test(`${name} layer has no PreToolUse or PermissionRequest hook`, () => {
    const events = Object.keys(layers[name].hooks ?? {});
    for (const gating of GATING_HOOK_EVENTS) assert.ok(!events.includes(gating), `${name}.json has a ${gating} hook`);
  });

  test(`${name} layer has no permissions.ask and no sandbox`, () => {
    assert.equal(layers[name].permissions?.ask, undefined);
    assert.equal(layers[name].sandbox, undefined);
  });

  test(`${name} layer denies nothing but a workflow rule`, () => {
    const deny = layers[name].permissions?.deny ?? [];
    for (const rule of deny) assert.match(rule, WORKFLOW_RULE);
  });
}

test('base hook events are exactly Notification, PostToolUse, SessionStart and StopFailure', () => {
  assert.deepEqual(Object.keys(base.hooks).sort(), BASE_HOOK_EVENTS);
});

test('workflows are off in settings and in the env block', () => {
  assert.equal(base.disableWorkflows, true);
  assert.equal(base.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
});

test('a question to the owner times out after 5 minutes', () => {
  assert.equal(base.askUserQuestionTimeout, ASK_TIMEOUT);
});

test('every hook command that names a script under home/ points at a file that exists', () => {
  const commands = LAYER_NAMES.flatMap((name) => hookCommands(layers[name]));
  const named = commands.filter((command) => command.includes(HOME_PLACEHOLDER));
  assert.ok(named.length > 0, 'precondition: some hook command names a script under home/');
  for (const command of named) {
    const script = command.match(HOME_SCRIPT)?.[1];
    assert.ok(script, `no script path in: ${command}`);
    assert.ok(existsSync(join(REPO, 'home', script)), `home/${script} is missing (hook: ${command})`);
  }
});
