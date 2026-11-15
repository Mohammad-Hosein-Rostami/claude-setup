// The hard invariant of env-names, attacked from several angles: no value from any env file ever reaches stdout, stderr,
// a snapshot file or an error message. Every value planted here contains a marker (see env-names-fixtures.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namesFromEnvText } from '../home/tools/env-names/lib/env-file-names.mjs';
import { leaked, makeProject, run } from './env-names-fixtures.mjs';

const FULL_OF_VALUES = {
  '.env': [
    '\uFEFFPLAIN=MARKER_VALUE_one', 'export EXPORTED=MARKER_VALUE_two', 'SPACED = MARKER_VALUE_three', 'WITH_EQUALS=MARKER_VALUE=four==',
    'TRAILING=value # MARKER_COMMENT_five', 'QUOTED="MARKER_QUOTED_six"', 'MULTI="-----BEGIN MARKER_PART', 'MARKERVALUE+abc/def==',
    'FAKE_INSIDE=MARKER_PART_seven', '-----END MARKER_PART-----"', 'WINDOWS_DIR=C:\\MARKER_VALUE\\', 'MARKERVALUE_continuation==', 'AFTER=1',
    'MARKER_VALUE standalone junk', '# COMMENTED=MARKER_COMMENT', '',
  ].join('\r\n'),
  'apps/web/.env.production': 'URL=https://MARKER_VALUE.example/?a=b\n',
  'src/config.ts': "const a = process.env.PLAIN ?? 'MARKER_VALUE_eight';\nconst { DESTRUCTURED = 'MARKER_VALUE_nine' } = process.env;\nconst b = process.env['EXPORTED'] || \"MARKER_VALUE_ten\";\n",
  Dockerfile: 'ARG BUILD_ARG=MARKER_VALUE_eleven\nENV IMG_VAR="MARKER_VALUE_twelve FAKE_IMG=1" OTHER=MARKER_VALUE_thirteen\n',
  'docker-compose.yml': 'services:\n  a:\n    environment:\n      - COMPOSE_ITEM=MARKER_COMPOSE_one\n      COMPOSE_MAP: MARKER_COMPOSE_two\n',
  '.github/workflows/ci.yml': 'env:\n  CI_VAR: MARKER_VALUE_fourteen # MARKER_COMMENT\njobs: {}\n',
};

async function everyOutput(dir) {
  const snapshot = join(dir, '..', `invariant-${Math.random().toString(36).slice(2)}.json`);
  const outputs = [run(['list', dir, '--save', snapshot]), run(['list', dir, '--json']), run(['diff', snapshot, dir]), run(['diff', snapshot, dir, '--json'])];
  return `${outputs.map((out) => out.all).join('\n')}\n${await readFile(snapshot, 'utf8')}`;
}

test('values in every place a value can sit never reach stdout, stderr or the snapshot (list, --json, --save, diff, diff --json)', async () => {
  const dir = await makeProject(FULL_OF_VALUES);
  const everything = await everyOutput(dir);
  assert.deepEqual(leaked(everything), []);
  assert.match(everything, /PLAIN/); // the names are there: the check is not passing on empty output
  assert.match(everything, /COMPOSE_ITEM/);
});

test('a name inside a quoted multi-line value or a quoted deploy value is not invented', async () => {
  const dir = await makeProject(FULL_OF_VALUES);
  const everything = await everyOutput(dir);
  for (const fake of ['FAKE_INSIDE', 'FAKE_IMG', 'MARKERVALUE']) assert.doesNotMatch(everything, new RegExp(fake));
});

test('a value line after a trailing backslash is swallowed, not read as a name', () => {
  const result = namesFromEnvText('A=C:\\dir\\\nCONTINUATION==\nB=1\n');
  assert.deepEqual(result, { names: ['A', 'B'], otherLines: 1 });
});

