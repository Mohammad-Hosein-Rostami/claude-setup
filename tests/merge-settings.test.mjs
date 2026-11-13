// Tests for scripts/merge-settings.jq: permission lists are de-duplicated unions, hooks append, other arrays replace.
// Skips with a reason when jq is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const FILTER = fileURLToPath(new URL('../scripts/merge-settings.jq', import.meta.url));
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const skip = HAS_JQ ? false : 'jq not installed';

/** Merge the given settings objects through the real jq filter and return the parsed result. */
async function merge(...docs) {
  const dir = await mkdtemp(join(tmpdir(), 'merge-settings-'));
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
