// Tests for home/tools/refs/refs.mjs end to end: exit codes, output formats, which folders are walked, symlinks, big files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CLI, findingLines, project, refs } from './refs-helpers.mjs';

const BROKEN = '{\n  "extends": "./gone.json"\n}\n';
const UNPARSABLE = '{ "extends": ';

test('exit 0 with no findings, 1 with findings, and a summary line either way', () => {
  const clean = refs(project({ 'a.txt': 'x' }));
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'refs: 0 findings, 0 hints in 0 files scanned\n');
  assert.equal(refs(project({ 'tsconfig.json': BROKEN })).status, 1);
});

test('exit 2 for usage errors and for a folder that does not exist', () => {
  const root = project({ 'a.txt': 'x' });
  const runs = [[], ['list', root], ['check', root, '--wat'], ['check', root, root], ['check', join(root, 'missing')], ['check', join(root, 'a.txt')]];
  for (const args of runs) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
  }
});

test('the directory defaults to the current folder', () => {
  const root = project({ 'tsconfig.json': BROKEN });
  const result = spawnSync(process.execPath, [CLI, 'check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result), ['tsconfig.json:2 tsconfig-extends ./gone.json -> missing']);
});

test('--json prints one object with findings, hints and scanned', () => {
  const root = project({ 'tsconfig.json': BROKEN, 'sub/tsconfig.json': UNPARSABLE });
  const result = refs(root, '--json');
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['findings', 'hints', 'scanned']);
  assert.deepEqual(parsed.findings, [{ file: 'tsconfig.json', line: 2, kind: 'tsconfig-extends', value: './gone.json' }]);
  assert.equal(parsed.hints.length, 1);
  assert.deepEqual(Object.keys(parsed.hints[0]).sort(), ['file', 'kind', 'line', 'value']);
  assert.equal(parsed.hints[0].kind, 'unreadable?');
  assert.equal(parsed.scanned, 2);
});

test('--no-hints drops the hints and leaves the exit code alone', () => {
  const root = project({ 'sub/tsconfig.json': UNPARSABLE });
  const withHints = refs(root);
  const without = refs(root, '--no-hints');
  assert.match(withHints.stdout, /unreadable\?/);
  assert.doesNotMatch(without.stdout, /unreadable\?/);
  assert.match(without.stdout, /refs: 0 findings, 0 hints/);
  assert.equal(without.status, 0);
});

test('hints never change the exit code: hints with a finding is 1, hints alone is 0', () => {
  assert.equal(refs(project({ 'a/tsconfig.json': UNPARSABLE })).status, 0);
  assert.equal(refs(project({ 'a/tsconfig.json': UNPARSABLE, 'tsconfig.json': BROKEN })).status, 1);
});

test('output is sorted by file then line', () => {
  const root = project({
    'b/tsconfig.json': '{\n  "extends": "./z.json"\n}\n',
    'a/tsconfig.json': '{\n  "extends": "./y.json",\n  "include": ["x"]\n}\n',
  });
  assert.deepEqual(findingLines(refs(root)).map((line) => line.split(' ')[0]), ['a/tsconfig.json:2', 'a/tsconfig.json:3', 'b/tsconfig.json:2']);
});

test('hidden folders are scanned; node_modules, dist, .git and the other skipped folders are not', () => {
  const files = { '.claude/tsconfig.json': BROKEN, '.github/jsconfig.json': BROKEN };
  for (const skipped of ['node_modules', 'dist', 'build', 'coverage', '.nx', '.next', '.turbo', '.cache', '.git']) files[`${skipped}/tsconfig.json`] = BROKEN;
  const result = refs(project(files));
  assert.deepEqual(findingLines(result).map((line) => line.split(' ')[0]), ['.claude/tsconfig.json:2', '.github/jsconfig.json:2']);
});

test('a symlink pointing outside the directory is not followed, and a symlink loop does not hang', () => {
  const outside = project({ 'tsconfig.json': BROKEN });
  const root = project({ 'ok.txt': 'x' });
  symlinkSync(outside, join(root, 'linked-out'));
  mkdirSync(join(root, 'a'));
  symlinkSync(root, join(root, 'a', 'loop'));
  symlinkSync(join(outside, 'tsconfig.json'), join(root, 'tsconfig.json'));
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'refs: 0 findings, 0 hints in 0 files scanned\n');
});

test('an empty folder is clean', () => {
  assert.equal(refs(project({})).status, 0);
});

test('a 5 MB JSON file is read without trouble', () => {
  const filler = Array.from({ length: 100000 }, (_, index) => `"entry-number-${index}-padding-padding"`).join(',\n');
  const root = project({ 'tsconfig.json': `{\n  "extends": "./gone.json",\n  "big": [${filler}]\n}\n` });
  const result = refs(root);
  assert.equal(result.status, 1);
  assert.deepEqual(findingLines(result), ['tsconfig.json:2 tsconfig-extends ./gone.json -> missing']);
});

test('a file larger than the size limit is a hint, not a crash', () => {
  const root = project({});
  writeFileSync(join(root, 'tsconfig.json'), Buffer.alloc(9 * 1024 * 1024, 0x20));
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /tsconfig\.json:1 unreadable\? file is larger than 8 MiB/);
});

test('deeply nested JSON is a hint, not a stack overflow', () => {
  const root = project({ 'tsconfig.json': '['.repeat(100000) });
  const result = refs(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /unreadable\? nested too deep/);
});
