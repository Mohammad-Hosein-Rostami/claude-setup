// Tests for home/hooks/post-edit.mjs: output parsing, path matching, check planning, Windows quoting, staging (concurrent lint + typecheck), hook contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostics, isBroadScript, isCodeFile, isSamePath, plannedChecks, runStages, shellCommand, skipFilter, stagesFor } from '../home/hooks/post-edit.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/post-edit.mjs', import.meta.url));

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

test('plannedChecks runs file scripts with the file and project scripts whole', () => {
  const scripts = { format: 'prettier --write', lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts'), [
    { name: 'format', args: ['run', 'format', '--', 'src/a.ts'] },
    { name: 'lint', args: ['run', 'lint', '--', 'src/a.ts'] },
    { name: 'typecheck', args: ['run', 'typecheck'] },
  ]);
});

test('plannedChecks swaps broad scripts for the tool binary, or skips them', () => {
  const scripts = { lint: 'eslint .', typecheck: 'nx run-many -t typecheck' };
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts', (tool) => `/bin/${tool}`), [{ name: 'lint', cmd: '/bin/eslint', args: ['src/a.ts'] }]);
  assert.deepEqual(plannedChecks(scripts, 'src/a.ts'), []);
  assert.deepEqual(plannedChecks(undefined, 'src/a.ts'), []);
});

test('hook contract: bad JSON, empty stdin and non-code files exit 0 silently', () => {
  for (const input of ['not json', '', JSON.stringify({ tool_input: { file_path: 'README.md' } }), JSON.stringify({})]) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});

const names = (stages) => stages.map((stage) => stage.map((c) => c.name));
const ALL_CHECKS = ['format', 'lint', 'typecheck'].map((name) => ({ name, args: ['run', name] }));

test('stagesFor: format first and alone, lint and typecheck concurrent', () => {
  const scripts = { format: 'prettier --write', lint: 'eslint', typecheck: 'tsc --noEmit' };
  assert.deepEqual(names(stagesFor(ALL_CHECKS, scripts)), [['format'], ['lint', 'typecheck']]);
});

test('stagesFor: a fixing lint script keeps everything sequential', () => {
  for (const lint of ['eslint --fix', 'eslint . --fix --quiet', 'fix-lint', 'biome check --write', 'biome lint --apply']) {
    assert.deepEqual(names(stagesFor(ALL_CHECKS, { lint })), [['format'], ['lint'], ['typecheck']], lint);
  }
});

test('stagesFor: lone or missing checks stay as single stages', () => {
  const [format, lint, typecheck] = ALL_CHECKS;
  assert.deepEqual(names(stagesFor([lint], { lint: 'eslint' })), [['lint']]);
  assert.deepEqual(names(stagesFor([typecheck], {})), [['typecheck']]);
  assert.deepEqual(names(stagesFor([format, typecheck], {})), [['format'], ['typecheck']]);
  assert.deepEqual(stagesFor([], {}), []);
});

