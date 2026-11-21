// Tests for what home/hooks/typecheck-gate.mjs keeps outside one check: the shared budget and its timeouts, the build-info
// folder in the temp root (owner-only, a fresh run folder, no link followed, no FIFO waited on, the hash record), the run
// log (cap, the line that says it is full, a path that is not a plain file) and the edits a skipped check keeps. Fixtures:
// typecheck-gate-helpers.mjs. No test asserts elapsed time: a `Date.now()` here is a deadline handed to runGate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TS_ERROR, blocked, captured, fallbackRepo, installBin, outcomes, posix, runLines, sha256, sleepingTsc } from './typecheck-gate-helpers.mjs';
import { MAX_RUN_LOG_BYTES, decideExit, runGate, timeoutMessage } from '../home/hooks/typecheck-gate.mjs';
import { tempRoot } from '../home/hooks/lib/edit-log.mjs';
import { readTimeouts } from '../home/hooks/lib/typecheck-records.mjs';

const FOUND_NOTHING = { timedOut: false, lines: [], unparsed: [], unchecked: [], gaveUp: [], keep: [], timeouts: [] };
const COLD = 'cold: build info changed outside the gate';
// The build-info folder of a fixture's hook runs, and of runGate called in this process (tempRoot() of the test process).
const infoDir = (tmp) => join(tmp, 'claude-post-edit', 'tsbuildinfo');
const sharedFiles = async (dir) => (await readdir(dir)).filter((name) => /^[0-9a-f]{64}$/.test(name));

test('a check that outlives the budget is killed and logged as a timeout; the check after it is not started', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'src/deep/tsconfig.json': {}, 'src/deep/x.ts': 'export {};\n' });
  await sleepingTsc(fixture.repo);
  const files = [join(fixture.repo, 'src', 'a.ts'), join(fixture.repo, 'src', 'deep', 'x.ts')];
  const recorded = [];
  const result = await runGate(files, Date.now() + 500, (entry) => recorded.push(entry));
  assert.deepEqual({ ...result, timeouts: result.timeouts.length }, { ...FOUND_NOTHING, timedOut: true, unchecked: files, keep: files, timeouts: 1 });
  assert.deepEqual(recorded.map((entry) => [entry.outcome.split(' ')[0], entry.exit]), [['ran:', 'timeout'], ['skipped:', null]]);
  assert.equal(recorded[1].outcome, 'skipped: budget spent');
  assert.deepEqual(await readdir(join(tempRoot(), 'tsbuildinfo')).catch(() => []), [], 'the run folder of the killed run is removed');
});

test('runGate with the budget gone records skipped: budget spent for every package and keeps their files', async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'pkg/package.json': {}, 'pkg/y.ts': 'export {};\n' });
  const files = [join(fixture.repo, 'src', 'a.ts'), join(fixture.repo, 'pkg', 'y.ts')];
  const recorded = [];
  const result = await runGate(files, Date.now() - 1, (entry) => recorded.push(entry));
  assert.deepEqual(result, { ...FOUND_NOTHING, timedOut: true, unchecked: files, keep: files });
  assert.deepEqual(recorded.map((entry) => [entry.dir, entry.outcome, entry.exit]), [[fixture.repo, 'skipped: budget spent', null], [join(fixture.repo, 'pkg'), 'skipped: budget spent', null]]);
});

test('a timeout keeps the errors already found: the stop blocks on them with the timeout note under them', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {}, 'slow/package.json': {}, 'slow/tsconfig.json': {}, 'slow/b.ts': 'export {};\n' });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  await sleepingTsc(join(fixture.repo, 'slow'));
  const [failing, slow] = [join(fixture.repo, 'src', 'a.ts'), join(fixture.repo, 'slow', 'b.ts')];
  const result = await runGate([failing, slow], Date.now() + 8000);
  assert.deepEqual({ ...result, timeouts: result.timeouts.length }, { ...FOUND_NOTHING, timedOut: true, lines: ['src/a.ts:3 TS2322 x'], unchecked: [slow], keep: [failing, slow], timeouts: 1 });
  await mkdir(dirname(fixture.log), { recursive: true });
  const { stderr, exitCode } = captured(() => decideExit(result, fixture.log, false));
  assert.equal(exitCode, 2);
  assert.equal(stderr, blocked('src/a.ts:3 TS2322 x', timeoutMessage([slow])));
});

