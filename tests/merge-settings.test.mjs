// Tests for scripts/merge-settings.jq: permission lists are de-duplicated unions, hooks append, other arrays replace.
// Skips with a reason when jq is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const FILTER = fileURLToPath(new URL('../scripts/merge-settings.jq', import.meta.url));
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const skip = HAS_JQ ? false : 'jq not installed';

/** Merge the given settings objects through the real jq filter and return the parsed result. */
async function merge(...docs) {
  const dir = makeTempDir('merge-settings-');
  const files = [];
  for (const [index, doc] of docs.entries()) {
    const file = join(dir, `${index}.json`);
    await writeFile(file, JSON.stringify(doc));
    files.push(file);
  }
  const result = spawnSync('jq', ['-s', '-f', FILTER, ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('permissions lists are a de-duplicated union in base, os, local order', { skip }, async () => {
  const merged = await merge(
    { permissions: { allow: ['A', 'B'], deny: ['X'] } },
    { permissions: { allow: ['B', 'C'] } },
    { permissions: { allow: ['D', 'A'], ask: ['Q'], deny: ['Y'] } },
  );
  assert.deepEqual(merged.permissions.allow, ['A', 'B', 'C', 'D']);
  assert.deepEqual(merged.permissions.deny, ['X', 'Y']);
  assert.deepEqual(merged.permissions.ask, ['Q']);
});

test('other permission keys merge deeply and other arrays replace', { skip }, async () => {
  const merged = await merge(
    { permissions: { defaultMode: 'plan', allow: ['A'] }, list: [1, 2], nested: { a: 1 } },
    { permissions: { defaultMode: 'default' }, list: [3], nested: { b: 2 } },
  );
  assert.equal(merged.permissions.defaultMode, 'default');
  assert.deepEqual(merged.permissions.allow, ['A']);
  assert.deepEqual(merged.list, [3]);
  assert.deepEqual(merged.nested, { a: 1, b: 2 });
});

test('hooks append per event across files', { skip }, async () => {
  const merged = await merge({ hooks: { Stop: [{ id: 1 }] } }, { hooks: { Stop: [{ id: 2 }], Start: [{ id: 3 }] } });
  assert.deepEqual(merged.hooks.Stop, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(merged.hooks.Start, [{ id: 3 }]);
});

test('null or non-object permissions in a later file keep the base rules', { skip }, async () => {
  const merged = await merge(
    { permissions: { allow: ['A'], deny: ['X'] } },
    { permissions: null },
    { permissions: 'oops', other: 1 },
  );
  assert.deepEqual(merged.permissions, { allow: ['A'], deny: ['X'] });
  assert.equal(merged.other, 1);
});

test('base.json askUserQuestionTimeout is a value the CLI accepts (others are dropped silently)', () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../settings/base.json', import.meta.url)), 'utf8'));
  assert.ok(['60s', '5m', '10m', 'never'].includes(base.askUserQuestionTimeout), String(base.askUserQuestionTimeout));
});

test('base.json registers git-tidy-gate on Stop, SubagentStop and PreCompact, each with a timeout that covers its 4 s check', () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../settings/base.json', import.meta.url)), 'utf8'));
  for (const event of ['Stop', 'SubagentStop', 'PreCompact']) {
    const gates = base.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command.includes('hooks/git-tidy-gate.mjs'));
    assert.equal(gates.length, 1, `${event} has exactly one git-tidy-gate entry`);
    assert.ok(gates[0].timeout >= 10, `${event} timeout ${gates[0].timeout}`);
  }
});

test('additionalDirectories is a de-duplicated union, so a local file cannot drop the shared workflows folder', { skip }, async () => {
  const merged = await merge(
    { permissions: { additionalDirectories: ['/home/x/.claude/workflows'] } },
    { permissions: { additionalDirectories: ['/data', '/home/x/.claude/workflows'] } },
  );
  assert.deepEqual(merged.permissions.additionalDirectories, ['/home/x/.claude/workflows', '/data']);
});

test('base.json raises the Bash default timeout to 5 minutes (300000 ms) so a suite is not moved to the background', () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../settings/base.json', import.meta.url)), 'utf8'));
  assert.equal(base.env.BASH_DEFAULT_TIMEOUT_MS, '300000');
});

const readSettings = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../settings/${name}`, import.meta.url)), 'utf8'));

test('base.json starts agent worktrees from the local HEAD (worktree.baseRef head)', () => {
  assert.deepEqual(readSettings('base.json').worktree, { baseRef: 'head' });
});

test('the merged settings of every OS keep worktree.baseRef head', { skip }, async () => {
  for (const osFile of ['macos.json', 'windows.json', 'linux.json']) {
    const merged = await merge(readSettings('base.json'), readSettings(osFile), readSettings('local.json.example'));
    assert.equal(merged.worktree.baseRef, 'head', osFile);
  }
});

test('base.json blocks the Bash call when the guard hook dies or times out (onFailure block), and its timeout covers the 2-min dialog', () => {
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('../settings/base.json', import.meta.url)), 'utf8'));
  const bash = base.hooks.PreToolUse.filter((group) => (group.matcher ?? '').split('|').includes('Bash')).flatMap((group) => group.hooks);
  const guards = bash.filter((hook) => hook.command.includes('hooks/pre-bash-guard.mjs'));
  assert.equal(guards.length, 1, 'exactly one pre-bash-guard entry');
  assert.equal(guards[0].onFailure, 'block', 'a crashed or stalled guard must not let the command run');
  assert.ok(guards[0].timeout > 120, `timeout ${guards[0].timeout}: the timed dialog waits 120 s, and a timeout now blocks`);
});
