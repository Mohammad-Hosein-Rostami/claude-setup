// Acceptance tests of the done-check tool (home/tools/done-check/done-check.mjs and its check-change / scope / parse libs), written from
// the spec (design.md section 8: A1, A2, A4, A5, A11, A12, A13; the hook's own lines A3, A6, A7, A8 are in done-check-hook.test.mjs).
// They are red until the engine exists (road newchk steps 3-4): every case runs the real tool on a throw-away project from
// done-check-fixture.mjs, with fake tsc / vitest that replay what a real run prints, and a private HOME (the real ~/.claude is never read).
// Conventions the tests rely on, all from the spec: `done-check run --worktree <abs> --base <sha> --where manual --json` prints the Verdict
// JSON ({verdict, line, reason, risk, row}) and exits 0 (ok, reused, none) or 1 (new failures or weakened tests), 2 usage; the block
// reason lists `file:line code message`; `row.checks.<kind>` is {result, new, old, ms, why?}; the ledger is
// <HOME>/.claude/state/done-check/ledger.jsonl. Imports of the engine are dynamic, so a missing module fails only the cases that need it.
// No case asserts elapsed time except A5, which uses a fake tool that sleeps far past a shortened deadline (P12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDoneCheckRepo, nodeTestSource } from './done-check-fixture.mjs';

const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const lib = (name) => import(new URL(`../home/tools/done-check/lib/${name}`, import.meta.url).href);
const LONG_SLEEP_MS = 20_000;
const SHORT_DEADLINE_MS = 1500;
const DEADLINE_SLACK_MS = 12_000; // the run must end this far before the fake tool would

