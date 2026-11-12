// Tests for home/hooks/mode.mjs pure helpers and applyFastMode (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFastMode, isMode, isStale, parseModeArg } from '../home/hooks/mode.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function tempSettings(content) {
  const dir = await mkdtemp(join(tmpdir(), 'mode-test-'));
  const path = join(dir, 'settings.json');
  await writeFile(path, content);
  return path;
}

test('parseModeArg takes the first word, lowercased', () => {
  assert.equal(parseModeArg('  HIGH now'), 'high');
  assert.equal(parseModeArg(''), '');
  assert.equal(parseModeArg(undefined), '');
});

test('isMode accepts only the three modes', () => {
  assert.ok(isMode('normal') && isMode('medium') && isMode('high'));
  assert.ok(!isMode('bogus') && !isMode(undefined) && !isMode(''));
});

test('isStale flips after 14 days', () => {
  const now = Date.now();
  assert.equal(isStale(now - 13 * MS_PER_DAY, now), false);
  assert.equal(isStale(now - 15 * MS_PER_DAY, now), true);
});

test('applyFastMode turns fast mode on for high', async () => {
  const path = await tempSettings('{"model":"opus"}');
  assert.equal(await applyFastMode('high', path), 'applied');
  assert.equal(await readFile(path, 'utf8'), '{\n  "model": "opus",\n  "fastMode": true\n}\n');
});

test('applyFastMode removes the key for other modes', async () => {
  const path = await tempSettings('{"model":"opus","fastMode":true}');
  assert.equal(await applyFastMode('medium', path), 'applied');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { model: 'opus' });
});

test('applyFastMode does not write when unchanged', async () => {
  const path = await tempSettings('{"model":"opus"}');
  const before = (await stat(path)).mtimeMs;
  assert.equal(await applyFastMode('normal', path), 'unchanged');
  assert.equal((await stat(path)).mtimeMs, before);
});

test('applyFastMode leaves a malformed file untouched', async () => {
  const path = await tempSettings('{not json');
  assert.equal(await applyFastMode('high', path), 'failed');
  assert.equal(await readFile(path, 'utf8'), '{not json');
});

test('applyFastMode writes through a symlink and keeps the file mode', async () => {
  const real = await tempSettings('{"model":"opus"}');
  const PRIVATE_MODE = 0o600;
  await chmod(real, PRIVATE_MODE);
  const link = `${real}.link`;
  await symlink(real, link);
  assert.equal(await applyFastMode('high', link), 'applied');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(real, 'utf8')).fastMode, true);
  assert.equal((await stat(real)).mode & 0o777, PRIVATE_MODE);
});
