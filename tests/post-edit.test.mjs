// Tests for home/hooks/post-edit.mjs: output parsing, path matching, check planning, Windows quoting, typecheck at edit vs at stop, edit log, hook contract (staging lives in post-edit-stages.test.mjs).
// The test process and every hook it starts get a temp home, temp folder and run log, so nothing here touches the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostics, isBroadScript, isCodeFile, isSamePath, plannedChecks, shellCommand, skipFilter, typecheckAtEdit } from '../home/hooks/post-edit.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));

const SANDBOX = makeTempDir('post-edit-log-');
for (const name of ['HOME', 'USERPROFILE']) process.env[name] = join(SANDBOX, 'home');
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = join(SANDBOX, 'tmp');
process.env.CLAUDE_TYPECHECK_LOG = join(SANDBOX, 'run.jsonl');
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
  assert.equal(skipFilter('lint, typecheck')('lint'), false);
  assert.equal(skipFilter('lint')('format'), true);
  assert.equal(skipFilter()('lint'), true);
});

test('plannedChecks plans no typecheck by default: the stop gate runs it', () => {
  const scripts = { lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts'), [{ name: 'lint', args: ['run', 'lint', '--', 'src/a.ts'] }]);
  assert.equal(typecheckAtEdit({}), false);
  assert.equal(typecheckAtEdit({ CLAUDE_TYPECHECK_AT: 'edit' }), true);
  assert.equal(typecheckAtEdit({ CLAUDE_TYPECHECK_AT: 'stop' }), false);
});

test('plannedChecks runs file scripts with the file and project scripts whole at edit time', () => {
  const scripts = { format: 'prettier --write', lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', () => null, true), [
    { name: 'format', args: ['run', 'format', '--', 'src/a.ts'] },
    { name: 'lint', args: ['run', 'lint', '--', 'src/a.ts'] },
    { name: 'typecheck', args: ['run', 'typecheck'] },
  ]);
});

test('plannedChecks swaps broad scripts for the tool binary, or skips them', () => {
  const scripts = { lint: 'eslint .', typecheck: 'nx run-many -t typecheck' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', (tool) => `/bin/${tool}`, true), [{ name: 'lint', cmd: '/bin/eslint', args: ['src/a.ts'] }]);
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', () => null, true), []);
  assert.deepEqual(plannedChecks(undefined, 'src/a.ts'), []);
});

test('hook contract: bad JSON, empty stdin and non-code files exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({ tool_input: { file_path: 'README.md' } }), JSON.stringify({})]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});


// Hook contract for the edit log: run the real hook against a fake project, with the temp dir redirected.
// `manifest` is the text of the package.json (default: one with the `typecheck` script); null leaves the project without one.
async function loggedEdit({ env = {}, input = {}, typecheck = 'tsc --noEmit', manifest = JSON.stringify({ scripts: { typecheck } }), name = 'a.ts' }) {
  const root = makeTempDir('post-edit-log-');
  const proj = join(root, 'proj');
  await mkdir(join(proj, 'src'), { recursive: true });
  if (manifest !== null) await writeFile(join(proj, 'package.json'), manifest);
  await writeFile(join(proj, 'tsconfig.json'), '{}');
  const file = join(proj, 'src', name);
  await writeFile(file, 'export {};\n');
  const tmp = join(root, 'tmp');
  await mkdir(tmp);
  const stdin = JSON.stringify({ session_id: 's1', tool_input: { file_path: file }, ...input });
  const cleanEnv = { ...process.env, CLAUDE_TYPECHECK_AT: '', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env };
  const again = () => spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: cleanEnv });
  const r = again();
  const logFile = (agent) => join(tmp, 'claude-post-edit', 'edits', `s1--${agent}`);
  return { r, file, logFile, again, read: (agent) => readFile(logFile(agent), 'utf8').catch(() => null) };
}

test('post-edit logs the edited file for the stop gate and runs no typecheck', async () => {
  const { r, file, read } = await loggedEdit({});
  assert.equal(r.status, 0);
  assert.equal(await read('main'), `${file}\n`);
});

test('post-edit logs per agent id', async () => {
  const { read, file } = await loggedEdit({ input: { agent_id: 'agent-7' } });
  assert.equal(await read('agent-7'), `${file}\n`);
  assert.equal(await read('main'), null);
});

test('post-edit skips the log for unsafe ids and CLAUDE_TYPECHECK_AT=edit', async () => {
  assert.equal(await (await loggedEdit({ input: { session_id: '../x' } })).read('main'), null);
  assert.equal(await (await loggedEdit({ input: { agent_id: 'a/b' } })).read('a/b'), null);
  assert.equal(await (await loggedEdit({ env: { CLAUDE_TYPECHECK_AT: 'edit' } })).read('main'), null);
});

test('post-edit logs every edited code file of a package: the stop gate decides what runs, whatever the scripts are', async () => {
  const manifests = { 'no scripts': '{}', 'no typecheck script': JSON.stringify({ scripts: { build: 'x' } }), 'a broad typecheck script': JSON.stringify({ scripts: { typecheck: 'nx run-many -t typecheck' } }) };
  for (const [what, manifest] of Object.entries(manifests)) {
    const { r, file, read } = await loggedEdit({ manifest });
    assert.equal(r.status, 0, what);
    assert.equal(await read('main'), `${file}\n`, what);
  }
  for (const name of ['a.mts', 'a.cts']) {
    const { r, file, read } = await loggedEdit({ name });
    assert.equal(r.status, 0, name);
    assert.equal(await read('main'), `${file}\n`, `${name}: an ES module or CommonJS TypeScript file is code too`);
  }
});

test('post-edit logs nothing for a file that is not code, was removed, or has no package.json above it (a tsconfig alone is out of scope)', async () => {
  assert.equal(await (await loggedEdit({ name: 'notes.md' })).read('main'), null);
  assert.equal(await (await loggedEdit({ manifest: null })).read('main'), null);
  const removed = await loggedEdit({});
  await rm(removed.logFile('main'));
  await rm(removed.file);
  removed.again();
  assert.equal(await removed.read('main'), null);
});
