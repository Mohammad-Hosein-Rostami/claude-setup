// Contract tests of runPlan(plan, scope, { deadlineMs, dir? }) in the done-check's lib/run-checks.mjs, written from the design (road newchk,
// sections 3.2, 3.3, 5 and 6) apart from the code: it runs each planned command without a shell, in a pool, under one deadline, and turns
// the tool's own output file into a CheckResult. Plans are written by hand here (no detect.mjs), the tools are the fixture's fake
// tsc/eslint/vitest/jest and the real `node --test`, all in throw-away projects with a temp HOME. Red until the engine lands (step 3).
// Two cases need a neighbour lib: the changed-lines lint case uses scope.mjs `changedLines` (the engine reads it, runPlan has no other way).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { POOL_SIZE } from '../home/tools/done-check/lib/contract.mjs';
import { runPlan } from '../home/tools/done-check/lib/run-checks.mjs';
import { FAKE_TOOLS, makeDoneCheckRepo, nodeTestSource } from './done-check-fixture.mjs';

const DEADLINE_MS = 30_000; // a roomy cap for cases that must finish by themselves
const SHORT_DEADLINE_MS = 3_000; // for the kill cases: the tool sleeps for a minute
const SLEEP_MS = 60_000;
const KILL_WAIT_STEP_MS = 50;
const KILL_WAIT_TRIES = 60; // 3 s in all: a killed process is gone well before that
const TSC_ERROR = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";

// The tests run inside `node --test`; a nested `node --test` that sees this variable would not print TAP. Scrubbed for the whole file.
const savedContext = process.env.NODE_TEST_CONTEXT;
before(() => { delete process.env.NODE_TEST_CONTEXT; });
after(() => { if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext; });

function project(t, options) {
  const repo = makeDoneCheckRepo(options);
  t.after(() => repo.cleanup());
  return repo;
}
const outputPath = (repo, name) => {
  const file = join(repo.dir, '..', 'out', name);
  mkdirSync(join(repo.dir, '..', 'out'), { recursive: true });
  return file;
};
const fakeCmd = (repo, kind, tool, args = [], more = {}) => ({ kind, argv: [process.execPath, join(repo.dir, 'node_modules', FAKE_TOOLS[tool].folder, FAKE_TOOLS[tool].entry), ...args], cwd: repo.dir, shell: false, label: tool, ...more });
const vitestCmd = (repo) => { const outputFile = outputPath(repo, 'vitest.json'); return fakeCmd(repo, 'tests', 'vitest', ['related', '--run', '--reporter=json', '--outputFile', outputFile, '--passWithNoTests', 'src/a.ts'], { outputFile }); };
const jestCmd = (repo) => { const outputFile = outputPath(repo, 'jest.json'); return fakeCmd(repo, 'tests', 'jest', ['--findRelatedTests', 'src/a.ts', '--json', '--outputFile', outputFile, '--passWithNoTests'], { outputFile }); };
const planOf = (repo, cmds) => ({ packages: [{ root: repo.dir, pm: 'npm', cmds }], skipped: [], fingerprint: 'test' });
const scopeOf = (repo, files = []) => ({ top: repo.dir, git: true, base: repo.baseSha, files, wide: [], key: 'k' });
const run = (repo, cmds, options = {}) => runPlan(planOf(repo, cmds), scopeOf(repo, ['src/a.ts']), { deadlineMs: DEADLINE_MS, ...options });
const resultOf = (results, kind) => results.find((result) => result.kind === kind);
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function assertGone(pid, what) {
  for (let tries = 0; tries < KILL_WAIT_TRIES && isAlive(pid); tries += 1) await sleep(KILL_WAIT_STEP_MS);
  if (isAlive(pid)) { process.kill(pid, 'SIGKILL'); assert.fail(`${what} (pid ${pid}) outlived the deadline`); }
}
const vitestJson = (repo, tests) => JSON.stringify({
  numTotalTests: tests.length, numFailedTests: tests.filter((one) => one.status === 'failed').length, success: tests.every((one) => one.status === 'passed'),
  testResults: [{ name: join(repo.dir, 'tests/a.test.ts'), status: tests.some((one) => one.status === 'failed') ? 'failed' : 'passed', message: '',
    assertionResults: tests.map(({ title, status }) => ({ ancestorTitles: ['suite'], fullName: `suite ${title}`, title, status, failureMessages: status === 'failed' ? ['AssertionError: expected 1 to be 2'] : [] })) }],
});
const eslintJson = (repo, messages) => JSON.stringify([{ filePath: join(repo.dir, 'src/a.ts'), messages: messages.map(([line, severity]) => ({ ruleId: 'no-unused-vars', severity, message: `problem on line ${line}`, line, column: 1 })), errorCount: 0, warningCount: 0 }]);

