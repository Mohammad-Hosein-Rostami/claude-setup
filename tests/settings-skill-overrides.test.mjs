// Tests for the `skillOverrides` of settings/base.json: the eight built-in skills that only the owner starts, and that the settings
// merge (base + OS layer) keeps them. Read-only on the repo; the merge skips with a reason when jq is not installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OS_NAME } from '../scripts/install/context.mjs';
import { mergedSettings } from '../scripts/install/settings.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BASE_SETTINGS = fileURLToPath(new URL('../settings/base.json', import.meta.url));
const OWNER_ONLY = 'user-invocable-only';
const OVERRIDDEN_SKILLS = [
  'code-review', 'fewer-permission-prompts', 'init', 'keybindings-help', 'security-review', 'ship-local', 'steward', 'update-config',
];
const hasJq = spawnSync('jq', ['--version']).status === 0 ? false : 'jq not installed';

const expected = Object.fromEntries(OVERRIDDEN_SKILLS.map((skill) => [skill, OWNER_ONLY]));

test('settings/base.json skillOverrides has exactly the eight skills, each user-invocable-only', () => {
  const { skillOverrides } = JSON.parse(readFileSync(BASE_SETTINGS, 'utf8'));
  assert.deepEqual(Object.keys(skillOverrides ?? {}).sort(), OVERRIDDEN_SKILLS);
  assert.deepEqual(skillOverrides, expected);
});

test('the merged settings (base and OS layer) keep skillOverrides', { skip: hasJq }, () => {
  const claudeDir = makeTempDir('skill-overrides-');
  // repo is an empty temp folder, so a settings/local.json of the machine running the test cannot change the result
  const merged = mergedSettings({ root: REPO, repo: claudeDir, os: OS_NAME, claudeDir }, null);
  assert.deepEqual(merged.skillOverrides, expected);
});
