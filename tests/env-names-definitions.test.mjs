// Tests for what "defined" means: example files define nothing, a read is defined by env files in its own folder chain (its
// folder and the parents), and an env file that stopped being readable is reported as such instead of making names "undefined".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeProject, run } from './env-names-fixtures.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const change = async (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(dir, path));
    else {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  }
};
const snapshotOf = (dir) => {
  const file = join(makeTempDir('sibling-'), `snap-def-${Math.random().toString(36).slice(2)}.json`);
  assert.equal(run(['list', dir, '--save', file]).status, 0);
  return file;
};

test('list: a name only an example file holds is "defined in no env file", with the example named', async () => {
  const dir = await makeProject({ '.env.example': 'NEEDS_ENV=\n', '.env': 'OTHER=1\n', 'src/a.ts': 'process.env.NEEDS_ENV;\n' });
  const result = run(['list', dir]);
  assert.match(result.stdout, /Read by code but defined in no env file \(1\):\n {2}NEEDS_ENV {2}src\/a\.ts:1 {2}\(only in example file: \.env\.example\)\n/);
  assert.match(result.stdout, /Example files \(1\):\n {2}\.env\.example {2}\(1 name\)\n/);
  assert.match(result.stdout, /env-names: 1 env files, 1 defined names/);
});

test('list: every example file pattern counts as an example, and an example file is not counted as an env file', async () => {
  const files = { '.env': 'A=1\n' };
  for (const name of ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.prod.sample']) files[name] = 'B=1\n';
  const result = run(['list', await makeProject(files)]);
  assert.match(result.stdout, /Env files \(1\):/);
  assert.match(result.stdout, /Example files \(5\):/);
});

test('list: a name defined only in another folder is the second list, with the files that define it; a root env file covers everything below', async () => {
  const dir = await makeProject({
    'apps/web/.env': 'WEB_ONLY=1\n',
    '.env': 'ROOT_VAR=1\n',
    'apps/api/server.js': 'process.env.WEB_ONLY;\nprocess.env.ROOT_VAR;\n',
    'apps/web/src/page.ts': 'process.env.WEB_ONLY;\n',
  });
  const result = run(['list', dir]);
  assert.match(result.stdout, /Read by code, defined only outside its folder chain \(look at these\) \(1\):\n {2}WEB_ONLY {2}apps\/api\/server\.js:1 {2}\(defined in apps\/web\/\.env\)\n/);
  assert.match(result.stdout, /Read by code but defined in no env file \(0\):/);
});

test('diff: a name dropped from .env but still in .env.example is now undefined', async () => {
  const dir = await makeProject({ '.env': 'KEEP=1\nWILL_GO=1\n', '.env.example': 'KEEP=\nWILL_GO=\n', 'src/a.ts': 'process.env.KEEP;\nprocess.env.WILL_GO;\n' });
  const snapshot = snapshotOf(dir);
  await change(dir, { '.env': 'KEEP=1\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Now undefined \(1\):\n {2}WILL_GO {2}src\/a\.ts:2 \(was defined in \.env\)\n/);
});

test('diff: a name that only an example file held before is not "now undefined" when it disappears', async () => {
  const dir = await makeProject({ '.env': 'KEEP=1\n', '.env.example': 'ONLY_EXAMPLE=\n', 'src/a.ts': 'process.env.ONLY_EXAMPLE;\n' });
  const snapshot = snapshotOf(dir);
  await change(dir, { '.env.example': null });
  assert.doesNotMatch(run(['diff', snapshot, dir]).stdout, /Now undefined/);
});

test('diff: a name that moved to another app folder is reported as moved out of the reader\'s chain, not as undefined', async () => {
  const dir = await makeProject({ 'apps/web/.env': 'WEB_VAR=1\n', 'apps/api/.env': 'API_VAR=1\n', 'apps/web/src/x.ts': 'process.env.WEB_VAR;\n' });
  const snapshot = snapshotOf(dir);
  await change(dir, { 'apps/web/.env': 'NOTHING=1\n', 'apps/api/.env': 'API_VAR=1\nWEB_VAR=1\n' });
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Now undefined/);
  assert.match(result.stdout, /Definition moved out of the reader's folder chain \(look at these\) \(1\):\n {2}WEB_VAR {2}apps\/web\/src\/x\.ts:1 \(was in apps\/web\/\.env, now in apps\/api\/\.env\)\n/);
});

test('diff: an env file turned into a link or a binary file is "no longer read", and its names are not undefined', async () => {
  const dir = await makeProject({ '.env': 'A=1\nB=1\n', 'web/.env': 'C=1\n', 'src/a.ts': 'process.env.A;process.env.B;process.env.C;\n', 'target.txt': 'A=1\n' });
  const snapshot = snapshotOf(dir);
  await rm(join(dir, '.env'));
  await symlink(join(dir, 'target.txt'), join(dir, '.env'));
  await writeFile(join(dir, 'web/.env'), Buffer.from([67, 61, 49, 0, 0]));
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Env files no longer read \(2\):\n {2}\.env {2}link, not read\n {2}web\/\.env {2}binary, not read\n/);
  assert.doesNotMatch(result.stdout, /Now undefined|Names changed/);
});

test('diff: a file that was not read and is read now causes no names report from the old side', async () => {
  const dir = await makeProject({ '.env': 'A=1\n' });
  await rename(join(dir, '.env'), join(dir, 'moved.txt'));
  await symlink(join(dir, 'moved.txt'), join(dir, '.env'));
  const snapshot = snapshotOf(dir);
  await rm(join(dir, '.env'));
  await rename(join(dir, 'moved.txt'), join(dir, '.env'));
  const result = run(['diff', snapshot, dir]);
  assert.equal(result.status, 0, result.stdout);
});