// ---- reading each tool's output ----

test('tsc diagnostics become a failed types check with the id file|TScode|message (line kept apart)', async (t) => {
  const repo = project(t, { tools: ['tsc'], replay: { tsc: { stdout: TSC_ERROR, exit: 2 } } });
  const result = resultOf(await run(repo, [fakeCmd(repo, 'types', 'tsc', ['--noEmit', '--pretty', 'false'])]), 'types');
  assert.equal(result.result, 'fail');
  assert.equal(result.label, 'tsc');
  assert.equal(typeof result.ms, 'number');
  assert.deepEqual(result.failures.map(({ kind, id, file, line }) => ({ kind, id, file, line })), [{ kind: 'types', id: "src/a.ts|TS2322|Type 'string' is not assignable to type 'number'.", file: 'src/a.ts', line: 3 }]);
});

test('a tsc run that exits 0 with no output is ok; exit 2 with output nobody can read is not run (error), never ok', async (t) => {
  const repo = project(t, { tools: ['tsc'], replay: { tsc: { exit: 0 } } });
  assert.equal(resultOf(await run(repo, [fakeCmd(repo, 'types', 'tsc')]), 'types').result, 'ok');
  repo.setTool('tsc', { stdout: 'Segmentation noise, nothing a parser knows\n', exit: 2 });
  const garbled = resultOf(await run(repo, [fakeCmd(repo, 'types', 'tsc')]), 'types');
  assert.equal(garbled.result, 'not-run');
  assert.equal(garbled.why, 'error');
});

test('a vitest json file with one failing test gives fail, the id test file|full name, and the test count', async (t) => {
  const repo = project(t, { tools: ['vitest'] });
  const tests = [{ title: 'works', status: 'passed' }, { title: 'breaks', status: 'failed' }, { title: 'also works', status: 'passed' }];
  repo.setTool('vitest', { outputFile: vitestJson(repo, tests), exit: 1 });
  const result = resultOf(await run(repo, [vitestCmd(repo)]), 'tests');
  assert.equal(result.result, 'fail');
  assert.equal(result.total, 3);
  assert.deepEqual(result.failures.map(({ id, file }) => ({ id, file })), [{ id: 'tests/a.test.ts|suite breaks', file: 'tests/a.test.ts' }]);
});

test('vitest with every test passing is ok; with no test at all it is none (no related test), never ok', async (t) => {
  const repo = project(t, { tools: ['vitest'] });
  repo.setTool('vitest', { outputFile: vitestJson(repo, [{ title: 'a', status: 'passed' }, { title: 'b', status: 'passed' }]) });
  const passed = resultOf(await run(repo, [vitestCmd(repo)]), 'tests');
  assert.deepEqual([passed.result, passed.total], ['ok', 2]);
  repo.setTool('vitest', { outputFile: vitestJson(repo, []) });
  assert.equal(resultOf(await run(repo, [vitestCmd(repo)]), 'tests').result, 'none');
});

test('an empty, garbage or never-written tool output file is not run (error), never ok, even when the tool exits 0', async (t) => {
  const repo = project(t, { tools: ['vitest', 'jest'] });
  const cases = [['empty file', { outputFile: '', exit: 0 }], ['garbage file', { outputFile: 'not json {{', exit: 0 }], ['file never written', { exit: 0 }], ['json of the wrong shape', { outputFile: '{"hello":1}', exit: 0 }]];
  for (const [name, behavior] of cases) {
    for (const [tool, make] of [['vitest', vitestCmd], ['jest', jestCmd]]) {
      repo.setTool(tool, behavior);
      const result = resultOf(await run(repo, [make(repo)]), 'tests');
      assert.deepEqual([result.result, result.why], ['not-run', 'error'], `${tool}: ${name}`);
    }
  }
});

test('a jest json file with a failing test gives fail with the id test file|full name', async (t) => {
  const repo = project(t, { tools: ['jest'] });
  const json = { numTotalTests: 2, numFailedTests: 1, success: false, testResults: [{ name: join(repo.dir, 'src/a.test.js'), status: 'failed', assertionResults: [
    { ancestorTitles: ['suite'], fullName: 'suite works', title: 'works', status: 'passed', failureMessages: [] },
    { ancestorTitles: ['suite'], fullName: 'suite breaks', title: 'breaks', status: 'failed', failureMessages: ['expect(received).toBe(expected)'] }] }] };
  repo.setTool('jest', { outputFile: JSON.stringify(json), exit: 1 });
  const result = resultOf(await run(repo, [jestCmd(repo)]), 'tests');
  assert.equal(result.result, 'fail');
  assert.deepEqual(result.failures.map((failure) => failure.id), ['src/a.test.js|suite breaks']);
});

