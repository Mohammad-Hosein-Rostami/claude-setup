// Tests for home/hooks/test-files-only.mjs: the test-path table and the deny/allow exit-code contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestPath } from '../home/hooks/test-files-only.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/test-files-only.mjs', import.meta.url));
const CWD = '/work/app';

const ALLOW = [
  'src/a.test.ts',
  'src/a.spec.tsx',
  'src/a_test.go',
  'src/test_a.py',
  'tests/helper.ts',
  'src/__tests__/x.ts',
  'e2e/flow.ts',
  'src/fixtures/data.json',
  'src/__fixtures__/data.json',
  'testdata/in.txt',
  'test/util.js',
  '/work/app/src/deep/a.test.js',
  'src/../tests/x.ts',
  'tests/../src/b.spec.ts',
  'src/Tests/a.ts',
  'spec/foo_spec.rb',
  'src/__mocks__/a.ts',
  'conftest.py',
  'src/FooTests.cs',
  'src/main/java/FooTest.java',
  'src/FooIT.java',
  'vitest.setup.ts',
  'src/setupTests.js',
];

const DENY = [
  'src/a.ts',
  'src/testing.ts',
  'src/contest.ts',
  'README.md',
  'package.json',
  'src/test.ts',
  'src/tests.ts',
  'src/a.test',
  'tests/../src/a.ts',
  '../outside.ts',
  '/etc/passwd',
  '/work/tests-lookalike/a.ts',
  '/etc/tests/passwd',
  'node_modules/x/test/a.js',
  'node_modules/x/a.test.js',
  'Node_Modules/x/a.test.js',
  'src/Contest.ts',
  'src/Latest.ts',
  'src/testIT.ts',
  'vitest.config.ts',
  'src/setup.ts',
  'src/TestUtils.ts',
  '',
];

test('isTestPath allows test files and test directories', () => {
  for (const path of ALLOW) assert.equal(isTestPath(path, CWD), true, path);
});

test('isTestPath denies everything else, including `..` escapes out of test dirs', () => {
  for (const path of DENY) assert.equal(isTestPath(path, CWD), false, path);
});

test('a tests folder above the project does not make the project writable', () => {
  assert.equal(isTestPath('src/a.ts', '/home/u/tests/app'), false);
  assert.equal(isTestPath('tests/a.ts', '/home/u/tests/app'), true);
});

test('outside cwd only a test-style basename passes; node_modules is always denied', () => {
  const cwd = '/home/u/tests/app';
  assert.equal(isTestPath('../other/src/index.ts', cwd), false);
  assert.equal(isTestPath('../other/src/index.test.ts', cwd), true);
  assert.equal(isTestPath('/etc/tests/passwd', cwd), false);
  assert.equal(isTestPath('/etc/foo.spec.ts', cwd), true);
  assert.equal(isTestPath('node_modules/x/test/a.js', cwd), false);
});

test('isTestPath denies non-string input', () => {
  for (const bad of [undefined, null, 42, {}, []]) assert.equal(isTestPath(bad, CWD), false);
});

const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });

test('hook allows a test write silently (exit 0)', () => {
  const r = run(JSON.stringify({ cwd: CWD, tool_input: { file_path: 'src/a.test.ts' } }));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});

test('hook denies other writes and fails closed on unreadable input (exit 2 + reason)', () => {
  const inputs = [JSON.stringify({ cwd: CWD, tool_input: { file_path: 'src/a.ts' } }), 'not json', '', '{}'];
  for (const input of inputs) {
    const r = run(input);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Blocked by test-files-only/);
  }
});