const TYPECHECK_PACKAGE = { name: 'p', private: true, scripts: { typecheck: 'tsc --noEmit' } };
const VITEST_PACKAGE = { name: 'p', private: true, scripts: { test: 'vitest run' } };
const NODE_TEST_PACKAGE = { name: 'p', private: true, scripts: { test: 'node --test tests/*.test.mjs', typecheck: 'tsc --noEmit' } };
const TS_SOURCES = { 'src/lib.ts': 'export const n: number = 1;\n', 'src/use.ts': "import { n } from './lib';\nexport const s = String(n);\nexport const t: number = n;\n", 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' };
const TSC_CLEAN = { exit: 0 };
const TSC_BROKEN_CALLER = { exit: 2, stdout: "src/use.ts(3,25): error TS2322: Type 'string' is not assignable to type 'number'.\n" };

/** A vitest `--reporter=json` report of one test file; names are repo-relative (the fake cannot know the folder a run happens in). */
const vitestReport = (file, tests) => JSON.stringify({
  numTotalTests: tests.length, numFailedTests: tests.filter(({ ok }) => !ok).length, success: tests.every(({ ok }) => ok),
  testResults: [{ name: file, status: tests.every(({ ok }) => ok) ? 'passed' : 'failed', assertionResults: tests.map(({ name, ok }) => ({
    ancestorTitles: [], title: name, fullName: name, status: ok ? 'passed' : 'failed', failureMessages: ok ? [] : ['AssertionError: expected 1 to be 2'],
  })) }],
});
const FAILING_VITEST = { exit: 1, outputFile: vitestReport('src/a.test.ts', [{ name: 'adds', ok: false }]) };
const PASSING_VITEST = { exit: 0, outputFile: vitestReport('src/a.test.ts', [{ name: 'adds', ok: true }]) };
const VITEST_SOURCES = { 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': "import { a } from './a';\ntest('adds', () => expect(a).toBe(2));\n" };

const newRepo = (t, options) => {
  const repo = makeDoneCheckRepo(options);
  t.after(repo.cleanup);
  return repo;
};

/** Runs `done-check run --json` for the change in `repo.dir` against its base; returns {status, verdict, stdout}. */
function check(repo, extraArgs = []) {
  const result = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', 'manual', '--json', ...extraArgs]);
  const first = (result.stderr || result.stdout).split('\n')[0];
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    assert.fail(`done-check run printed no JSON (exit ${result.status}): ${first}`);
  }
  return { status: result.status, verdict, stdout: result.stdout };
}

const ledgerFile = (repo) => join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl');
const readLedgerRows = (repo) => readFileSync(ledgerFile(repo), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('A1: a change that breaks a type used by an unchanged file blocks; the reason names the caller file:line and TS code', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', "export const n: string = '1';\n"); // only lib.ts changes; use.ts is the unchanged caller
  repo.setTool('tsc', TSC_BROKEN_CALLER);
  const { status, verdict } = check(repo);
  assert.equal(status, 1);
  assert.equal(verdict.verdict, 'block');
  assert.match(verdict.reason, /src\/use\.ts:3\b[^\n]*TS2322/);
  assert.equal(verdict.row.checks.types.result, 'fail');
  assert.equal(verdict.row.checks.types.new, 1);
  assert.match(verdict.line, /types/);
});

test('DONE_CHECK_SKIP=all from a committed team file: the CLI (and land) run still checks, blocks and says the switch was ignored', (t) => {
  const team = { '.claude/settings.json': `${JSON.stringify({ env: { DONE_CHECK_SKIP: 'all' } })}\n` };
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: { ...TS_SOURCES, ...team }, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', "export const n: string = '1';\n");
  repo.setTool('tsc', TSC_BROKEN_CALLER);
  const result = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', 'land', '--json'], { env: { DONE_CHECK_SKIP: 'all' } });
  const verdict = JSON.parse(result.stdout);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(verdict.verdict, 'block', 'the checks ran');
  assert.match(verdict.reason, /src\/use\.ts:3\b[^\n]*TS2322/);
  assert.match(verdict.line, /team switch DONE_CHECK_SKIP ignored: the team file .*settings\.json sets it; our check runs/);
  assert.equal(verdict.line.split('team switch').length - 1, 1, 'said once');
  const noProjectDir = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', 'manual', '--json'], { env: { DONE_CHECK_SKIP: 'all', CLAUDE_PROJECT_DIR: '' } });
  assert.match(JSON.parse(noProjectDir.stdout).line, /team switch DONE_CHECK_SKIP ignored/, 'the git top alone is enough: no project folder needed');
});

test('A1: the same run without --json prints one `checks:` line first and exits 1', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', "export const n: string = '1';\n");
  repo.setTool('tsc', TSC_BROKEN_CALLER);
  const result = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', 'manual']);
  assert.equal(result.status, 1);
  assert.match(result.stdout.split('\n')[0], /^checks: .*types/);
});

test('a clean change exits 0 and records the run in the ledger', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.row.checks.types.result, 'ok');
  const rows = readLedgerRows(repo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].where, 'manual');
  assert.equal(rows[0].files, 1);
  assert.doesNotMatch(JSON.stringify(rows[0]), /lib\.ts/, 'the ledger holds counts, never file names');
});

test('`last --worktree` prints the line of the newest run of that folder', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  const { verdict } = check(repo);
  const last = repo.run(CLI, ['last', '--worktree', repo.dir]);
  assert.equal(last.status, 0);
  assert.ok(last.stdout.includes(verdict.line), `last printed ${JSON.stringify(last.stdout)}, run said ${JSON.stringify(verdict.line)}`);
});

test('usage errors exit 2: no subcommand arguments, a bad --as, a base that is not 40 hex', (t) => {
  const repo = newRepo(t, {});
  assert.equal(repo.run(CLI, ['run']).status, 2);
  assert.equal(repo.run(CLI, ['label', 'run-1', '--as', 'nonsense', '--check', 'types']).status, 2);
  assert.equal(repo.run(CLI, ['run', '--worktree', repo.dir, '--base', 'abc123']).status, 2);
});