test('the real node --test with the tap reporter: a passing file is ok, a failing case is named in the failure', async (t) => {
  const repo = project(t, {});
  repo.write('tests/pass.test.mjs', nodeTestSource({ cases: [{ name: 'works' }] }));
  repo.write('tests/fail.test.mjs', nodeTestSource({ cases: [{ name: 'works' }, { name: 'breaks', ok: false }] }));
  const nodeTest = (file) => ({ kind: 'tests', argv: [process.execPath, '--test', '--test-reporter=tap', file], cwd: repo.dir, shell: false, label: 'node --test' });
  const passed = resultOf(await run(repo, [nodeTest('tests/pass.test.mjs')]), 'tests');
  assert.deepEqual([passed.result, passed.total], ['ok', 1]);
  const failed = resultOf(await run(repo, [nodeTest('tests/fail.test.mjs')]), 'tests');
  assert.equal(failed.result, 'fail');
  assert.deepEqual(failed.failures.map(({ id, file }) => ({ id, file })), [{ id: 'tests/fail.test.mjs|breaks', file: 'tests/fail.test.mjs' }]);
});

// ---- lint: changed lines only ----

test('eslint errors count only on changed lines; a warning on a changed line and an error on an old line do not fail', async (t) => {
  const repo = project(t, { tools: ['eslint'], files: { 'src/a.ts': 'l1\nl2\nl3\nl4\nl5\n' } });
  repo.write('src/a.ts', 'l1\nl2\nCHANGED\nl4\nl5\n');
  const lint = () => fakeCmd(repo, 'lint', 'eslint', ['--format', 'json', 'src/a.ts']);
  repo.setTool('eslint', { stdout: eslintJson(repo, [[5, 2], [3, 1]]), exit: 1 });
  assert.equal(resultOf(await run(repo, [lint()]), 'lint').result, 'ok');
  repo.setTool('eslint', { stdout: eslintJson(repo, [[5, 2], [3, 2]]), exit: 1 });
  const result = resultOf(await run(repo, [lint()]), 'lint');
  assert.equal(result.result, 'fail');
  assert.deepEqual(result.failures.map((failure) => [failure.file, failure.line]), [['src/a.ts', 3]]);
});

test('with no git base every line of a changed file counts as changed', async (t) => {
  const repo = project(t, { plain: true, tools: ['eslint'], files: { 'src/a.ts': 'l1\nl2\nl3\n' }, replay: {} });
  repo.setTool('eslint', { stdout: eslintJson(repo, [[2, 2]]), exit: 1 });
  const scope = { top: repo.dir, git: false, base: null, files: ['src/a.ts'], wide: [], key: 'k' };
  const results = await runPlan(planOf(repo, [fakeCmd(repo, 'lint', 'eslint', ['--format', 'json', 'src/a.ts'])]), scope, { deadlineMs: DEADLINE_MS });
  assert.equal(resultOf(results, 'lint').result, 'fail');
});

// ---- no shell, folders, missing programs ----

test('arguments with shell characters reach the tool verbatim, nothing runs through a shell, and a folder name with a space and quotes works', async (t) => {
  const repo = project(t, { tools: ['tsc'] });
  const hostile = ['$(touch PWNED)', ';touch PWNED2', '`touch PWNED3`', '"quoted" \'single\' & | > out'];
  await run(repo, [fakeCmd(repo, 'types', 'tsc', hostile)]);
  const [call] = repo.calls('tsc');
  assert.deepEqual(call.argv, hostile);
  assert.equal(call.cwd, repo.dir);
  for (const name of ['PWNED', 'PWNED2', 'PWNED3', 'out']) assert.ok(!existsSync(join(repo.dir, name)), `${name} was not made`);
});

test('a program that does not exist is not run (error); the other checks still give their result and runPlan does not throw', async (t) => {
  const repo = project(t, { tools: ['tsc'], replay: { tsc: { exit: 0 } } });
  const missing = { kind: 'lint', argv: [join(repo.dir, 'no-such-program')], cwd: repo.dir, shell: false, label: 'eslint' };
  const results = await run(repo, [missing, fakeCmd(repo, 'types', 'tsc')]);
  assert.deepEqual([resultOf(results, 'lint').result, resultOf(results, 'lint').why], ['not-run', 'error']);
  assert.equal(resultOf(results, 'types').result, 'ok');
});

