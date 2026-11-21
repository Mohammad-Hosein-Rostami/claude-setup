// Tests for the tsconfig step of home/hooks/typecheck-gate.mjs (a package without a usable typecheck script): which
// tsconfig, which tsc, the command and its redirect, the skip reasons and which diagnostics count for a logged file
// (typescriptMajor is tested in typecheck-gate-nx.test.mjs, beside the Nx version). Fixtures and the fake binaries: typecheck-gate-helpers.mjs (fake node scripts, no TypeScript installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_LIB, TS_ERROR, blocked, fallbackRepo, installBin, outcomes, posix } from './typecheck-gate-helpers.mjs';

const A_LINE = 'src/a.ts:3 TS2322 x';
// What the gate adds to `--noEmit -p <tsconfig>` after the build info: plain output, no clash with emitDeclarationOnly, the program's files.
const TAIL = ['--pretty', 'false', '--emitDeclarationOnly', 'false', '--listFiles'];
const tsconfigArgs = (tsconfig, info) => ['--noEmit', '-p', tsconfig, '--incremental', '--tsBuildInfoFile', info, ...TAIL];

test('a package with a tsconfig.json and no typecheck script: post-edit logs the edit, tsc --noEmit runs and its error about the edited file blocks the stop', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'src/b.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc', { output: ['noise', 'src/b.ts(1,1): error TS2322: elsewhere', TS_ERROR], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, blocked(A_LINE), 'only the line about the logged file reaches the agent');
  const [line, ...rest] = await fixture.runs();
  assert.deepEqual(rest, []);
  assert.match(line.outcome, /^ran: tsc --noEmit -p /);
  assert.ok(line.outcome.includes(join(fixture.repo, 'tsconfig.json')));
  assert.deepEqual({ session: line.session, agent: line.agent, dir: line.dir, exit: line.exit }, { session: 's1', agent: 'main', dir: fixture.repo, exit: 2 });
  assert.equal(typeof line.ms, 'number');
  assert.ok(!Number.isNaN(Date.parse(line.ts)));
  assert.ok(existsSync(fixture.log), 'the edit log stays so the next stop checks again');
});

test('a package with neither a typecheck script nor a tsconfig is skipped with the reason, the stop passes and its edit stays logged', async () => {
  const fixture = await fallbackRepo({ 'package.json': {} });
  fixture.edit('src/a.ts');
  const r = fixture.stop({ hook_event_name: 'SubagentStop' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  const [line, ...rest] = await fixture.runs();
  assert.deepEqual(rest, []);
  assert.deepEqual({ outcome: line.outcome, exit: line.exit, dir: line.dir }, { outcome: 'skipped: no tsconfig', exit: null, dir: fixture.repo });
  assert.ok(existsSync(fixture.log), 'a package skipped before any check keeps its entries');
});

test('a tsc planted one level above the git top is not run: skipped: no project tsc', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} }, { git: true });
  await installBin(join(fixture.root, 'outer'), 'tsc', { output: [TS_ERROR], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await fixture.calls(), [], 'the planted tsc never ran');
  assert.deepEqual(await outcomes(fixture), ['skipped: no project tsc']);
});

test('a tsc hoisted to the git top is found from a package below it', posix, async () => {
  const fixture = await fallbackRepo({ 'packages/app/package.json': {}, 'packages/app/tsconfig.json': {}, 'packages/app/src/a.ts': 'export {};\n' }, { git: true });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  fixture.edit('packages/app/src/a.ts');
  assert.equal(fixture.stop().status, 2);
  const [call] = await fixture.checks();
  assert.equal(call.cwd.endsWith(join('repo', 'packages', 'app')), true, 'tsc runs in the package folder');
});

