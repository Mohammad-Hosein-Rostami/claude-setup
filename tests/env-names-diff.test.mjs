// Tests for `env-names.mjs diff`: the snapshot round trip, every diff section, the "Now undefined" ordering, "same names as"
// for moved env files, exit codes, and the refusal of a bad snapshot (exit 2, plain reason, never file content).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { leaked, makeProject, run } from './env-names-fixtures.mjs';

const BASE = {
  '.env': 'KEEP=MARKER_VALUE\nWILL_GO=MARKER_VALUE\nSHARED=1\n',
  'apps/web/.env.local': 'WEB_ONE=MARKER_VALUE\nWEB_TWO=2\n',
  'src/app.ts': 'process.env.KEEP;\nprocess.env.WILL_GO;\n',
  'Dockerfile': 'ARG BUILD_ONE\n',
};

async function snapshotOf(dir) {
  const file = join(dir, '..', `snap-${Math.random().toString(36).slice(2)}.json`);
  const saved = run(['list', dir, '--save', file]);
  assert.equal(saved.status, 0, saved.stderr);
  return file;
}
const change = async (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(dir, path));
    else {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  }
};
const titles = (result) => result.stdout.split('\n').filter((line) => /^[A-Z].*\(\d+\):$/.test(line));

test('round trip: list --save then diff exits 0 and says no changes', async () => {
  const dir = await makeProject(BASE);
  const result = run(['diff', await snapshotOf(dir), dir]);
  assert.equal(result.status, 0, result.all);
  assert.match(result.stdout, /no changes/);
});

test('diff against the current folder by default', async () => {
  const dir = await makeProject(BASE);
  assert.equal(run(['diff', await snapshotOf(dir)], dir).status, 0);
});

test('env files added and removed, names added and removed in a file; exit 1', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { '.env': 'KEEP=MARKER_VALUE\nNEW_NAME=MARKER_VALUE\nSHARED=1\n', 'apps/web/.env.local': null, '.env.test': 'T=1\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Env files added \(1\):\n {2}\.env\.test\n/);
  assert.match(result.stdout, /Env files removed \(1\):\n {2}apps\/web\/\.env\.local\n/);
  assert.match(result.stdout, /Names changed in env files \(1\):\n {2}\.env {2}\+NEW_NAME -WILL_GO\n/);
  assert.deepEqual(leaked(result.all), []);
});

test('names read by code and in deploy files, added and removed, with file:line', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { 'src/app.ts': 'const x = 1;\nprocess.env.KEEP;\nprocess.env.ADDED_READ;\n', Dockerfile: 'ENV ADDED_DEPLOY=MARKER_VALUE\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Names read by code added \(1\):\n {2}ADDED_READ {2}src\/app\.ts:3\n/);
  assert.match(result.stdout, /Names read by code removed \(1\):\n {2}WILL_GO {2}src\/app\.ts:2\n/);
  assert.match(result.stdout, /Names in deploy files added \(1\):\n {2}ADDED_DEPLOY {2}Dockerfile:1\n/);
  assert.match(result.stdout, /Names in deploy files removed \(1\):\n {2}BUILD_ONE {2}Dockerfile:1\n/);
});

test('Now undefined comes first: a name code still reads that an env file defined before and none defines now', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { '.env': 'KEEP=1\nSHARED=1\n', '.env.test': 'EXTRA=1\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.deepEqual(titles(result)[0], 'Now undefined (1):');
  assert.match(result.stdout, /Now undefined \(1\):\n {2}WILL_GO {2}src\/app\.ts:2 \(was defined in \.env\)\n/);
  assert.ok(result.stdout.indexOf('Now undefined') < result.stdout.indexOf('Env files added'));
});

test('a name nobody read before and no env file defines is not "Now undefined"', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { 'src/new.ts': 'process.env.NEVER_DEFINED;\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Now undefined/);
});

test('a moved env file is removed + added, with a "same names as" line on both', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await mkdir(join(dir, 'packages/web'), { recursive: true });
  await rename(join(dir, 'apps/web/.env.local'), join(dir, 'packages/web/.env.local'));
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Env files added \(1\):\n {2}packages\/web\/\.env\.local\n {4}same names as apps\/web\/\.env\.local\n/);
  assert.match(result.stdout, /Env files removed \(1\):\n {2}apps\/web\/\.env\.local\n {4}same names as packages\/web\/\.env\.local\n/);
});

test('two files with different names get no "same names as" line', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { 'apps/web/.env.local': null, 'other/.env': 'DIFFERENT=1\n' });
  assert.doesNotMatch(run(['diff', snapshot, dir]).stdout, /same names as/);
});

