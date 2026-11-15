// Tests for --save safety (never replace an env file or follow a link), for FIFOs (never opened), and for paths that hold
// control characters (they must not forge lines of the report).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { leaked, makeProject, run } from './env-names-fixtures.mjs';

const OUTSIDE = (dir) => join(dir, '..', `outside-${Math.random().toString(36).slice(2)}.txt`);

test('--save to an env file name is refused in every case and the real file is untouched', async () => {
  const dir = await makeProject({ '.env': 'KEEP=MARKER_VALUE\n' });
  for (const target of ['.env', 'new.env', '.env.snapshot', '.env.json']) {
    for (const extra of [[], ['--overwrite']]) {
      const result = run(['list', dir, '--save', join(dir, target), ...extra]);
      assert.equal(result.status, 2, `${target} ${extra}`);
      assert.match(result.stderr, /env-file-like name/);
    }
  }
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEEP=MARKER_VALUE\n');
});

test('--save never replaces an existing path; --overwrite replaces a regular file only', async () => {
  const dir = await makeProject({ '.env': 'A=1\n', 'before.json': 'old snapshot\n' });
  const target = join(dir, 'before.json');
  const refused = run(['list', dir, '--save', target]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refusing to save over .* it exists/);
  assert.equal(await readFile(target, 'utf8'), 'old snapshot\n');
  assert.equal(run(['list', dir, '--save', target, '--overwrite']).status, 0);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).version, 1);
});

test('--save through a symlink (live or dangling) is refused, with and without --overwrite; the link target is untouched', async () => {
  const dir = await makeProject({ '.env': 'A=1\n' });
  const outside = OUTSIDE(dir);
  await writeFile(outside, 'precious\n');
  await symlink(outside, join(dir, 'live.json'));
  await symlink(`${outside}.missing`, join(dir, 'dangling.json'));
  for (const link of ['live.json', 'dangling.json']) {
    for (const extra of [[], ['--overwrite']]) {
      assert.equal(run(['list', dir, '--save', join(dir, link), ...extra]).status, 2, `${link} ${extra}`);
    }
  }
  assert.equal(await readFile(outside, 'utf8'), 'precious\n');
});

test('a FIFO is never opened: diff <fifo> and --save <fifo> exit 2 at once, and a FIFO named .env is listed, not read', async () => {
  const dir = await makeProject({ 'proj/.keep': '' });
  const fifo = join(dir, 'pipe.json');
  if (spawnSync('mkfifo', [fifo]).status !== 0) return; // a platform without mkfifo has nothing to open
  const options = { encoding: 'utf8', timeout: 8000 };
  const cli = new URL('../home/tools/env-names/env-names.mjs', import.meta.url).pathname;
  const asSnapshot = spawnSync(process.execPath, [cli, 'diff', fifo, join(dir, 'proj')], options);
  assert.equal(asSnapshot.status, 2, 'diff <fifo> must not hang');
  assert.match(asSnapshot.stderr, /not a regular file/);
  for (const extra of [[], ['--overwrite']]) {
    const saved = spawnSync(process.execPath, [cli, 'list', join(dir, 'proj'), '--save', fifo, ...extra], options);
    assert.equal(saved.status, 2, `--save <fifo> ${extra} must not hang`);
  }
  assert.equal(spawnSync('mkfifo', [join(dir, 'proj/.env')]).status, 0);
  const listed = spawnSync(process.execPath, [cli, 'list', join(dir, 'proj')], options);
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /\.env {2}\(not a regular file, not read\)/);
});

test('a symlinked snapshot is refused rather than followed', async () => {
  const dir = await makeProject({ 'proj/.env': 'A=1\n' });
  const real = join(dir, 'real.json');
  assert.equal(run(['list', join(dir, 'proj'), '--save', real]).status, 0);
  await symlink(real, join(dir, 'link.json'));
  const result = run(['diff', join(dir, 'link.json'), join(dir, 'proj')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a regular file/);
});

test('control characters in a folder name never forge report lines, in list, diff or an error message', async () => {
  const evil = 'evil\nNow undefined (9):\n  FORGED  x:1\n\u001b[2J\u0085';
  const dir = await makeProject({ [`${evil}/.env`]: 'A=MARKER_VALUE\n', [`${evil}/a.ts`]: 'process.env.B;\n' });
  const listed = run(['list', dir]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.doesNotMatch(listed.stdout, /\u001b|\u0085/);
  assert.ok(listed.stdout.split('\n').every((line) => !line.startsWith('Now undefined') && !line.startsWith('  FORGED')));
  assert.match(listed.stdout, /evil\?Now undefined \(9\):\?/);
  const snapshot = join(dir, '..', `snap-evil-${Math.random().toString(36).slice(2)}.json`);
  assert.equal(run(['list', dir, '--save', snapshot]).status, 0);
  const diffed = run(['diff', snapshot, dir]);
  assert.match(diffed.stdout, /no changes/);
  const error = run(['list', join(dir, `${evil}/a.ts`)]);
  assert.equal(error.status, 2);
  assert.doesNotMatch(error.stderr, /\u001b|\n.*FORGED/);
  assert.deepEqual(leaked(listed.all + diffed.all + error.all), []);
});
