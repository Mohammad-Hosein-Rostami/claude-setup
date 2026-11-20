// Tests for lib/weakened.mjs: the list of added lines that weaken a check (skip, only, todo, ignore, a changed bound, removed tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { weakenedChecks } from '../home/tools/review-tier/lib/weakened.mjs';
import { buildReport } from '../home/tools/review-tier/lib/report.mjs';

const changed = (path, added = [], removed = []) => ({
  path,
  added: added.map((text, index) => ({ line: index + 1, text })),
  removed: removed.map((text, index) => ({ line: 10 + index, text })),
});
const TEST_FILE = 'tests/a.test.mjs';
const kinds = (added, removed = [], path = TEST_FILE) => weakenedChecks([changed(path, added, removed)]).map((entry) => entry.kind);

test('only, skip and todo calls are weakened; their plain words are not', () => {
  assert.deepEqual(kinds(["test.only('a', fn);"]), ['only']);
  assert.deepEqual(kinds(["describe.skip('a', fn);"]), ['skip']);
  assert.deepEqual(kinds(["it.todo('a');"]), ['todo']);
  assert.deepEqual(kinds(["test('a', { skip: 'flaky' }, fn);"]), ['skip']);
  assert.deepEqual(kinds(["test('a', { todo: true }, fn);"]), ['todo']);
  assert.deepEqual(kinds(['const tests = { only: true };']), ['only']);
  assert.deepEqual(kinds(["test('a', { skip: false }, fn);"]), []);
  assert.deepEqual(kinds(['const skipped = list.filter(isSkipped);', 'const only = 1;']), []);
});

test('ts-ignore, ts-nocheck and eslint-disable are ignore', () => {
  assert.deepEqual(kinds(['// @ts-ignore']), ['ignore']);
  assert.deepEqual(kinds(['// @ts-nocheck']), ['ignore']);
  assert.deepEqual(kinds(['/* eslint-disable no-console */']), ['ignore']);
  assert.deepEqual(kinds(['// eslint is fine here']), []);
});

test('the entry carries path and the line of the added line', () => {
  assert.deepEqual(weakenedChecks([changed(TEST_FILE, ['ok();', "test.skip('a', fn);"])]), [{ path: TEST_FILE, line: 2, kind: 'skip' }]);
});

test('bound: a removed and an added line equal but for numbers; a plain edit or a moved line is not', () => {
  assert.deepEqual(kinds(['assert.ok(elapsed < 900);'], ['assert.ok(elapsed < 100);']), ['bound']);
  assert.deepEqual(kinds(['const LIMIT = 1000;'], ['const LIMIT = 50;']), ['bound']);
  assert.deepEqual(kinds(['assert.equal(total, 3);'], ['assert.equal(count, 3);']), []);
  assert.deepEqual(kinds(['same();'], ['same();']), []);
});

test('removed tests and asserts count only beyond the added ones', () => {
  assert.deepEqual(kinds([], ["test('a', () => {", "test('b', () => {"]), ['removed-test', 'removed-test']);
  assert.deepEqual(kinds(["test('c', () => {"], ["test('a', () => {", "test('b', () => {"]), ['removed-test']);
  assert.deepEqual(kinds(["test('renamed', () => {"], ["test('old', () => {"]), []);
  assert.deepEqual(kinds([], ['  assert.equal(a, 1);', '  expect(b).toBe(2);']), ['removed-assert', 'removed-assert']);
  assert.deepEqual(kinds(['  assert.equal(a, 2);'], ['  assert.equal(a, 1);']), ['bound']);
  assert.deepEqual(kinds(['  assert.deepEqual(a, x);'], ['  assert.equal(a, 1);']), []);
  assert.deepEqual(kinds([], ['const edit = it.next();', 'const submit = 1;']), []);
});

test('only test files and test, lint and type config are read; source and docs are not', () => {
  const lines = ["test.skip('a', fn);", '// @ts-ignore'];
  for (const path of ['src/a.mjs', 'README.md', 'docs/x.md', 'package.json']) assert.deepEqual(kinds(lines, [], path), [], path);
  for (const path of ['tests/a.test.mjs', 'src/__tests__/a.mjs', 'src/a.spec.ts', 'tsconfig.json', 'eslint.config.js', '.eslintrc.json', 'vitest.config.ts', 'jest.config.js', 'playwright.config.ts']) {
    assert.ok(kinds(lines, [], path).length >= 1, path);
  }
});

test('buildReport carries the list as `weakened`, empty when nothing is weakened', () => {
  const base = { readNewFile: () => null, landing: false, addClasses: [], laneClasses: null, range: 'main...HEAD', deltaOf: null, requiredReading: [] };
  assert.deepEqual(buildReport({ ...base, files: [changed(TEST_FILE, ["test.only('a', fn);"])] }).weakened, [{ path: TEST_FILE, line: 1, kind: 'only', place: `${TEST_FILE}:1` }]);
  assert.deepEqual(buildReport({ ...base, files: [changed('src/a.mjs', ['const a = 1;'])] }).weakened, []);
});
