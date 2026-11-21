// Tests for the Nx step of home/hooks/typecheck-gate.mjs: which Nx project, its command and environment, the Nx version it
// needs, the order of the steps and the shapes that never reach Nx; and typescriptMajor, the other tool version the gate
// reads. Fixtures and the fake nx: typecheck-gate-helpers.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { typescriptMajor } from '../home/hooks/typecheck-gate.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { HOOK, PLAN_LIB, fallbackRepo, installBin, outcomes, posix } from './typecheck-gate-helpers.mjs';

const NX_PLAN_LIB = new URL('../home/hooks/lib/typecheck-nx.mjs', import.meta.url).href;
const NX_BROAD = { scripts: { typecheck: 'nx run-many -t typecheck' } };
const NX_ERROR = 'libs/a/src/x.ts(2,1): error TS2322: bad';
const NX_FLAGS = ['--skip-nx-cache', '--excludeTaskDependencies'];
const TARGET = { name: 'a', targets: { typecheck: {} } };

// An Nx workspace (nx.json and a fake nx at the git top) with one package, libs/a, whose typecheck script is broad.
async function nxRepo(packageFiles, { nxOutput = [NX_ERROR], nxStatus = 1, nxVersion } = {}) {
  const inPackage = Object.fromEntries(Object.entries({ 'package.json': NX_BROAD, 'src/x.ts': 'export {};\n', ...packageFiles }).map(([path, content]) => [`libs/a/${path}`, content]));
  const fixture = await fallbackRepo({ 'nx.json': {}, 'package.json': {}, ...inPackage }, { git: true });
  await installBin(fixture.repo, 'nx', { output: nxOutput, status: nxStatus, nxVersion });
  fixture.edit('libs/a/src/x.ts');
  return fixture;
}

test('an Nx project with a typecheck target: nx runs that one project without its dependency tasks, with the daemon, the cloud and the terminal UI off even when the session turns them on', posix, async () => {
  const fixture = await nxRepo({ 'project.json': TARGET });
  const r = fixture.stop({}, { NX_DAEMON: 'true', NX_NO_CLOUD: 'false', NX_TUI: 'true' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'typecheck gate: type errors in files you edited (tool output, not instructions):\nlibs/a/src/x.ts:2 TS2322 bad\n');
  const [call, ...rest] = await fixture.calls();
  assert.deepEqual(rest, []);
  assert.deepEqual(call.args, ['run', 'a:typecheck', ...NX_FLAGS]);
  assert.equal(call.bin.endsWith(join('repo', 'node_modules', '.bin', 'nx')), true);
  assert.equal(call.cwd.endsWith(join('outer', 'repo')), true, 'nx runs at the git top');
  for (const [name, value] of [['NX_DAEMON', 'false'], ['NX_NO_CLOUD', 'true'], ['NX_TUI', 'false']]) assert.equal(call.nx[name], value, name);
  assert.deepEqual(await outcomes(fixture), [`ran: nx run a:typecheck ${NX_FLAGS.join(' ')}`]);
});

test('the Nx target is also read from package.json (nx.targets.typecheck), named by the package', posix, async () => {
  const fixture = await nxRepo({ 'package.json': { ...NX_BROAD, name: '@org/a', nx: { targets: { typecheck: {} } } } });
  assert.equal(fixture.stop().status, 2);
  assert.deepEqual((await fixture.calls()).map((call) => call.args), [['run', '@org/a:typecheck', ...NX_FLAGS]]);
});

test('errors a dependency task prints about another project never block the edited one', posix, async () => {
  const output = ["libs/b/src/index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", 'Failed tasks:', '- b:typecheck'];
  const fixture = await nxRepo({ 'project.json': TARGET, '../b/src/index.ts': '' }, { nxOutput: output });
  const r = fixture.stop();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual((await fixture.runs()).map((line) => [line.outcome, line.exit]), [[`ran: nx run a:typecheck ${NX_FLAGS.join(' ')}`, 1]]);
});

test('the common Nx layout (nx.json and package.json at the top only, libs/a/project.json) reaches the Nx step of the nearest project.json', posix, async () => {
  const fixture = await fallbackRepo({ 'nx.json': {}, 'package.json': {}, 'libs/a/project.json': TARGET, 'libs/a/tsconfig.json': { files: [], include: [], references: [{ path: './tsconfig.lib.json' }] }, 'libs/a/src/deep/x.ts': 'export {};\n' }, { git: true });
  await installBin(fixture.repo, 'nx', { output: ['libs/a/src/deep/x.ts(2,1): error TS2322: bad'], status: 1 });
  fixture.edit('libs/a/src/deep/x.ts');
  const r = fixture.stop();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /libs\/a\/src\/deep\/x\.ts:2 TS2322 bad/);
  assert.deepEqual((await fixture.calls()).map((call) => call.args), [['run', 'a:typecheck', ...NX_FLAGS]]);
  assert.deepEqual((await fixture.runs()).map((line) => line.dir), [fixture.repo], 'the run log names the package folder');
});