test('--json prints the diff structure', async () => {
  const dir = await makeProject(BASE);
  const snapshot = await snapshotOf(dir);
  await change(dir, { '.env': 'KEEP=1\nSHARED=1\n' });
  const result = run(['diff', snapshot, dir, '--json']);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed, true);
  assert.deepEqual(parsed.nowUndefined.map((entry) => entry.name), ['WILL_GO']);
  assert.deepEqual(parsed.namesChanged, [{ path: '.env', added: [], removed: ['WILL_GO'] }]);
});

test('the wrapper list is saved in the snapshot and diff uses it; a different --wrapper is a usage error', async () => {
  const dir = await makeProject({ ...BASE, 'src/w.ts': "getEnvVariable('VIA_WRAPPER');\n" });
  const file = join(dir, '..', `snap-wrapper-${Math.random().toString(36).slice(2)}.json`);
  assert.equal(run(['list', dir, '--save', file, '--wrapper', 'getEnvVariable']).status, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).wrappers, ['getEnvVariable']);
  assert.equal(run(['diff', file, dir]).status, 0, 'no false "removed" when the snapshot already had the wrapper');
  assert.equal(run(['diff', file, dir, '--wrapper', 'getEnvVariable']).status, 0);
  const different = run(['diff', file, dir, '--wrapper', 'otherFn']);
  assert.equal(different.status, 2);
  assert.match(different.stderr, /saved with --wrapper getEnvVariable/);
  const plain = await snapshotOf(dir);
  assert.equal(run(['diff', plain, dir, '--wrapper', 'getEnvVariable']).status, 2);
});

async function badSnapshot(content) {
  const dir = await makeProject({ 'snapshot.json': content, 'proj/.env': 'A=1\n' });
  return run(['diff', join(dir, 'snapshot.json'), join(dir, 'proj')]);
}

test('a bad snapshot is refused with exit 2 and a plain reason', async () => {
  const good = { version: 2, root: '/x', generatedAt: '2026-01-01T00:00:00.000Z', envFiles: [], readByCode: {}, deploy: {} };
  const cases = [
    ['not json {', /not valid JSON/],
    ['[]', /not an object/],
    [JSON.stringify({ ...good, version: 3 }), /version is not 2/],
    [JSON.stringify({ ...good, version: 1 }), /older snapshots may hold fragments/],
    [JSON.stringify({ ...good, version: undefined }), /version is not 2/],
    [JSON.stringify({ ...good, envFiles: {} }), /envFiles/],
    [JSON.stringify({ ...good, envFiles: [{ path: 'a', names: ['bad name'], otherLines: 0 }] }), /envFiles/],
    [JSON.stringify({ ...good, envFiles: [{ path: 'a', names: [], otherLines: 'x' }] }), /envFiles/],
    [JSON.stringify({ ...good, readByCode: { 'bad-name': ['a:1'] } }), /readByCode/],
    [JSON.stringify({ ...good, readByCode: { OK: 'a:1' } }), /readByCode/],
    [JSON.stringify({ ...good, deploy: [] }), /deploy/],
    ['', /not valid JSON/],
  ];
  for (const [content, reason] of cases) {
    const result = await badSnapshot(content);
    assert.equal(result.status, 2, `${content} -> ${result.status}`);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, '');
  }
});

test('a missing snapshot, a folder as snapshot and no snapshot argument are exit 2', async () => {
  const dir = await makeProject({ 'proj/.env': 'A=1\n' });
  assert.equal(run(['diff', join(dir, 'nope.json'), join(dir, 'proj')]).status, 2);
  assert.match(run(['diff', join(dir, 'nope.json'), join(dir, 'proj')]).stderr, /cannot read snapshot .*\(ENOENT\)/);
  assert.equal(run(['diff', dir, join(dir, 'proj')]).status, 2);
  assert.equal(run(['diff']).status, 2);
  assert.equal(run(['diff', 'a', 'b', 'c']).status, 2);
});

test('an env file given as the snapshot is refused and none of its content is printed', async () => {
  const dir = await makeProject({ '.env': 'API_URL=https://MARKER_VALUE.example\nMARKER_VALUE_LINE\n{"version": "MARKER_VALUE"}\n', 'proj/.env': 'A=1\n' });
  const result = run(['diff', join(dir, '.env'), join(dir, 'proj')]);
  assert.equal(result.status, 2);
  assert.deepEqual(leaked(result.all), []);
});

test('a snapshot that is JSON but holds a value where a version belongs does not echo it', async () => {
  const result = await badSnapshot(JSON.stringify({ version: 'MARKER_VALUE', envFiles: 'MARKER_VALUE' }));
  assert.equal(result.status, 2);
  assert.deepEqual(leaked(result.all), []);
});
