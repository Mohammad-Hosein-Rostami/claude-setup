// Tests for `env-names.mjs list`: what is collected (env files at any depth, code reads, deploy mentions), the four report
// sections, the summary line, --json / --save, exit codes. Runs the real CLI on temp folders built by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { leaked, makeProject, run } from './env-names-fixtures.mjs';

const lines = (result) => result.stdout.split('\n');
const section = (result, title) => {
  const all = lines(result);
  const start = all.findIndex((line) => line.startsWith(title));
  assert.notEqual(start, -1, `no section "${title}" in:\n${result.stdout}`);
  const body = [];
  for (let i = start + 1; i < all.length && all[i].startsWith('  '); i += 1) body.push(all[i].trim());
  return { header: all[start], body };
};

const PROJECT = {
  '.env': 'API_URL=https://MARKER_VALUE.example\nexport DB_HOST=MARKER_VALUE_db # MARKER_COMMENT\nONLY_ROOT=1\n',
  '.env.example': 'API_URL=\nDB_HOST=\nUNUSED_EXAMPLE=\n',
  'apps/web/.env.local': 'WEB_KEY=MARKER_VALUE\n',
  'apps/web/src/main.ts': "const a = process.env.API_URL;\nconst b = process.env.MISSING_ONE;\nconst c = import.meta.env.VITE_WEB;\nimport.meta.env.DEV;\nprocess.env[dynamicName];\n",
  'apps/api/server.js': "const d = process.env['MISSING_ONE'] + process.env.DB_HOST + getEnvVariable('WRAPPED_ONE');\n",
  'docker-compose.yml': 'services:\n  web:\n    environment:\n      - COMPOSE_ONLY=MARKER_COMPOSE\n      - WEB_KEY=MARKER_COMPOSE\n',
};