test('a plain tsc typecheck script is not extended with a tsc found above the git top', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': { scripts: { typecheck: 'tsc --noEmit' } } }, { git: true });
  await installBin(join(fixture.root, 'outer'), 'tsc');
  fixture.edit('src/a.ts');
  fixture.stop();
  const direct = (await fixture.calls()).filter((call) => call.args.includes('--tsBuildInfoFile'));
  assert.deepEqual(direct, [], 'the gate itself never starts a tsc from above the git top');
  assert.deepEqual(await outcomes(fixture), ['ran: npm run typecheck']);
});

test('the nearest tsconfig is the first tsconfig.json from the edited file\'s folder up to its package folder, never one above it', posix, async () => {
  const fixture = await fallbackRepo(
    { 'package.json': {}, 'tsconfig.json': {}, 'src/deep/tsconfig.json': {}, 'src/deep/x.ts': 'export {};\n', 'pkg/package.json': {}, 'pkg/src/y.ts': 'export {};\n' },
    { git: true },
  );
  await installBin(fixture.repo, 'tsc');
  for (const path of ['src/a.ts', 'src/deep/x.ts', 'pkg/src/y.ts']) fixture.edit(path);
  assert.equal(fixture.stop().status, 0);
  const projects = (await fixture.checks()).map((call) => call.args[call.args.indexOf('-p') + 1]);
  assert.deepEqual(projects.sort(), [join(fixture.repo, 'src', 'deep', 'tsconfig.json'), join(fixture.repo, 'tsconfig.json')].sort());
  const lines = await fixture.runs();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.filter((line) => line.dir === join(fixture.repo, 'pkg')).map((line) => line.outcome), ['skipped: no tsconfig'], 'the tsconfig above the package folder is not used');
});

test('a solution tsconfig (references and no files of its own) is skipped, never reported as run', posix, async () => {
  const solutions = [
    '// the Vite template\n{ "files": [], /* none */ "references": [{ "path": "./tsconfig.app.json" }], }\n',
    '{ "include": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    '{ "files": [], "include": [], "references": [{ "path": "./tsconfig.app.json" }] }',
  ];
  for (const tsconfig of solutions) {
    const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': tsconfig });
    await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
    fixture.edit('src/a.ts');
    assert.equal(fixture.stop().status, 0, tsconfig);
    assert.deepEqual(await fixture.calls(), [], tsconfig);
    assert.deepEqual(await outcomes(fixture), ['skipped: solution tsconfig'], tsconfig);
  }
});

test('a tsconfig with project references and files of its own is skipped (tsc -p would judge it against built output); one without references is checked', posix, async () => {
  const cases = [
    ['{ "include": ["src"], "references": [{ "path": "./other" }] }', 0, ['skipped: project references']],
    ['{ "files": [], "include": ["src"], "references": [{ "path": "./other" }] }', 0, ['skipped: project references']],
    ['{ "files": [] }', 2, null],
  ];
  for (const [tsconfig, status, expected] of cases) {
    const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': tsconfig });
    await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
    fixture.edit('src/a.ts');
    assert.equal(fixture.stop().status, status, tsconfig);
    if (expected) assert.deepEqual([await fixture.calls(), await outcomes(fixture)], [[], expected], tsconfig);
  }
});

test('a tsconfig.json that cannot be read as one (not JSON, a folder, a FIFO) is skipped and the hook does not wait on it', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': 'not json', 'lib/package.json': {}, 'lib/tsconfig.json/keep': '', 'lib/b.ts': 'export {};\n', 'fifo/package.json': {}, 'fifo/c.ts': 'export {};\n', 'list/package.json': {}, 'list/tsconfig.json': '[]', 'list/d.ts': 'export {};\n' });
  assert.equal(spawnSync('mkfifo', [join(fixture.repo, 'fifo', 'tsconfig.json')]).status, 0);
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'lib/b.ts', 'fifo/c.ts', 'list/d.ts']) fixture.edit(path);
  const r = fixture.stop();
  assert.equal(r.error, undefined, 'the hook ended by itself');
  assert.equal(r.status, 0);
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(await outcomes(fixture), Array(4).fill('skipped: unreadable tsconfig'));
});