test('A2: a related test that fails at base too is old, not yours: no block, the line says `1 old fail`', (t) => {
  const repo = newRepo(t, { packageJson: VITEST_PACKAGE, files: VITEST_SOURCES, tools: ['vitest'], replay: { vitest: FAILING_VITEST } });
  repo.write('src/a.ts', 'export const a = 3;\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.row.checks.tests.old, 1);
  assert.equal(verdict.row.checks.tests.new, 0);
  assert.match(verdict.line, /1 old fail/);
  assert.equal(repo.calls('vitest').length >= 2, true, 'vitest ran at head and again in the base copy');
});

test('A2: a related test that passes at base and fails now blocks (the base compare does not hide new failures)', (t) => {
  const repo = newRepo(t, { packageJson: VITEST_PACKAGE, files: VITEST_SOURCES, tools: ['vitest'], replay: { vitest: PASSING_VITEST } });
  repo.write('src/a.ts', 'export const a = 3;\n');
  repo.setTool('vitest', FAILING_VITEST);
  const { status, verdict } = check(repo);
  assert.equal(status, 1);
  assert.equal(verdict.verdict, 'block');
  assert.equal(verdict.row.checks.tests.new, 1);
  assert.match(verdict.reason, /src\/a\.test\.ts[^\n]*adds/);
});

const WEAKENINGS = [
  { name: 'a deleted test case', mention: /tests\/a\.test\.mjs: case deleted/, edit: (repo) => repo.write('tests/a.test.mjs', nodeTestSource({ cases: [{ name: 'one' }] })) },
  { name: 'an added .skip', mention: /tests\/a\.test\.mjs:\d+: test\.skip added/, edit: (repo) => repo.write('tests/a.test.mjs', `${nodeTestSource({ cases: [{ name: 'one' }, { name: 'two' }] })}test.skip('three', () => {});\n`) },
  { name: 'an added @ts-ignore', mention: /src\/x\.ts:1: @ts-ignore added[^\n]*suppression/, edit: (repo) => repo.write('src/x.ts', "// @ts-ignore\nexport const x: number = 'a';\n") },
  { name: 'an edited test script', mention: /package\.json/, edit: (repo) => repo.write('package.json', `${JSON.stringify({ ...NODE_TEST_PACKAGE, scripts: { ...NODE_TEST_PACKAGE.scripts, test: 'echo ok' } })}\n`) },
];
const weakeningProject = (t) => newRepo(t, { packageJson: NODE_TEST_PACKAGE, files: { 'tests/a.test.mjs': nodeTestSource({ cases: [{ name: 'one' }, { name: 'two' }] }), 'src/x.ts': 'export const x: number = 1;\n' } });
for (const { name, mention, edit } of WEAKENINGS) {
  test(`A4: ${name} blocks as weakened`, (t) => {
    const repo = weakeningProject(t);
    edit(repo);
    const { status, verdict } = check(repo);
    assert.equal(status, 1);
    assert.equal(verdict.verdict, 'block');
    assert.equal(verdict.row.checks['tests-weakened'].result, 'fail');
    assert.ok(verdict.row.checks['tests-weakened'].new >= 1);
    assert.match(verdict.reason, mention);
  });
}

test('A4: adding a test case to a test file is not weakening', (t) => {
  const repo = weakeningProject(t);
  repo.write('tests/a.test.mjs', nodeTestSource({ cases: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] }));
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.row.checks['tests-weakened'].result, 'ok');
});

test('A5: a test run that sleeps past the deadline ends as `tests not run (time)` in time and does not block', async (t) => {
  const repo = newRepo(t, { packageJson: VITEST_PACKAGE, files: VITEST_SOURCES, tools: ['vitest'], replay: { vitest: { sleepMs: LONG_SLEEP_MS, outputFile: '' } } });
  repo.write('src/a.ts', 'export const a = 3;\n');
  const { rangeChange } = await lib('scope.mjs');
  const { checkChange } = await lib('check-change.mjs');
  const startedAt = Date.now();
  const verdict = await checkChange(rangeChange(repo.dir, repo.baseSha), { where: 'manual', session: '', agent: '', env: repo.env, deadlineMs: SHORT_DEADLINE_MS });
  assert.ok(Date.now() - startedAt < LONG_SLEEP_MS - DEADLINE_SLACK_MS, 'the run waited for the fake tool instead of the deadline');
  assert.equal(verdict.row.checks.tests.result, 'not-run');
  assert.equal(verdict.row.checks.tests.why, 'time');
  assert.notEqual(verdict.verdict, 'block');
  assert.match(verdict.line, /tests not run \(time\)/);
});

