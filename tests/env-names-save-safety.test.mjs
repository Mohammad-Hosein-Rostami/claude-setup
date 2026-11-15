// Tests for --save --overwrite (second audit): the env-file name check ignores letter case, an existing file is replaced only when
// it is a snapshot this tool saved, never through a symlink or a hard link to a real env file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { link, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProject, run } from './env-names-fixtures.mjs';

test('--save refuses env-file-like names in any letter case, with and without --overwrite', async () => {
  const dir = await makeProject({ '.env': 'KEEP=1\n', 'proj/.keep': '' });
  for (const name of ['.ENV', '.Env.Local', 'PROD.ENV', '.ENV.example']) {
    for (const extra of [[], ['--overwrite']]) {
      const result = run(['list', join(dir, 'proj'), '--save', join(dir, name), ...extra]);
      assert.equal(result.status, 2, `${name} ${extra}`);
      assert.match(result.stderr, /env-file-like name/);
    }
  }
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEEP=1\n');
});

test('--overwrite replaces a snapshot saved by this tool, creates a missing file, and refuses any other existing file', async () => {
  const dir = await makeProject({ 'proj/.env': 'A=1\n', 'notes.txt': 'my notes\n', 'package.json': '{"name":"x"}\n' });
  const target = join(dir, 'snap.json');
  assert.equal(run(['list', join(dir, 'proj'), '--save', target, '--overwrite']).status, 0, 'missing file is created');
  assert.equal(run(['list', join(dir, 'proj'), '--save', target, '--overwrite']).status, 0, 'a snapshot is replaced');
  assert.equal(JSON.parse(await readFile(target, 'utf8')).version, 2);
  for (const other of ['notes.txt', 'package.json']) {
    const result = run(['list', join(dir, 'proj'), '--save', join(dir, other), '--overwrite']);
    assert.equal(result.status, 2, other);
    assert.match(result.stderr, /not a snapshot saved by this tool/);
  }
  assert.equal(await readFile(join(dir, 'notes.txt'), 'utf8'), 'my notes\n');
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), '{"name":"x"}\n');
});

test('--overwrite through a hard link to a real env file or through a symlink is refused and nothing changes', async () => {
  const dir = await makeProject({ '.env': 'KEEP=1\n', 'proj/.keep': '', 'outside.json': '{"version":2,"envFiles":[]}\n' });
  await link(join(dir, '.env'), join(dir, 'hard.json'));
  await symlink(join(dir, 'outside.json'), join(dir, 'soft.json'));
  assert.equal(run(['list', join(dir, 'proj'), '--save', join(dir, 'hard.json'), '--overwrite']).status, 2);
  assert.equal(run(['list', join(dir, 'proj'), '--save', join(dir, 'soft.json'), '--overwrite']).status, 2);
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEEP=1\n');
  assert.equal(await readFile(join(dir, 'outside.json'), 'utf8'), '{"version":2,"envFiles":[]}\n');
});

test('a snapshot of version 1 is refused by diff with a plain message', async () => {
  const dir = await makeProject({ 'proj/.env': 'A=1\n', 'old.json': JSON.stringify({ version: 1, root: '/x', generatedAt: 'x', envFiles: [], readByCode: {}, deploy: {} }) });
  await writeFile(join(dir, 'unused.txt'), '');
  const result = run(['diff', join(dir, 'old.json'), join(dir, 'proj')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /older snapshots may hold fragments of values/);
});