test('a check that timed out keeps its files for one more stop and is given up at the second timeout in a row', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await sleepingTsc(fixture.repo);
  const file = join(fixture.repo, 'src', 'a.ts');
  await mkdir(dirname(fixture.log), { recursive: true });
  const recorded = [];
  const stop = async () => runGate([file], Date.now() + 1500, (entry) => recorded.push(entry.outcome), readTimeouts(fixture.log));
  const first = await stop();
  assert.deepEqual({ ...first, timeouts: first.timeouts.length }, { ...FOUND_NOTHING, timedOut: true, unchecked: [file], keep: [file], timeouts: 1 });
  assert.match(captured(() => decideExit(first, fixture.log, false)).stdout, /timed out, not run for/);
  assert.equal(await readFile(fixture.log, 'utf8'), `${file}\n`);
  const second = await stop();
  assert.deepEqual(second, { ...FOUND_NOTHING, timedOut: true, gaveUp: [file] });
  assert.equal(recorded.at(-1), 'gave up: timed out twice');
  assert.match(JSON.parse(captured(() => decideExit(second, fixture.log, false)).stdout).systemMessage, /timed out twice, no longer checked at a stop: .*a\.ts/);
  assert.ok(!existsSync(fixture.log) && readTimeouts(fixture.log).size === 0, 'nothing is left to time out a third time');
});

test('a skip caused on purpose forgets no edit: once the cause is gone the next stop checks the file and blocks', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
  const bin = join(fixture.repo, 'node_modules', '.bin');
  fixture.edit('src/a.ts');
  await rename(bin, `${bin}.away`);
  assert.equal(fixture.stop().status, 0);
  await rename(`${bin}.away`, bin);
  assert.equal(fixture.stop().status, 2);
  assert.deepEqual((await outcomes(fixture)).map((outcome) => outcome.split(' -p ')[0]), ['skipped: no project tsc', 'ran: tsc --noEmit']);
});

test('the run log takes no line once it holds MAX_RUN_LOG_BYTES', posix, async () => {
  assert.equal(Number.isInteger(MAX_RUN_LOG_BYTES) && MAX_RUN_LOG_BYTES > 0, true);
  const fixture = await fallbackRepo({ 'package.json': {} });
  const oneLineShort = `${'x'.repeat(MAX_RUN_LOG_BYTES - 10)}\n`;
  await writeFile(fixture.runLog, oneLineShort);
  fixture.edit('src/a.ts');
  assert.equal(fixture.stop().status, 0);
  assert.equal(statSync(fixture.runLog).size, oneLineShort.length, 'a line that would pass the cap is not written');
});

test('a run log that has room for less than a line ends with one line that says it is full, filled to the cap', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {} });
  await writeFile(fixture.runLog, `${'x'.repeat(MAX_RUN_LOG_BYTES - 121)}\n`);
  fixture.edit('src/a.ts');
  for (let stop = 0; stop < 2; stop += 1) assert.equal(fixture.stop().status, 0);
  assert.equal(statSync(fixture.runLog).size, MAX_RUN_LOG_BYTES);
  const last = (await readFile(fixture.runLog, 'utf8')).trimEnd().split('\n').at(-1);
  assert.equal(JSON.parse(last).outcome, 'log full');
});

test('a link, a FIFO or a folder at the run-log path is never written, changes no decision and is reported in the guard log', posix, async () => {
  const plants = [
    ['link', async (path, root) => { await writeFile(join(root, 'elsewhere'), ''); await symlink(join(root, 'elsewhere'), path); }],
    ['FIFO', async (path) => assert.equal(spawnSync('mkfifo', [path]).status, 0)],
    ['folder', async (path) => mkdir(path)],
  ];
  for (const [kind, plant] of plants) {
    const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
    await installBin(fixture.repo, 'tsc', { output: [TS_ERROR], status: 2 });
    await plant(fixture.runLog, fixture.root);
    fixture.edit('src/a.ts');
    const guardLog = join(fixture.root, 'guard.jsonl');
    const r = fixture.stop({}, { CLAUDE_GUARD_LOG: guardLog });
    assert.equal(r.error, undefined, kind);
    assert.equal(r.status, 2, kind);
    if (kind === 'link') assert.equal(await readFile(join(fixture.root, 'elsewhere'), 'utf8'), '');
    assert.deepEqual((await runLines(guardLog)).map((line) => [line.hook, line.outcome]), [['typecheck-gate', 'run-log-unwritable']], kind);
  }
});