test('with no base, a test that fails only in a file the change does not hold is never shown or stored as ok, nor reused as green', async (t) => {
  const repo = newRepo(t, { packageJson: VITEST_PACKAGE, files: VITEST_SOURCES, tools: ['vitest'], replay: { vitest: FAILING_VITEST } });
  repo.write('src/a.ts', 'export const a = 3;\n');
  const { checkChange } = await lib('check-change.mjs');
  const scope = { top: repo.dir, git: true, base: null, files: ['src/a.ts'], wide: [], named: [], key: 'a'.repeat(64) }; // a Scope a caller built with no base
  for (const run of ['first', 'second']) {
    const verdict = await checkChange(scope, { where: 'stop', session: 's', agent: 'a', env: repo.env });
    assert.equal(verdict.verdict, 'left-open', `${run} run: ${verdict.line}`);
    assert.deepEqual([verdict.row.checks.tests.result, verdict.row.checks.tests.new, verdict.row.checks.tests.unknown], ['fail', 0, 1]);
    assert.match(verdict.line, /tests 0 new, 1 unknown/);
    assert.doesNotMatch(verdict.line, /tests ok/);
  }
  const rows = readFileSync(join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.verdict), ['left-open', 'left-open']);
});

const UNREADABLE = [
  { name: 'an empty vitest output file after a failing run', kind: 'tests', tool: 'vitest', replay: { exit: 1, outputFile: '' } },
  { name: 'a vitest output file that is not JSON', kind: 'tests', tool: 'vitest', replay: { exit: 1, outputFile: 'not json {{' } },
  { name: 'no vitest output file at all', kind: 'tests', tool: 'vitest', replay: { exit: 1 } },
  { name: 'an empty vitest output file after exit 0 (a pass with nothing read)', kind: 'tests', tool: 'vitest', replay: { exit: 0, outputFile: '' } },
  { name: 'tsc failing with text that holds no diagnostic', kind: 'types', tool: 'tsc', replay: { exit: 2, stdout: 'Segmentation fault: core dumped\n' } },
];
for (const { name, kind, tool, replay } of UNREADABLE) {
  test(`A13: ${name} is not run (error), never ok`, (t) => {
    const repo = newRepo(t, { packageJson: { ...VITEST_PACKAGE, scripts: { ...VITEST_PACKAGE.scripts, typecheck: 'tsc --noEmit' } }, files: { ...VITEST_SOURCES, ...TS_SOURCES }, tools: ['vitest', 'tsc'], replay: { tsc: TSC_CLEAN, vitest: PASSING_VITEST } });
    repo.write('src/a.ts', 'export const a = 3;\n');
    repo.setTool(tool, replay);
    const { status, verdict } = check(repo);
    assert.equal(verdict.row.checks[kind].result, 'not-run');
    assert.equal(verdict.row.checks[kind].why, 'error');
    assert.notEqual(verdict.verdict, 'block');
    assert.equal(status, 0);
    assert.doesNotMatch(verdict.line, new RegExp(`${kind} ok`));
    assert.match(verdict.line, new RegExp(`${kind} not run \\(error\\)`));
  });
}

test('A12: a diagnostic printed with backslashes is the same failure as at base (one key), so it is old', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_BROKEN_CALLER } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  repo.setTool('tsc', { ...TSC_BROKEN_CALLER, stdout: TSC_BROKEN_CALLER.stdout.replace('src/use.ts', 'src\\use.ts').replace('\n', '\r\n') });
  const { status, verdict } = check(repo);
  assert.equal(verdict.row.checks.types.old, 1);
  assert.equal(verdict.row.checks.types.new, 0);
  assert.equal(status, 0);
});

test('A12: a project folder with a space and quotes runs its tools with no shell in between', (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'], replay: { tsc: TSC_CLEAN } });
  repo.write('src/lib.ts', 'export const n: number = 2;\n');
  check(repo);
  const [call] = repo.calls('tsc');
  assert.ok(call, 'tsc was started');
  assert.equal(call.cwd, repo.dir);
  assert.ok(call.argv.includes('--noEmit'), `argv: ${call.argv.join(' ')}`);
});

