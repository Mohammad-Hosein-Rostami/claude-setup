// Tests for home/hooks/post-edit.mjs: output parsing, path matching, format planning, Windows quoting and the hook contract (running lives in post-edit-stages.test.mjs).
// The test process and every hook it starts get a temp home, temp folder and run log, so nothing here touches the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostics, isBroadScript, isCodeFile, isSamePath, plannedChecks, shellCommand, skipFilter } from '../home/hooks/post-edit.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cleanEnv } from './clean-env.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));

const SANDBOX = makeTempDir('post-edit-log-');
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = join(SANDBOX, 'home');
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = join(SANDBOX, 'tmp');
process.env.CLAUDE_GUARD_LOG = join(SANDBOX, 'guard.jsonl');
for (const folder of ['home', 'tmp']) mkdirSync(join(SANDBOX, folder));
// Real `eslint` default (stylish) output behind a pnpm script banner, two files, as the hook receives it.
const STYLISH = `
> proj@1.0.0 lint /abs/proj
> eslint . -- src/a.ts

/abs/proj/src/a.ts
  1:5   error    'x' is defined but never used   @typescript-eslint/no-unused-vars
  7:10  warning  Unexpected console statement    no-console

/abs/proj/src/other.ts
  3:1  error  Missing semicolon  semi

\u2716 3 problems (2 errors, 1 warning)
`;

test('diagnostics attributes eslint stylish rows to the file header', () => {
  assert.deepEqual(diagnostics(STYLISH, 'src/a.ts'), [
    '/abs/proj/src/a.ts:1 @typescript-eslint/no-unused-vars \'x\' is defined but never used',
    '/abs/proj/src/a.ts:7 no-console Unexpected console statement',
  ]);
});

test('diagnostics stays silent when stylish failures are only in other files', () => {
  assert.deepEqual(diagnostics(STYLISH, 'src/third.ts'), []);
  assert.deepEqual(diagnostics(STYLISH, 'src/other.ts'), ['/abs/proj/src/other.ts:3 semi Missing semicolon']);
});

test('diagnostics handles Windows stylish headers', () => {
  const out = 'C:\\proj\\src\\a.ts\n  2:3  error  Bad thing  some-rule\n';
  assert.deepEqual(diagnostics(out, 'src/a.ts'), ['C:/proj/src/a.ts:2 some-rule Bad thing']);
});

test('diagnostics parses tsc and eslint unix formats', () => {
  assert.deepEqual(diagnostics('src/a.ts(3,7): error TS2322: bad type\nsrc/b.ts(1,1): error TS1: x', 'src/a.ts'), ['src/a.ts:3 TS2322 bad type']);
  assert.deepEqual(diagnostics('/abs/proj/src/a.ts:1:5: error x is unused  no-unused-vars', 'src/a.ts'), ['/abs/proj/src/a.ts:1 no-unused-vars x is unused']);
});

test('diagnostics falls back to the output tail when nothing parses', () => {
  assert.deepEqual(diagnostics('boom\ncrashed', 'src/a.ts'), ['boom', 'crashed']);
});

test('diagnostics caps the result at 15 lines', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `src/a.ts(${i + 1},1): error TS1: m`).join('\n');
  assert.equal(diagnostics(rows, 'src/a.ts').length, 15);
});

test('isSamePath matches whole path segments only', () => {
  assert.ok(isSamePath('src/a.ts', 'src/a.ts'));
  assert.ok(isSamePath('./src/a.ts', 'src/a.ts'));
  assert.ok(isSamePath('/abs/proj/src/a.ts', 'src/a.ts'));
  assert.ok(isSamePath('C:\\proj\\src\\a.ts', 'src/a.ts'));
  assert.ok(isSamePath('a.ts', 'src/a.ts'));
  assert.ok(isSamePath('data.ts', 'src/data.ts'));
  assert.ok(!isSamePath('ta.ts', 'src/data.ts'));
  assert.ok(!isSamePath('src/xa.ts', 'src/a.ts'));
  assert.ok(!isSamePath('/abs/proj/src/data.ts', 'src/a.ts'));
});