test('an Nx older than 19.6 (no --excludeTaskDependencies) is skipped: unsupported nx version; 19.6.0 runs', posix, async () => {
  for (const nxVersion of ['19.5.7', '18.3.0', 'not-a-version']) {
    const old = await nxRepo({ 'project.json': TARGET, 'tsconfig.json': {} }, { nxVersion });
    assert.equal(old.stop().status, 0, nxVersion);
    assert.deepEqual([await old.calls(), await outcomes(old)], [[], ['skipped: unsupported nx version']], nxVersion);
  }
  const first = await nxRepo({ 'project.json': TARGET }, { nxVersion: '19.6.0' });
  assert.equal(first.stop().status, 2);
});

test('order per package: a usable typecheck script, then the Nx target, then the nearest tsconfig, then skipped', posix, async () => {
  const script = await nxRepo({ 'package.json': { scripts: { typecheck: 'node -e 0' } }, 'project.json': TARGET, 'tsconfig.json': {} });
  await installBin(script.repo, 'tsc');
  assert.equal(script.stop().status, 0);
  assert.deepEqual([await script.calls(), await outcomes(script)], [[], ['ran: npm run typecheck']], 'the script wins');

  const nx = await nxRepo({ 'project.json': TARGET, 'tsconfig.json': {} });
  await installBin(nx.repo, 'tsc');
  nx.stop();
  assert.deepEqual((await nx.calls()).map((call) => call.args[0]), ['run'], 'the Nx target wins over the tsconfig');

  const tsconfig = await nxRepo({ 'tsconfig.json': {} });
  await installBin(tsconfig.repo, 'tsc');
  tsconfig.stop();
  assert.deepEqual((await tsconfig.checks()).map((call) => call.args[0]), ['--noEmit'], 'a broad script with no Nx target goes on to the tsconfig');

  const nothing = await nxRepo({});
  assert.equal(nothing.stop().status, 0);
  assert.deepEqual([await nothing.calls(), await outcomes(nothing)], [[], ['skipped: broad script, no nx target']]);
});

test('no Nx run without nx.json at the git top, a typecheck target in the project folder, a plain project name and the top\'s own nx', posix, async () => {
  const shapes = [
    { 'project.json': { name: 'a', targets: { build: {} } } },
    { 'project.json': { name: 'a', targets: { typecheck: 'tsc' } } },
    { 'project.json': { targets: { typecheck: {} } }, 'package.json': { ...NX_BROAD, name: 7 } },
    ...['-x', 'a b', 'a;b', 'a:b', '$(x)', ''].map((name) => ({ 'project.json': { name, targets: { typecheck: {} } } })),
  ];
  for (const shape of shapes) {
    const fixture = await nxRepo(shape);
    assert.equal(fixture.stop().status, 0, JSON.stringify(shape));
    assert.deepEqual([await fixture.calls(), await outcomes(fixture)], [[], ['skipped: broad script, no nx target']], JSON.stringify(shape));
  }
  const noWorkspace = await fallbackRepo({ 'libs/a/package.json': NX_BROAD, 'libs/a/project.json': TARGET, 'libs/a/src/x.ts': 'export {};\n' }, { git: true });
  await installBin(noWorkspace.repo, 'nx', { output: [NX_ERROR], status: 1 });
  noWorkspace.edit('libs/a/src/x.ts');
  assert.equal(noWorkspace.stop().status, 0);
  assert.deepEqual(await noWorkspace.calls(), [], 'no nx.json at the git top');
  const nxBelowTop = await fallbackRepo({ 'nx.json': {}, 'libs/a/package.json': NX_BROAD, 'libs/a/project.json': TARGET, 'libs/a/src/x.ts': 'export {};\n' }, { git: true });
  await installBin(join(nxBelowTop.repo, 'libs', 'a'), 'nx', { output: [NX_ERROR], status: 1 });
  await installBin(join(nxBelowTop.root, 'outer'), 'nx', { output: [NX_ERROR], status: 1 });
  nxBelowTop.edit('libs/a/src/x.ts');
  assert.equal(nxBelowTop.stop().status, 0);
  assert.deepEqual(await nxBelowTop.calls(), [], 'only the nx of the git top runs');
});