test('A12: a changed path with a space keeps its `/` form; the change key is stable and moves with the content', async (t) => {
  const repo = newRepo(t, { packageJson: TYPECHECK_PACKAGE, files: TS_SOURCES, tools: ['tsc'] });
  repo.write('src/my file.ts', 'export const m = 1;\n');
  const { rangeChange } = await lib('scope.mjs');
  const first = await rangeChange(repo.dir, repo.baseSha);
  assert.deepEqual(first.files, ['src/my file.ts']);
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal((await rangeChange(repo.dir, repo.baseSha)).key, first.key);
  repo.write('src/my file.ts', 'export const m = 2;\n');
  assert.notEqual((await rangeChange(repo.dir, repo.baseSha)).key, first.key);
});

test('A12: the tsc parser reads a Windows drive path with backslashes and CRLF as `C:/a b/x.ts`', async () => {
  const { parseTsc } = await lib('parse.mjs');
  const parsed = parseTsc("C:\\a b\\x.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\r\n");
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].file, 'C:/a b/x.ts');
  assert.equal(parsed.failures[0].line, 3);
  assert.match(parsed.failures[0].id, /TS2322/);
});

/** A ledger of `blocks` blocked stops of different agents, the first `ignored` of them followed by the same key (the agent changed nothing). */
function writeLedger(repo, { blocks, ignored }) {
  mkdirSync(join(repo.home, '.claude', 'state', 'done-check'), { recursive: true, mode: 0o700 });
  writeFileSync(ledgerFile(repo), '', { mode: 0o600 });
  const base = Date.now() - 60_000;
  const row = (id, at, agent, key, verdict, result) => ({ v: 1, id, at: new Date(base + at).toISOString(), where: 'stop', session: 's1', agent, repo: 'abc123', base: 'b'.repeat(40), key, files: 1, checks: { types: { result, new: result === 'fail' ? 1 : 0, old: 0, ms: 120 } }, verdict, risk: [], ms: 120 });
  for (let i = 1; i <= blocks; i += 1) {
    const agent = `agent-${i}`;
    const left = i <= ignored;
    const rows = [row(`blk-${i}`, i * 100, agent, `k${i}a`, 'block', 'fail'), left ? row(`nxt-${i}`, i * 100 + 50, agent, `k${i}a`, 'left-open', 'fail') : row(`nxt-${i}`, i * 100 + 50, agent, `k${i}b`, 'ok', 'ok')];
    for (const entry of rows) appendFileSync(ledgerFile(repo), `${JSON.stringify(entry)}\n`);
  }
}
const doctorWarnings = (repo) => {
  const result = repo.run(CLI, ['stats', '--days', '30', '--doctor']);
  assert.equal(result.status, 0, `stats --doctor must exit 0, got ${result.status}: ${result.stderr.split('\n')[0]}`); // an absent tool must not read as "no warning"
  return result.stdout.split('\n').filter((line) => /WARN/.test(line));
};

test('A11: stats on a ledger with 10 blocks, 2 ignored, shows a types false-alarm rate of 20% and --doctor prints one WARN', (t) => {
  const repo = newRepo(t, {});
  writeLedger(repo, { blocks: 10, ignored: 2 });
  const stats = repo.run(CLI, ['stats', '--days', '30']);
  assert.equal(stats.status, 0, stats.stderr);
  assert.ok(stats.stdout.split('\n').some((line) => /types/.test(line) && /\b20(\.0+)?%/.test(line)), stats.stdout);
  const warnings = doctorWarnings(repo);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /types/);
});

test('A11: fewer than 10 blocks never warns, even at a high false-alarm rate', (t) => {
  const repo = newRepo(t, {});
  writeLedger(repo, { blocks: 5, ignored: 2 });
  assert.deepEqual(doctorWarnings(repo), []);
});