// Every file under `folder`, as sorted relative paths.
const filesUnder = async (folder) => (await readdir(folder, { recursive: true })).sort();

test('the tsconfig run asks for the resolved config first, sends the build info to a private run folder and writes nothing in the project', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { compilerOptions: { composite: true, tsBuildInfoFile: './own.tsbuildinfo' } } });
  await installBin(fixture.repo, 'tsc');
  fixture.edit('src/a.ts');
  const before = await filesUnder(fixture.repo);
  assert.equal(fixture.stop().status, 0);
  const tsconfig = join(fixture.repo, 'tsconfig.json');
  const [config, { args }] = await fixture.calls();
  assert.deepEqual(config.args, ['--showConfig', '-p', tsconfig]);
  const info = args[5];
  assert.deepEqual(args, tsconfigArgs(tsconfig, info));
  assert.match(info, new RegExp(`^${join(fixture.tmp, 'claude-post-edit', 'tsbuildinfo', 'run-')}[^/]+/info$`));
  assert.deepEqual(await filesUnder(fixture.repo), before);
  assert.ok(!existsSync(info), 'no private build info left behind');
});

test('errors in a file of the same name outside the edited file (a sibling package, the package root) never block', posix, async () => {
  const shapes = [
    ['packages/a', '../b/src/index.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'.'],
    ['packages/a', 'index.ts(1,14): error TS2322: at the package root'],
  ];
  for (const [pkg, line] of shapes) {
    const fixture = await fallbackRepo({ [`${pkg}/package.json`]: {}, [`${pkg}/tsconfig.json`]: {}, [`${pkg}/src/index.ts`]: 'export {};\n', [`${pkg}/index.ts`]: '', 'packages/b/src/index.ts': '' }, { git: true });
    await installBin(fixture.repo, 'tsc', { output: [line], status: 2 });
    fixture.edit(`${pkg}/src/index.ts`);
    const r = fixture.stop();
    assert.equal(r.status, 0, line);
    assert.equal(r.stderr, '', line);
    assert.deepEqual((await fixture.runs()).map((entry) => [entry.outcome.split(' -p ')[0], entry.exit]), [['ran: tsc --noEmit', 2]], line);
  }
});

test('a tsc that rejects the tsconfig options (TS5053) and checks nothing is a message to the user, never silence', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc', { output: ["tsconfig.json(4,3): error TS5053: Option 'emitDeclarationOnly' cannot be specified with option 'noEmit'."], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /typecheck may not run\ntsconfig\.json:4 TS5053 Option 'emitDeclarationOnly'/);
});

test('a logged file outside the tsconfig\'s program is skipped: not in tsconfig, never a block; a listed one is checked', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { include: ['src'] }, 'scripts/build.ts': 'export {};\n' });
  const listed = [join(fixture.repo, 'src', 'a.ts'), '/lib/lib.es5.d.ts'];
  await installBin(fixture.repo, 'tsc', { output: ['scripts/build.ts(3,1): error TS2322: x', TS_ERROR], status: 2, listed });
  for (const path of ['src/a.ts', 'scripts/build.ts']) fixture.edit(path);
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, blocked(A_LINE), 'only the listed file is judged');
  assert.deepEqual((await outcomes(fixture)).map((outcome) => outcome.split(' -p ')[0]), ['ran: tsc --noEmit', 'skipped: not in tsconfig']);
  const clean = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { include: ['src'] }, 'scripts/build.ts': 'export {};\n' });
  await installBin(clean.repo, 'tsc', { listed: [join(clean.repo, 'src', 'b.ts')] });
  clean.edit('scripts/build.ts');
  assert.equal(clean.stop().status, 0);
  assert.deepEqual((await outcomes(clean)).map((outcome) => outcome.split(' -p ')[0]), ['ran: tsc --noEmit', 'skipped: not in tsconfig']);
  assert.ok(!existsSync(clean.log), 'a file that is in no program is not checked again');
});

