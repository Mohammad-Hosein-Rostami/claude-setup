// Tests for the owner's bypass-permissions layer: a settings/local.json that sets `permissions.defaultMode: "bypassPermissions"`
// merges over base.json and the OS file without dropping a hook or a deny rule, so every hook of the shared settings stays
// registered. Exports: none (node:test file). The merge is the real scripts/merge-settings.jq; needs jq.
// That base.json itself sets the mode is pinned by settings-full-access.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SETTINGS = fileURLToPath(new URL('../settings', import.meta.url));
const FILTER = fileURLToPath(new URL('../scripts/merge-settings.jq', import.meta.url));
const skip = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';
const OWNER_LAYER = { skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'bypassPermissions' } };
const HOOKS = ['git-tidy-gate.mjs', 'disk-clean-start.mjs', 'project-merge.mjs', 'post-edit.mjs', 'notify.mjs'];

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
    for (const hook of HOOKS) assert.ok(commands.includes(`hooks/${hook}`), hook);
  });
}