test('report: env files, the undefined list, the never-read list and the folder differences', async () => {
  const dir = await makeProject(PROJECT);
  const result = run(['list', dir, '--wrapper', 'getEnvVariable']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(section(result, 'Env files').header, 'Env files (2):');
  assert.deepEqual(section(result, 'Env files').body, ['.env  (3 names)', 'apps/web/.env.local  (1 name)']);
  assert.deepEqual(section(result, 'Example files').body, ['.env.example  (3 names)']);
  assert.deepEqual(section(result, 'Read by code but defined in no env file').body, ['MISSING_ONE  apps/api/server.js:1', 'VITE_WEB  apps/web/src/main.ts:3', 'WRAPPED_ONE  apps/api/server.js:1']);
  assert.deepEqual(section(result, 'Defined but never read').body, ['ONLY_ROOT  .env']); // an example file defines nothing
  assert.deepEqual(section(result, 'Names that differ').body, ['ONLY_ROOT  in .env; not in .env.example', 'UNUSED_EXAMPLE  in .env.example; not in .env']);
  assert.equal(lines(result).filter(Boolean).at(-1), 'env-names: 2 env files, 4 defined names, 5 names read by code, values never read');
});

test('report: Vite built-ins are listed apart and dynamic access is counted per file', async () => {
  const dir = await makeProject(PROJECT);
  const result = run(['list', dir]);
  assert.match(result.stdout, /Vite built-ins read \(1\): DEV/);
  assert.match(result.stdout, /Dynamic access \(1 file\):\n  apps\/web\/src\/main\.ts  1/);
  assert.doesNotMatch(section(result, 'Read by code but defined in no env file').body.join('\n'), /\bDEV\b/);
});

test('without --wrapper the wrapped call is not a read', async () => {
  const dir = await makeProject(PROJECT);
  assert.doesNotMatch(run(['list', dir]).stdout, /WRAPPED_ONE/);
});

test('a deploy file mention counts as use: a name only compose sets is not "never read"', async () => {
  const dir = await makeProject({ '.env': 'COMPOSE_ONLY=MARKER_VALUE\nTRULY_UNUSED=1\n', 'docker-compose.yml': 'services:\n  a:\n    environment:\n      - COMPOSE_ONLY=MARKER_COMPOSE\n' });
  assert.deepEqual(section(run(['list', dir]), 'Defined but never read').body, ['TRULY_UNUSED  .env']);
});

test('walk: hidden folders are read, .git and node_modules and the other skipped folders are not', async () => {
  const files = { '.hidden/app/.env': 'HIDDEN_ONE=1\n' };
  for (const skipped of ['.git', 'node_modules', 'dist', 'build', 'coverage', '.nx', '.next', '.turbo', '.cache']) files[`${skipped}/pkg/.env`] = 'SKIPPED_ONE=1\n';
  const dir = await makeProject(files);
  const result = run(['list', dir]);
  assert.deepEqual(section(result, 'Env files').body, ['.hidden/app/.env  (1 name)']);
  assert.doesNotMatch(result.stdout, /SKIPPED_ONE/);
});

test('env file name patterns: .env, .env.*, *.env at any depth; other names are not env files', async () => {
  const dir = await makeProject({ '.env': 'A=1\n', '.env.production': 'A=1\n', 'prod.env': 'A=1\n', 'a/b/c/.env.local': 'A=1\n', 'environment.txt': 'A=1\n', '.envrc': 'A=1\n', 'env': 'A=1\n' });
  assert.deepEqual(section(run(['list', dir]), 'Env files').body.map((line) => line.split('  ')[0]), ['.env', '.env.production', 'a/b/c/.env.local', 'prod.env']);
});

test('untracked and git-ignored env files are included', async () => {
  const dir = await makeProject({ '.gitignore': '.env*\n', '.env': 'A=1\n', 'tracked.txt': 'x\n' });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.deepEqual(section(run(['list', dir]), 'Env files').body, ['.env  (1 name)']);
});

test('a symlinked env file is listed as link, not read, and its target is never opened', async () => {
  const dir = await makeProject({ 'real/outside.txt': 'LEAKED_NAME=MARKER_VALUE\n', 'app/.keep': '' });
  await symlink(join(dir, 'real/outside.txt'), join(dir, 'app/.env'));
  const result = run(['list', join(dir, 'app')]);
  assert.deepEqual(section(result, 'Env files').body, ['.env  (link, not read)']);
  assert.doesNotMatch(result.all, /LEAKED_NAME/);
});

test('a symlinked folder is not entered', async () => {
  const dir = await makeProject({ 'target/.env': 'VIA_LINK=1\n', 'start/.keep': '' });
  await symlink(join(dir, 'target'), join(dir, 'start/linked'));
  assert.deepEqual(section(run(['list', join(dir, 'start')]), 'Env files').body, []);
});

test('other lines are counted in the file line; CRLF and BOM files read normally; a stray line makes the file irregular', async () => {
  const dir = await makeProject({ '.env': '\uFEFFA=1\r\nB=2\r\n', 'irregular/.env': 'A=1\r\nB=2\r\nnot a pair MARKER_PART\r\n', 'src/a.ts': 'process.env.A;\n' });
  const body = section(run(['list', dir]), 'Env files').body;
  assert.equal(body[0], '.env  (2 names)');
  assert.equal(body[1], 'irregular/.env  (1 name, 1 other line, 1 name not shown (this file has multi-line or unusual values; only names also found in code or deploy files are listed), irregular)');
});

test('--json prints the full structure and --save writes the same JSON with version, root and generatedAt', async () => {
  const dir = await makeProject(PROJECT);
  const saved = join(dir, '..', `snapshot-${Date.now()}.json`);
  const result = run(['list', dir, '--json', '--save', saved, '--wrapper', 'getEnvVariable']);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  const written = JSON.parse(await readFile(saved, 'utf8'));
  assert.deepEqual(written, printed);
  assert.equal(written.version, 2);
  assert.equal(written.root, dir);
  assert.ok(!Number.isNaN(Date.parse(written.generatedAt)));
  assert.deepEqual(written.envFiles.map((file) => file.path), ['.env', '.env.example', 'apps/web/.env.local']);
  assert.deepEqual(written.readByCode.MISSING_ONE, ['apps/api/server.js:1', 'apps/web/src/main.ts:2']);
  assert.deepEqual(leaked(`${result.all}${JSON.stringify(written)}`), []);
});

test('dir defaults to the current folder', async () => {
  const dir = await makeProject({ '.env': 'FROM_CWD=1\n' });
  assert.deepEqual(section(run(['list'], dir), 'Env files').body, ['.env  (1 name)']);
});

test('exit 2 with a plain reason: no command, unknown command, missing folder, a file as folder, bad flag, unwritable --save', async () => {
  const dir = await makeProject({ '.env': 'A=1\n' });
  const cases = [[[], /usage/], [['frobnicate'], /usage/], [['list', join(dir, 'nope')], /not a folder/], [['list', join(dir, '.env')], /not a folder/],
    [['list', dir, '--bogus'], /unknown or incomplete flag/], [['list', dir, '--save'], /unknown or incomplete flag/], [['list', dir, '--save', join(dir, 'no/such/dir/x.json')], /cannot write/]];
  for (const [args, reason] of cases) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')} -> ${result.status}`);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, '');
  }
});

test('names that are also object property names (__proto__, constructor) are ordinary names, in list and in a diff round trip', async () => {
  const dir = await makeProject({ '.env': '__proto__=1\nconstructor=2\n', 'a.ts': 'process.env.__proto__;process.env.constructor;process.env.hasOwnProperty;\n' });
  const result = run(['list', dir]);
  assert.deepEqual(section(result, 'Read by code but defined in no env file').body, ['hasOwnProperty  a.ts:1']);
  const snapshot = join(dir, 'snapshot.json');
  assert.equal(run(['list', dir, '--save', snapshot]).status, 0);
  assert.equal(run(['diff', snapshot, dir]).status, 0);
});