// ---- the base copy ----

test('with dir the commands run in the base copy: the same plan fails at head and passes in the base copy', async (t) => {
  const repo = project(t, { tools: ['tsc'] });
  repo.setTool('tsc', { stdout: TSC_ERROR, exit: 2 });
  const baseCopy = join(repo.dir, '..', 'base-copy');
  mkdirSync(baseCopy);
  writeFileSync(join(baseCopy, 'fake-tools.json'), JSON.stringify({ tsc: { exit: 0 } }));
  symlinkSync(join(repo.dir, 'node_modules'), join(baseCopy, 'node_modules'), 'junction');
  const cmd = () => fakeCmd(repo, 'types', 'tsc', ['--noEmit']);
  assert.equal(resultOf(await run(repo, [cmd()]), 'types').result, 'fail');
  repo.clearCalls();
  assert.equal(resultOf(await run(repo, [cmd()], { dir: baseCopy }), 'types').result, 'ok');
  assert.ok(realpathSync(repo.calls('tsc')[0].cwd).startsWith(realpathSync(baseCopy)), 'the tool ran inside the base copy');
});

// ---- pool and deadline ----

test('no more than POOL_SIZE commands run at once, and they do run side by side', async (t) => {
  const repo = project(t, {});
  const probe = join(repo.dir, 'probe.mjs');
  const running = join(repo.dir, '..', 'running');
  const log = join(repo.dir, '..', 'concurrency.log');
  writeFileSync(log, '');
  writeFileSync(probe, `import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
const [dir, log] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/' + process.pid, '');
appendFileSync(log, readdirSync(dir).length + '\\n');
setTimeout(() => rmSync(dir + '/' + process.pid), 400);
`);
  const cmds = Array.from({ length: POOL_SIZE * 3 }, (_, i) => ({ kind: 'tests', argv: [process.execPath, probe, running, log], cwd: repo.dir, shell: false, label: `probe ${i}` }));
  await run(repo, cmds);
  const seen = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.equal(seen.length, cmds.length, 'every command ran');
  assert.ok(Math.max(...seen) <= POOL_SIZE, `at most ${POOL_SIZE} at once, saw ${Math.max(...seen)}`);
  assert.ok(Math.max(...seen) >= 2, 'a pool, not one at a time');
});

test('a fake tool that outlives the deadline is killed with its child process and reported not run (time); the other check is unaffected', async (t) => {
  const repo = project(t, { tools: ['tsc', 'vitest'], replay: { tsc: { exit: 0 }, vitest: { sleepMs: SLEEP_MS, spawnChild: true, outputFile: '' } } });
  const results = await run(repo, [fakeCmd(repo, 'types', 'tsc'), vitestCmd(repo)], { deadlineMs: SHORT_DEADLINE_MS });
  const childPid = repo.calls('vitest').find((entry) => entry.childPid)?.childPid;
  try {
    assert.ok(childPid, 'the fake tool started its child before the deadline');
    assert.deepEqual([resultOf(results, 'tests').result, resultOf(results, 'tests').why], ['not-run', 'time']);
    assert.equal(resultOf(results, 'types').result, 'ok');
    await assertGone(childPid, 'the tool child process');
  } finally {
    if (childPid && isAlive(childPid)) process.kill(childPid, 'SIGKILL'); // never leave a minute-long sleeper behind
  }
});

test('a real node --test file that sleeps past the deadline: reported not run (time) and the test process is gone', async (t) => {
  const repo = project(t, {});
  const pidFile = join(repo.dir, '..', 'slow.pid');
  repo.write('tests/slow.test.mjs', `import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('sleeps', async () => {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  await new Promise((resolveWait) => setTimeout(resolveWait, ${SLEEP_MS}));
});
`);
  const nodeTest = { kind: 'tests', argv: [process.execPath, '--test', '--test-reporter=tap', 'tests/slow.test.mjs'], cwd: repo.dir, shell: false, label: 'node --test' };
  const result = resultOf(await run(repo, [nodeTest], { deadlineMs: 5 * SHORT_DEADLINE_MS / 3 }), 'tests');
  assert.deepEqual([result.result, result.why], ['not-run', 'time']);
  assert.ok(existsSync(pidFile), 'the test started before the deadline');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    await assertGone(pid, 'the node test process');
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(pidFile, { force: true });
  }
});