test('A11: an owner label `real` on an ignored block takes it out of the rate (1 of 10 = 10%: no WARN)', (t) => {
  const repo = newRepo(t, {});
  writeLedger(repo, { blocks: 10, ignored: 2 });
  const labelled = repo.run(CLI, ['label', 'blk-1', '--as', 'real', '--check', 'types', '--note', 'a true catch']);
  assert.equal(labelled.status, 0, labelled.stderr);
  const rows = readLedgerRows(repo);
  assert.deepEqual({ label: rows.at(-1).label, run: rows.at(-1).run, check: rows.at(-1).check }, { label: 'real', run: 'blk-1', check: 'types' });
  assert.deepEqual(doctorWarnings(repo), []);
});

// ---- a test that fails once and then passes is flaky, not a new failure (proof defect D2) ----

/** A real node:test file whose test fails the first time it runs anywhere (it leaves a marker outside the project) and passes after. */
const failsOnceSource = (marker) => `import test from 'node:test';
import fs from 'node:fs';
import '../src/a.mjs';
test('fails only on its first run', () => {
  if (fs.existsSync(${JSON.stringify(marker)})) return;
  fs.writeFileSync(${JSON.stringify(marker)}, 'ran');
  throw new Error('the paste was never shown');
});
`;

test('D2: a new failing test that passes when its file runs again at head is flaky: no block, the line says `1 flaky`', (t) => {
  const repo = newRepo(t, { packageJson: NODE_TEST_PACKAGE, files: { 'src/a.mjs': 'export const a = 1;\n' } });
  repo.write('tests/a.test.mjs', failsOnceSource(join(repo.home, 'flaky-marker')));
  repo.write('src/a.mjs', 'export const a = 2;\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.row.checks.tests.new, 0);
  assert.equal(verdict.row.checks.tests.flaky, 1);
  assert.match(verdict.line, /tests ok, 1 flaky/);
});

test('D2: a new failing test that fails again at head still blocks, and is not called flaky', (t) => {
  const alwaysFailing = "import test from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a stays 1', () => { if (a !== 1) throw new Error('a is not 1'); });\n";
  const repo = newRepo(t, { packageJson: NODE_TEST_PACKAGE, files: { 'src/a.mjs': 'export const a = 1;\n', 'tests/a.test.mjs': alwaysFailing } });
  repo.write('src/a.mjs', 'export const a = 2;\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 1);
  assert.equal(verdict.verdict, 'block');
  assert.equal(verdict.row.checks.tests.new, 1);
  assert.equal(verdict.row.checks.tests.flaky, undefined);
  assert.doesNotMatch(verdict.line, /flaky/);
});

// ---- a text file that a test reads (proof misses R2e and S12: lead rules text read by modes-consistency) ----

const READS_TEXT = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('the rule is there', () => assert.ok(readFileSync('docs/rules.md', 'utf8').includes('old rule')));\n";
const textProject = (t) => newRepo(t, { packageJson: NODE_TEST_PACKAGE, files: { 'tests/rules.test.mjs': READS_TEXT, 'docs/rules.md': 'old rule\n', 'docs/other.md': 'old\n' } });

test('R2e: a markdown change that breaks a test reading it blocks as a new test failure', (t) => {
  const repo = textProject(t);
  repo.write('docs/rules.md', 'new rule\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 1);
  assert.equal(verdict.verdict, 'block');
  assert.equal(verdict.row.checks.tests.new, 1);
  assert.doesNotMatch(verdict.line, /no code change/);
});

test('R2e: a markdown change that keeps the test green is checked and ok', (t) => {
  const repo = textProject(t);
  repo.write('docs/rules.md', 'old rule, reworded\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.row.checks.tests.result, 'ok');
});

test('R2e: a markdown change no test names stays `no code change`, exit 0 and no ledger row', (t) => {
  const repo = textProject(t);
  repo.write('docs/other.md', 'new\n');
  const { status, verdict } = check(repo);
  assert.equal(status, 0);
  assert.equal(verdict.verdict, 'skipped');
  assert.match(verdict.line, /no code change/);
  assert.throws(() => readLedgerRows(repo), /ENOENT/);
});
