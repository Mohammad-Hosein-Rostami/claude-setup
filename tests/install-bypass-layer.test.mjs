// Tests for the owner's bypass-permissions layer: a settings/local.json that sets `permissions.defaultMode: "bypassPermissions"`
// (the owner's own machines; teammates keep the timed allow of settings/base.json) merges over base.json and the OS file without
// dropping a hook or a deny rule, so every guard (pre-bash-guard, agent-budget, agent-model-guard, artifact-ask) and the
// timed-allow hook stay registered. Exports: none (node:test file). The merge is the real scripts/merge-settings.jq; needs jq.
// Whether Claude Code honours a hook's deny and ask in that mode is a live fact: scripts/doctor-live.sh step_bypass checks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SETTINGS = fileURLToPath(new URL('../settings', import.meta.url));
const FILTER = fileURLToPath(new URL('../scripts/merge-settings.jq', import.meta.url));
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';
const OWNER_LAYER = { skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'bypassPermissions' } };
const GUARDS = ['pre-bash-guard.mjs', 'agent-budget.mjs', 'agent-model-guard.mjs', 'artifact-ask.mjs', 'permission-timed-allow.mjs'];

/** base.json, then the OS file when it exists, then `local` (when given), through the real merge. */
function merged(os, local) {
  const files = [join(SETTINGS, 'base.json'), join(SETTINGS, `${os}.json`)].filter((file) => existsSync(file));
  if (local) {
    const file = join(makeTempDir('bypass-layer-'), 'local.json');
    writeFileSync(file, JSON.stringify(local));
    files.push(file);
  }
  const run = spawnSync('jq', ['-s', '-f', FILTER, ...files], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

/** Every hook command of the merged settings, by event. */
const hookCommands = (settings) => Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.flatMap((group) => group.hooks.map((hook) => hook.command))]));

for (const os of ['macos', 'linux', 'windows']) {
  test(`${os}: the owner's bypass layer sets the mode and keeps every hook and deny rule of the shared settings`, { skip }, () => {
    const shared = merged(os, null);
    const owner = merged(os, OWNER_LAYER);
    assert.equal(owner.permissions.defaultMode, 'bypassPermissions');
    assert.equal(owner.skipDangerousModePermissionPrompt, true);
    assert.deepEqual(hookCommands(owner), hookCommands(shared), 'the same hooks, in the same order');
    assert.deepEqual(owner.permissions.deny, shared.permissions.deny);
    const commands = Object.values(hookCommands(owner)).flat().join('\n');
    for (const guard of GUARDS) assert.ok(commands.includes(`hooks/${guard}`), guard);
  });
}

test('the shared settings set no bypass mode: teammates keep the timed allow', () => {
  const base = JSON.parse(readFileSync(join(SETTINGS, 'base.json'), 'utf8'));
  assert.equal(base.permissions?.defaultMode, undefined);
  assert.ok(JSON.stringify(base.hooks.PermissionRequest).includes('permission-timed-allow.mjs'));
});