test('a tsconfig with `pretty` cannot hide its errors: the command asks for plain output', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { compilerOptions: { pretty: true } } });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], pretty: ['\u001b[96msrc/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m TS2322: x'], status: 2 });
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, blocked(A_LINE));
});

test('a tsconfig whose resolved config sets generateTrace (also through extends) is skipped; a config tsc cannot resolve is a message', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { extends: './base.json' }, 'base.json': { compilerOptions: { generateTrace: '../trace-out' } } });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2, showConfig: { compilerOptions: { generateTrace: '../trace-out' } } });
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 0);
  assert.deepEqual([await fixture.checks(), await outcomes(fixture)], [[], ['skipped: tsconfig writes a trace']]);
  const broken = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': { extends: './missing.json' } });
  await installBin(broken.repo, 'tsc', { output: [TS_ERROR], status: 2, showConfig: "error TS5083: Cannot read file 'missing.json'.", showConfigStatus: 1 });
  broken.edit('src/a.ts');
  const r = broken.stop();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /TS5083/);
  assert.deepEqual([await broken.checks(), await outcomes(broken)], [[], ['skipped: unreadable tsconfig']]);
});

test('a typescript the gate cannot redirect (an unknown major) is skipped, never run without the redirect', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2, tsVersion: '7.0.0' });
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 0);
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual(await outcomes(fixture), ['skipped: unsupported typescript version']);
});

test('CLAUDE_POST_EDIT_SKIP writes skipped: skip env for each package, runs nothing and keeps the edit log', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'pkg/package.json': {}, 'pkg/y.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'pkg/y.ts']) fixture.edit(path);
  const r = fixture.stop({}, { CLAUDE_POST_EDIT_SKIP: 'typecheck' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(await fixture.calls(), []);
  assert.deepEqual((await fixture.runs()).map((line) => [line.dir, line.outcome, line.exit]), [[fixture.repo, 'skipped: skip env', null], [join(fixture.repo, 'pkg'), 'skipped: skip env', null]]);
  assert.ok(existsSync(fixture.log));
});

test('a skipped package does not hide a failing one: the stop blocks and the run log names both', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'pkg/package.json': {}, 'pkg/tsconfig.json': {}, 'pkg/src/a.ts': 'export {};\n' });
  await installBin(join(fixture.repo, 'pkg'), 'tsc', { output: [TS_ERROR], status: 2 });
  for (const path of ['src/a.ts', 'pkg/src/a.ts']) fixture.edit(path);
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.equal(r.stderr, blocked(A_LINE));
  assert.deepEqual((await fixture.runs()).map((line) => [line.dir, line.outcome.split(' -p ')[0], line.exit]), [[fixture.repo, 'skipped: no tsconfig', null], [join(fixture.repo, 'pkg'), 'ran: tsc --noEmit', 2]]);
});

test('a tsc that cannot be started is exit "error" in the run log and a message to the user, never a block', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  await chmod(join(fixture.repo, 'node_modules', '.bin', 'tsc'), 0o644);
  fixture.edit('src/a.ts');
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /could not run typecheck/);
  assert.deepEqual((await fixture.runs()).map((line) => line.exit), ['error']);
  assert.ok(existsSync(fixture.log), 'a check that could not start forgets no edit');
});

test('on win32 a tsconfig command is skipped when a path cannot go through the unquoted shell', async () => {
  const { tsconfigTypecheck } = await import(PLAN_LIB);
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  const tsc = join(fixture.repo, 'node_modules', '.bin', 'tsc');
  const tsconfig = join(fixture.repo, 'tsconfig.json');
  for (const platform of ['linux', 'win32']) assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, '/t/info', platform)?.args, tsconfigArgs(tsconfig, '/t/info'), platform);
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, 'C:\\Users\\Jo Doe\\info', 'win32'), { skipped: 'unsafe path on Windows' });
  assert.deepEqual(tsconfigTypecheck(tsconfig, tsc, '/t/100%/info', 'win32'), { skipped: 'unsafe path on Windows' });
});