// Fake package manager (a node script with a shebang): `fake <run> <name>` logs start/end, sleeps, then fails or not
// per FAKE_* env. Posix only: Windows would need a .cmd shim.
const FAKE_PM = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const name = process.argv[3];
const log = (what) => appendFileSync(process.env.FAKE_LOG, name + ' ' + what + ' ' + Date.now() + '\\n');
log('start');
setTimeout(() => {
  log('end');
  if (process.env.FAKE_FAIL?.split(',').includes(name)) {
    console.error('src/a.ts(1,1): error TS1: ' + name + ' failed');
    process.exitCode = 1;
  }
}, Number(process.env.FAKE_SLEEP_MS ?? 0));
`;

async function fakeProject(env) {
  const dir = await mkdtemp(join(tmpdir(), 'post-edit-fake-'));
  const pm = join(dir, 'fake-pm');
  await writeFile(pm, FAKE_PM);
  await chmod(pm, 0o755);
  const log = join(dir, 'log.txt');
  await writeFile(log, '');
  Object.assign(process.env, { FAKE_LOG: log }, env);
  return { pm, dir, log };
}

const events = async (log) =>
  (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => l.split(' ')).map(([name, what, at]) => ({ name, what, at: Number(at) }));

const posix = { skip: process.platform === 'win32' };

test('runStages runs lint and typecheck concurrently, format first', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '300', FAKE_FAIL: '' });
  const stages = stagesFor(ALL_CHECKS, { lint: 'eslint' });
  const out = await runStages(stages, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, []);
  const ev = await events(log);
  const at = (name, what) => ev.find((e) => e.name === name && e.what === what).at;
  assert.ok(at('format', 'end') <= at('lint', 'start'), 'format finishes before lint starts');
  assert.ok(at('typecheck', 'start') < at('lint', 'end'), 'typecheck starts while lint is still running');
});

test('runStages with a fixing lint runs lint to the end before typecheck starts', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '150', FAKE_FAIL: '' });
  const stages = stagesFor(ALL_CHECKS, { lint: 'eslint --fix' });
  await runStages(stages, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  const ev = await events(log);
  const at = (name, what) => ev.find((e) => e.name === name && e.what === what).at;
  assert.ok(at('lint', 'end') <= at('typecheck', 'start'));
});

test('runStages reports lint before typecheck when both fail', posix, async () => {
  const { pm, dir } = await fakeProject({ FAKE_SLEEP_MS: '0', FAKE_FAIL: 'lint,typecheck' });
  const out = await runStages(stagesFor(ALL_CHECKS, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, ['src/a.ts:1 TS1 lint failed']);
});

test('runStages stops at a failing format without running later stages', posix, async () => {
  const { pm, dir, log } = await fakeProject({ FAKE_SLEEP_MS: '0', FAKE_FAIL: 'format' });
  const out = await runStages(stagesFor(ALL_CHECKS, { lint: 'eslint' }), { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 10_000 });
  assert.deepEqual(out, ['src/a.ts:1 TS1 format failed']);
  assert.deepEqual([...new Set((await events(log)).map((e) => e.name))], ['format']);
});

test('runStages: a timeout or exhausted budget is no failure, even with a failing sibling', posix, async () => {
  const { pm, dir } = await fakeProject({ FAKE_SLEEP_MS: '5000', FAKE_FAIL: 'typecheck' });
  const lintAndTypecheck = stagesFor(ALL_CHECKS.slice(1), { lint: 'eslint' });
  const started = Date.now();
  assert.deepEqual(await runStages(lintAndTypecheck, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() + 300 }), []);
  assert.ok(Date.now() - started < 3000, 'killed at the deadline, not after the 5 s sleep');
  assert.deepEqual(await runStages(lintAndTypecheck, { pm, cwd: dir, rel: 'src/a.ts', deadline: Date.now() - 1 }), []);
});

test('runStages reports a missing package manager as a HOOK failure', async () => {
  const out = await runStages([[{ name: 'lint', args: ['run', 'lint'] }]], { pm: '/nonexistent/pm', cwd: tmpdir(), rel: 'src/a.ts', deadline: Date.now() + 5000 });
  assert.match(out[0], /^src\/a\.ts:1 HOOK could not run \/nonexistent\/pm lint/);
});

// A fake package manager that leaves a long-lived grandchild holding the stdout pipe: only a tree kill and a
// timer-driven resolve return in time.
test('runStages returns within the deadline even when a grandchild outlives the check', posix, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'post-edit-tree-'));
  const pm = join(dir, 'fake-pm');
  const pidFile = join(dir, 'grandchild.pid');
  await writeFile(pm, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setTimeout(() => {}, 60000);
`);
  await chmod(pm, 0o755);
  // 2.5 s headroom: the fake pm must start node and write the pid file before the deadline, even when the suite
  // runs test files in parallel; the return is still far below the 60 s grandchild.
  const deadlineMs = 2500;
  const started = Date.now();
  const out = await runStages([[{ name: 'lint', args: ['run', 'lint'] }]], { pm, cwd: dir, rel: 'src/a.ts', deadline: started + deadlineMs });
  assert.deepEqual(out, []);
  assert.ok(Date.now() - started < deadlineMs + 2000, 'returned at the deadline, not after the 60 s grandchild');
  const grandchildPid = Number(await readFile(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' }, 'grandchild was killed with the tree');
});