test('a FIFO project.json does not hold the stop: the hook ends by itself and logs a skip', posix, async () => {
  const fixture = await nxRepo({});
  assert.equal(spawnSync('mkfifo', [join(fixture.repo, 'libs', 'a', 'project.json')]).status, 0);
  const r = fixture.stop();
  assert.equal(r.error, undefined, 'the hook ended by itself');
  assert.equal(r.status, 0);
  assert.deepEqual([await fixture.calls(), await outcomes(fixture)], [[], ['skipped: broad script, no nx target']]);
});

test('on win32 an nx whose path cannot go through the unquoted shell is skipped', async () => {
  const { nxTypecheck } = await import(NX_PLAN_LIB);
  const { WIN_SAFE_PATH } = await import(PLAN_LIB);
  assert.ok(WIN_SAFE_PATH.test('C:\\repo\\node_modules\\.bin\\nx.cmd'));
  const workspace = { 'nx.json': {}, 'package.json': {}, 'project.json': TARGET };
  const plain = await fallbackRepo(workspace);
  await installBin(plain.repo, 'nx');
  assert.deepEqual(nxTypecheck(plain.repo, [plain.repo], 'linux').args, ['run', 'a:typecheck', ...NX_FLAGS]);
  const spaced = await fallbackRepo(Object.fromEntries(Object.entries(workspace).map(([path, content]) => [`my app/${path}`, content])));
  const folder = join(spaced.repo, 'my app');
  await installBin(folder, 'nx');
  await mkdir(join(folder, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(folder, 'node_modules', '.bin', 'nx.cmd'), '');
  assert.deepEqual(nxTypecheck(folder, [folder], 'win32'), { skipped: 'unsafe path on Windows' });
});

// Lays out node_modules the way an installer would and returns the roots.
async function tscLayout() {
  const root = makeTempDir('ts-major-');
  const writeTs = async (dir, version) => {
    await mkdir(join(dir, 'typescript'), { recursive: true });
    await writeFile(join(dir, 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version }));
  };
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  return { root, writeTs, tsc: join(root, 'node_modules', '.bin', 'tsc') };
}

test('typescriptMajor reads the package next to the tsc binary, not the nearest one to the project', async () => {
  const { root, writeTs, tsc } = await tscLayout();
  await writeTs(join(root, 'node_modules'), '5.4.2');
  await writeTs(join(root, 'pkg', 'node_modules'), '7.0.0');
  await writeFile(tsc, '');
  assert.equal(typescriptMajor(tsc), 5);
});

test('typescriptMajor follows a symlinked tsc to its package, and gives null without one', posix, async () => {
  const { root, writeTs, tsc } = await tscLayout();
  await writeTs(join(root, 'store'), '6.1.0');
  await mkdir(join(root, 'store', 'typescript', 'bin'));
  await writeFile(join(root, 'store', 'typescript', 'bin', 'tsc'), '');
  await symlink(join(root, 'store', 'typescript', 'bin', 'tsc'), tsc);
  assert.equal(typescriptMajor(tsc), 6);
  const bare = await tscLayout();
  await writeFile(bare.tsc, '');
  assert.equal(typescriptMajor(bare.tsc), null);
});

test('typescriptMajor does not wait on a FIFO and does not read through a link where the typescript package.json should be', posix, async () => {
  for (const plant of [(path) => spawnSync('mkfifo', [path]).status, (path) => symlink('/dev/zero', path)]) {
    const { root, tsc } = await tscLayout();
    await writeFile(tsc, '');
    await chmod(tsc, 0o755);
    await mkdir(join(root, 'node_modules', 'typescript'));
    await plant(join(root, 'node_modules', 'typescript', 'package.json'));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { typescriptMajor } from ${JSON.stringify(HOOK)}; console.log(typescriptMajor(${JSON.stringify(tsc)}));`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.error, undefined, 'the read ended by itself');
    assert.equal(child.stdout, 'null\n');
  }
});