test('fuzz: random env text with markers in values, quotes, backslashes and junk never puts a marker in the result', () => {
  let seed = 20260101;
  const next = (limit) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % limit;
  };
  const values = ['MARKER_VALUE', '"MARKER_VALUE', "'MARKER_QUOTED", 'MARKER_VALUE"', 'a=b MARKER_VALUE', '"MARKER_VALUE"', '', 'MARKER_VALUE\\', '`MARKER_PART', '# MARKER_COMMENT', 'x=MARKER_VALUE=='];
  const junk = ['MARKER_PART words', '-----BEGIN MARKER_PART-----', '# MARKER_COMMENT=x', '', '   ', 'https://MARKER_PART/', '"', "'", 'MARKERVALUE+abc/def'];
  for (let round = 0; round < 300; round += 1) {
    const lines = [];
    for (let i = 0; i < 12; i += 1) lines.push(next(2) === 0 ? `NAME_${round}_${i}=${values[next(values.length)]}` : junk[next(junk.length)]);
    const result = namesFromEnvText(lines.join(['\n', '\r\n', '\r'][next(3)]));
    assert.deepEqual(leaked(JSON.stringify(result)), [], lines.join('|'));
    assert.ok(result.names.every((name) => /^NAME_\d+_\d+$/.test(name)), lines.join('|'));
  }
});

test('a binary file named .env, a 5 MB env file and a symlink to a file outside, through the CLI', async () => {
  const filler = `BIG_NAME=MARKER_VALUE${'x'.repeat(990)}\n`.repeat(5000);
  const dir = await makeProject({
    'bin/.env': Buffer.concat([Buffer.from('BIN_NAME=MARKER_VALUE\n'), Buffer.from([0, 255, 0, 1])]),
    'big/.env': `FIRST=1\n${filler}`,
    'outside/secret.txt': 'OUT_NAME=MARKER_VALUE\n',
    'linked/.keep': '',
  });
  await symlink(join(dir, 'outside/secret.txt'), join(dir, 'linked/.env'));
  const started = Date.now();
  const result = run(['list', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 10000);
  assert.deepEqual(leaked(result.all), []);
  assert.match(result.stdout, /bin\/\.env {2}\(binary, not read\)/);
  assert.match(result.stdout, /linked\/\.env {2}\(link, not read\)/);
  assert.match(result.stdout, /big\/\.env {2}\(2 names\)/);
  assert.doesNotMatch(result.all, /BIN_NAME|OUT_NAME/);
});

test('an unreadable env file is reported by error code only', async () => {
  const dir = await makeProject({ 'locked/.env': 'LOCKED_NAME=MARKER_VALUE\n' });
  await chmod(join(dir, 'locked/.env'), 0o000);
  const result = run(['list', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(leaked(result.all), []);
  assert.match(result.stdout, /locked\/\.env {2}\((unreadable \(EACCES\), not read|1 name)\)/); // root can read it: still names only
});

test('a folder named like an env file is walked, not read', async () => {
  const dir = await makeProject({ 'config.env/inner.txt': 'x\n', '.env/.env': 'IN_DIR=MARKER_VALUE\n' });
  const result = run(['list', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.env\/\.env {2}\(1 name\)/);
  assert.deepEqual(leaked(result.all), []);
});

test('bad input paths and flags produce messages written by the tool, with no file content', async () => {
  const dir = await makeProject(FULL_OF_VALUES);
  const attempts = [['list', join(dir, '.env')], ['diff', join(dir, '.env'), dir], ['diff', join(dir, 'Dockerfile'), dir], ['diff', join(dir, 'docker-compose.yml'), dir],
    ['diff', join(dir, 'src/config.ts'), dir], ['list', dir, '--save', join(dir, '.env', 'x')]];
  for (const args of attempts) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.deepEqual(leaked(result.all), [], args.join(' '));
  }
});

test('structure: only the reader, the scanners and the snapshot reader open files; env files go through the reader alone', async () => {
  const toolDir = fileURLToPath(new URL('../home/tools/env-names/', import.meta.url));
  const files = [join(toolDir, 'env-names.mjs'), ...(await readdir(join(toolDir, 'lib'))).filter((name) => name.endsWith('.mjs')).map((name) => join(toolDir, 'lib', name))];
  const openers = [];
  for (const file of files) if (/readFileSync|readSync|createReadStream|readFile\(/.test(await readFile(file, 'utf8'))) openers.push(file.slice(toolDir.length));
  assert.deepEqual(openers.sort(), ['env-names.mjs', 'lib/collect.mjs', 'lib/env-file-names.mjs']);
  const collect = await readFile(join(toolDir, 'lib/collect.mjs'), 'utf8');
  assert.match(collect, /readEnvFile\(join\(root, path\)\)/); // env files only through the reader
});