test('a FIFO at the shared build-info name does not hold the stop: the run is cold, logged, and publishes over it', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  fixture.edit('src/a.ts');
  const logged = (await readFile(fixture.log, 'utf8')).trim();
  const shared = join(infoDir(fixture.tmp), sha256(join(dirname(dirname(logged)), 'tsconfig.json')));
  await mkdir(dirname(shared), { recursive: true, mode: 0o700 });
  assert.equal(spawnSync('mkfifo', [shared]).status, 0);
  const r = fixture.stop();
  assert.equal(r.error, undefined, 'the hook ended by itself');
  assert.equal(r.status, 0);
  assert.deepEqual((await outcomes(fixture)).map((outcome) => outcome.split(' -p ')[0]), [COLD, 'ran: tsc --noEmit']);
  assert.ok((await stat(shared)).isFile());
});

test('links at the shared and the old private build-info names are replaced, never written through', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  const shared = join(join(tempRoot(), 'tsbuildinfo'), sha256(join(fixture.repo, 'tsconfig.json')));
  await mkdir(dirname(shared), { recursive: true, mode: 0o700 });
  const targets = [join(fixture.root, 'shared-target'), join(fixture.root, 'private-target')];
  for (const target of targets) await writeFile(target, 'keep');
  await symlink(targets[0], shared);
  await symlink(targets[1], `${shared}.${process.pid}`);
  const recorded = [];
  assert.deepEqual(await runGate([join(fixture.repo, 'src', 'a.ts')], Date.now() + 20_000, (entry) => recorded.push(entry.outcome)), FOUND_NOTHING);
  for (const target of targets) assert.equal(await readFile(target, 'utf8'), 'keep', target);
  assert.equal(recorded[0], COLD);
  assert.equal(await readFile(shared, 'utf8'), 'info', 'the published build info replaced the link');
});

test('an open build-info folder is emptied and made owner-only; a link at its name is not used, and the run still gets a private file', posix, async () => {
  const open = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(open.repo, 'tsc');
  await mkdir(infoDir(open.tmp), { recursive: true });
  await chmod(infoDir(open.tmp), 0o755);
  await writeFile(join(infoDir(open.tmp), 'planted'), '');
  open.edit('src/a.ts');
  assert.equal(open.stop().status, 0);
  assert.equal((await stat(infoDir(open.tmp))).mode & 0o777, 0o700);
  assert.ok(!existsSync(join(infoDir(open.tmp), 'planted')));
  const linked = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(linked.repo, 'tsc');
  const elsewhere = join(linked.root, 'elsewhere');
  await mkdir(elsewhere);
  await mkdir(join(linked.tmp, 'claude-post-edit'));
  await symlink(elsewhere, infoDir(linked.tmp));
  linked.edit('src/a.ts');
  assert.equal(linked.stop().status, 0);
  const [{ args }] = await linked.checks();
  assert.ok(args.includes('--tsBuildInfoFile') && !args[args.indexOf('--tsBuildInfoFile') + 1].startsWith(infoDir(linked.tmp)), 'the redirect stays, outside the untrusted folder');
  assert.deepEqual(await readdir(elsewhere), [], 'nothing seeded or published there');
});

test('a shared build info rewritten outside the gate is not used: the run is cold and says so; an untouched one seeds the next run', posix, async () => {
  const fixture = await fallbackRepo({ 'package.json': {}, 'tsconfig.json': {} });
  await installBin(fixture.repo, 'tsc');
  const stop = async () => { fixture.edit('src/a.ts'); assert.equal(fixture.stop().status, 0); };
  await stop();
  await stop();
  const [shared] = await sharedFiles(infoDir(fixture.tmp));
  await writeFile(join(infoDir(fixture.tmp), shared), 'forged');
  await stop();
  assert.deepEqual((await fixture.checks()).map((call) => call.seeded), [false, true, false]);
  assert.deepEqual((await outcomes(fixture)).map((outcome) => outcome.split(' -p ')[0]), ['ran: tsc --noEmit', 'ran: tsc --noEmit', COLD, 'ran: tsc --noEmit']);
});