test('shellCommand quotes on Windows when cmd metacharacters are present', () => {
  assert.equal(shellCommand('C:\\a b\\eslint.cmd', 'win32'), '"C:\\a b\\eslint.cmd"');
  assert.equal(shellCommand('C:\\R&D\\node_modules\\.bin\\eslint.cmd', 'win32'), '"C:\\R&D\\node_modules\\.bin\\eslint.cmd"');
  assert.equal(shellCommand('C:\\a^b\\eslint.cmd', 'win32'), '"C:\\a^b\\eslint.cmd"');
  assert.equal(shellCommand('C:\\plain\\eslint.cmd', 'win32'), 'C:\\plain\\eslint.cmd');
  assert.equal(shellCommand('/a b/eslint', 'linux'), '/a b/eslint');
  assert.equal(shellCommand('pnpm', 'win32'), 'pnpm');
});

test('isCodeFile and isBroadScript', () => {
  assert.ok(['a.ts', 'a.tsx', 'a.mjs', 'x/y.cjs'].every(isCodeFile));
  assert.ok(!isCodeFile('a.md') && !isCodeFile('a.json'));
  assert.ok(['prettier --write .', 'eslint src/**', 'nx run-many -t lint', 'turbo lint'].every(isBroadScript));
  assert.ok(!isBroadScript('eslint') && !isBroadScript('tsc --noEmit'));
});

test('skipFilter honours "all" and named checks', () => {
  assert.equal(skipFilter('all')('lint'), false);
  assert.equal(skipFilter('format, lint')('format'), false);
  assert.equal(skipFilter('lint')('format'), true);
  assert.equal(skipFilter()('lint'), true);
});

test('plannedChecks plans the format script only: trusted, through the package manager with the file after `--`; untrusted, a known formatter as its binary', () => {
  const scripts = { format: 'prettier --write', lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', () => null, true), [{ name: 'format', args: ['run', 'format', '--', 'src/a.ts'] }]);
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', (tool) => `/bin/${tool}`), [{ name: 'format', cmd: '/bin/prettier', args: ['--write', 'src/a.ts'] }]);
  assert.deepEqual(plannedChecks({ format: 'node evil.js' }, 'src/a.ts'), []);
  assert.deepEqual(plannedChecks({ lint: 'eslint', typecheck: 'tsc --noEmit' }, 'src/a.ts'), []);
});

test('plannedChecks swaps a broad format script for the tool binary, or skips it', () => {
  const scripts = { format: 'prettier --write .' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', (tool) => `/bin/${tool}`), [{ name: 'format', cmd: '/bin/prettier', args: ['--write', 'src/a.ts'] }]);
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', () => null), []);
  assert.deepEqual(plannedChecks(undefined, 'src/a.ts'), []);
});

// A file name as the three plan paths pass it: a broad script (the tool binary), a trusted script (the package manager, after `--`)
// and an untrusted known formatter (its binary). The last argument is the file either way.
const DASH_PLAN_SCRIPTS = { broad: 'prettier --write .', trusted: 'node format.js', untrusted: 'prettier --write' };
const binOf = (tool) => `/bin/${tool}`;
const plannedOnEveryPath = (file) => ({
  broad: plannedChecks({ format: DASH_PLAN_SCRIPTS.broad }, file, binOf),
  trusted: plannedChecks({ format: DASH_PLAN_SCRIPTS.trusted }, file, () => null, true),
  untrusted: plannedChecks({ format: DASH_PLAN_SCRIPTS.untrusted }, file, binOf),
});
const expectedOnEveryPath = (argument) => ({
  broad: [{ name: 'format', cmd: '/bin/prettier', args: ['--write', argument] }],
  trusted: [{ name: 'format', args: ['run', 'format', '--', argument] }],
  untrusted: [{ name: 'format', cmd: '/bin/prettier', args: ['--write', argument] }],
});

test('plannedChecks passes a file name that starts with `-` as `./<name>` on every path, so no tool reads it as an option', () => {
  for (const file of ['--plugin=x.ts', '-x.ts', '-', '--']) assert.deepEqual(plannedOnEveryPath(file), expectedOnEveryPath(`./${file}`), file);
});

test('plannedChecks passes a name that does not start with `-` as it is: a dash inside it or after a folder, spaces', () => {
  for (const file of ['src/-x.ts', 'a-b.ts', 'src/my file.ts']) assert.deepEqual(plannedOnEveryPath(file), expectedOnEveryPath(file), file);
});

test('hook contract: bad JSON, empty stdin and non-code files exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({ tool_input: { file_path: 'README.md' } }), JSON.stringify({})]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: cleanEnv({ CLAUDE_GUARD_LOG: process.env.CLAUDE_GUARD_LOG }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});
