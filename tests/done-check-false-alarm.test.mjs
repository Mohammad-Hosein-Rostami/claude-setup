// Tests of labelled false alarms in the done-check (road solid, lane dc-alarms, finding C3 / friction #6): an owner-approved test
// removal was blocked three stops in a row, and `stats` showed ignored blocks as a "false-alarm rate" with no label in the ledger.
// What they pin:
//   - a run whose check the owner labels `false-alarm` does not block again on the same failures (same repo and base), a new failure
//     still blocks, a later `real` label takes it back, and a run passed by a label is never reused as green;
//   - a test file deleted with the module it imports is "removed with its code"; deleted alone or with only a fixture it still blocks;
//   - only a label row (the `label` command) lets a failure through, and only through the hashed ids its run row stored (F1);
//   - an old ledger without the new fields reads as before; `stats` prints labels and ignored blocks on lines of their own (F3);
//   - labels appended by several processes at once are all kept (F4: one O_APPEND write per row).
// Invariants: every project is a throw-away fixture (done-check-fixture.mjs) with its own HOME, so the real ~/.claude is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDoneCheckRepo, nodeTestSource } from './done-check-fixture.mjs';

const CLI = fileURLToPath(new URL('../home/tools/done-check/done-check.mjs', import.meta.url));
const lib = (name) => import(new URL(`../home/tools/done-check/lib/${name}`, import.meta.url).href);
const WEAKENED = 'tests-weakened';
const NODE_TEST_PACKAGE = { name: 'p', private: true, scripts: { test: 'node --test tests/*.test.mjs' } };
const SUM_SOURCES = {
  'src/sum.mjs': 'export const sum = (a, b) => a + b;\n',
  'tests/sum.test.mjs': nodeTestSource({ imports: ['../src/sum.mjs'], cases: [{ name: 'adds' }] }),
  'tests/keep.test.mjs': nodeTestSource({ cases: [{ name: 'one' }, { name: 'two' }] }),
};

const newRepo = (t, options = {}) => {
  const repo = makeDoneCheckRepo({ packageJson: NODE_TEST_PACKAGE, files: SUM_SOURCES, ...options });
  t.after(repo.cleanup);
  return repo;
};

/** `done-check run --where manual --json` on the change against the repo's base: { status, verdict }. */
function check(repo) {
  const result = repo.run(CLI, ['run', '--worktree', repo.dir, '--base', repo.baseSha, '--where', 'manual', '--json']);
  return { status: result.status, verdict: JSON.parse(result.stdout) };
}

function label(repo, runId, as) {
  const result = repo.run(CLI, ['label', runId, '--as', as, '--check', WEAKENED]);
  assert.equal(result.status, 0, result.stderr);
}

/** The scope weakenedTests reads: the repo, its base and the changed files. */
const scopeOf = (repo, files) => ({ top: repo.dir, git: true, base: repo.baseSha, files, wide: [], key: 'f'.repeat(64) });

test('F2: a test file deleted alone still blocks as weakened', async (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  const { weakenedTests } = await lib('test-diff.mjs');
  assert.deepEqual(weakenedTests(scopeOf(repo, ['tests/sum.test.mjs'])).map((found) => found.text), ['tests/sum.test.mjs: test file deleted']);
});

test('F2: a test file deleted with the module it imports is removed with its code, not weakened', async (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  repo.remove('src/sum.mjs');
  const { weakenedTests } = await lib('test-diff.mjs');
  assert.deepEqual(weakenedTests(scopeOf(repo, ['tests/sum.test.mjs', 'src/sum.mjs'])), []);
});

test('F2: a TypeScript test importing its module without an extension, or as .js, is removed with its code', async (t) => {
  const sources = { 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': "import { a } from './a';\ntest('a', () => expect(a).toBe(1));\n",
    'src/b.ts': 'export const b = 2;\n', 'src/b.test.ts': "import { b } from './b.js';\ntest('b', () => expect(b).toBe(2));\n" };
  const repo = newRepo(t, { files: sources });
  for (const file of Object.keys(sources)) repo.remove(file);
  const { weakenedTests } = await lib('test-diff.mjs');
  assert.deepEqual(weakenedTests(scopeOf(repo, Object.keys(sources))), []);
});

test('F2: a test file deleted with only a fixture it imports still blocks', async (t) => {
  const repo = newRepo(t, { files: { ...SUM_SOURCES, 'tests/helper.mjs': 'export const one = 1;\n', 'tests/uses.test.mjs': nodeTestSource({ imports: ['./helper.mjs'] }) } });
  repo.remove('tests/uses.test.mjs');
  repo.remove('tests/helper.mjs');
  const { weakenedTests } = await lib('test-diff.mjs');
  const ids = weakenedTests(scopeOf(repo, ['tests/uses.test.mjs', 'tests/helper.mjs'])).map((found) => found.id);
  assert.ok(ids.includes('tests/uses.test.mjs|deleted'), ids.join(', ')); // the helper sits in tests/, so it counts as a test file too
});

test('a run labelled false-alarm does not block again on the same failure, and the line says it was labelled', (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  const first = check(repo);
  assert.equal(first.status, 1, first.verdict.line);
  assert.equal(first.verdict.row.checks[WEAKENED].alarms.length, 1);
  label(repo, first.verdict.row.id, 'false-alarm');
  repo.write('src/other.mjs', 'export const other = 1;\n'); // another change key, the same deleted test
  const second = check(repo);
  assert.equal(second.status, 0, second.verdict.reason ?? second.verdict.line);
  assert.equal(second.verdict.verdict, 'ok');
  assert.deepEqual({ result: second.verdict.row.checks[WEAKENED].result, new: second.verdict.row.checks[WEAKENED].new, labelled: second.verdict.row.checks[WEAKENED].labelled }, { result: 'ok', new: 0, labelled: 1 });
  assert.match(second.verdict.line, /tests-weakened ok, 1 labelled/);
});

test('a new weakening after a false-alarm label still blocks; only the labelled failure is let through', (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  const first = check(repo);
  label(repo, first.verdict.row.id, 'false-alarm');
  repo.write('tests/keep.test.mjs', nodeTestSource({ cases: [{ name: 'one' }] }));
  const second = check(repo);
  assert.equal(second.status, 1);
  // one case fewer in keep.test.mjs is two finds (a case and its assertion), both new; the labelled deleted test is the one let through
  assert.deepEqual({ new: second.verdict.row.checks[WEAKENED].new, labelled: second.verdict.row.checks[WEAKENED].labelled }, { new: 2, labelled: 1 });
  assert.match(second.verdict.reason, /tests\/keep\.test\.mjs: case deleted/);
  assert.doesNotMatch(second.verdict.reason, /sum\.test\.mjs/);
});

test('a later `real` label takes the false alarm back, and the run it passed is not reused as green', (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  const first = check(repo);
  label(repo, first.verdict.row.id, 'false-alarm');
  assert.equal(check(repo).status, 0);
  label(repo, first.verdict.row.id, 'real');
  const again = check(repo); // the same change key as the passed run
  assert.equal(again.status, 1);
  assert.notEqual(again.verdict.verdict, 'reused');
});

test('a stop whose only failure is labelled passes as ok, so the hook ends the block chain', async (t) => {
  const repo = newRepo(t);
  repo.remove('tests/sum.test.mjs');
  label(repo, check(repo).verdict.row.id, 'false-alarm');
  repo.write('src/other.mjs', 'export const other = 2;\n');
  const { rangeChange } = await lib('scope.mjs');
  const { checkChange } = await lib('check-change.mjs');
  const verdict = await checkChange(rangeChange(repo.dir, repo.baseSha), { where: 'stop', session: 's', agent: 'a', env: repo.env, priorBlocks: { lastKey: 'k', inARow: 1 } });
  assert.equal(verdict.verdict, 'ok', verdict.line);
});

const runRow = (overrides) => ({ v: 1, id: 'r1', at: new Date().toISOString(), where: 'stop', session: 's', agent: 'a', repo: 'repo-1', base: 'b'.repeat(40), key: 'k1', files: 1, checks: { [WEAKENED]: { result: 'fail', new: 1, old: 0, ms: 1, alarms: ['0123456789abcdef'] } }, verdict: 'block', risk: [], ms: 1, ...overrides });
const labelRow = (overrides) => ({ v: 1, label: 'false-alarm', run: 'r1', check: WEAKENED, at: new Date().toISOString(), note: '', ...overrides });

test('F1: a label applies only to its own repo, base and check kind, and only a false-alarm label lets a failure through', async () => {
  const { labelledAlarmIds } = await lib('false-alarms.mjs');
  const where = { repo: 'repo-1', base: 'b'.repeat(40) };
  assert.deepEqual([...labelledAlarmIds({ runs: [runRow({})], labels: [labelRow({})] }, where).get(WEAKENED)], ['0123456789abcdef']);
  assert.equal(labelledAlarmIds({ runs: [runRow({ repo: 'repo-2' })], labels: [labelRow({})] }, where).size, 0);
  assert.equal(labelledAlarmIds({ runs: [runRow({ base: 'c'.repeat(40) })], labels: [labelRow({})] }, where).size, 0);
  assert.equal(labelledAlarmIds({ runs: [runRow({})], labels: [labelRow({ check: 'tests' })] }, where).get(WEAKENED), undefined);
  assert.equal(labelledAlarmIds({ runs: [runRow({})], labels: [labelRow({ label: 'missed' })] }, where).size, 0);
  assert.equal(labelledAlarmIds({ runs: [runRow({ base: null })], labels: [labelRow({})] }, { repo: 'repo-1', base: null }).size, 0);
});

test('F1: a label row cannot carry alarm ids, and a run row never stores a file name as one', async (t) => {
  const repo = newRepo(t);
  const env = repo.env;
  const { appendLabel, appendRun, readLedger } = await lib('ledger.mjs');
  assert.equal(appendLabel({ ...labelRow({}), alarms: ['0123456789abcdef'], note: 'false-alarm tests/sum.test.mjs|deleted' }, { env }), true);
  assert.equal(readLedger({ env }).labels[0].alarms, undefined);
  assert.throws(() => appendRun(runRow({ checks: { [WEAKENED]: { result: 'fail', new: 1, old: 0, ms: 1, alarms: ['tests/sum.test.mjs'] } } }), { env }), TypeError);
});

/** Writes ledger rows as text, the way an older writer left them. */
function writeRows(repo, rows) {
  const file = join(repo.home, '.claude', 'state', 'done-check', 'ledger.jsonl');
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, '', { mode: 0o600 });
  for (const row of rows) appendFileSync(file, `${JSON.stringify(row)}\n`);
}

test('F3: an old ledger without the new fields reads as before; stats print labelled and ignored on lines of their own', (t) => {
  const repo = newRepo(t);
  const at = (offset) => new Date(Date.now() - 60_000 + offset).toISOString();
  const types = (result) => ({ types: { result, new: result === 'fail' ? 1 : 0, old: 0, ms: 5 } });
  writeRows(repo, [
    runRow({ id: 'b1', agent: 'a1', key: 'k1', at: at(0), checks: types('fail') }), runRow({ id: 'n1', agent: 'a1', key: 'k1', at: at(1), verdict: 'left-open', checks: types('fail') }),
    runRow({ id: 'b2', agent: 'a2', key: 'k2', at: at(2), checks: types('fail') }), runRow({ id: 'n2', agent: 'a2', key: 'k2', at: at(3), verdict: 'left-open', checks: types('fail') }),
    labelRow({ run: 'b2', check: 'types', at: at(4) }),
  ]);
  const result = repo.run(CLI, ['stats', '--days', '30']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');
  const kindLine = lines.findIndex((line) => line.startsWith('types: 4 runs, 2 blocks'));
  assert.ok(kindLine >= 0, result.stdout);
  assert.equal(lines[kindLine + 1], '  labelled: 1 false-alarm, 0 real, 0 missed; 0 runs passed by a false-alarm label');
  assert.equal(lines[kindLine + 2], '  ignored: 1 blocks stopped again with the same change and no label');
});

const LABELLER = `
import { appendLabel } from ${JSON.stringify(new URL('../home/tools/done-check/lib/ledger.mjs', import.meta.url).href)};
const [prefix, count] = JSON.parse(process.argv[1]);
for (let index = 0; index < count; index += 1) {
  if (!appendLabel({ v: 1, label: 'false-alarm', run: prefix + '-' + index, check: 'tests-weakened', at: new Date().toISOString(), note: 'n'.repeat(150) })) process.exit(3);
}`;

test('F4: labels appended by several processes at once are all kept', async (t) => {
  const repo = newRepo(t);
  const prefixes = ['p1', 'p2', 'p3', 'p4'];
  const perProcess = 50;
  const statuses = await Promise.all(prefixes.map((prefix) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', LABELLER, JSON.stringify([prefix, perProcess])], { env: repo.env, stdio: 'ignore' });
    child.on('close', resolve);
  })));
  assert.deepEqual(statuses, prefixes.map(() => 0));
  const { readLedger } = await lib('ledger.mjs');
  const runs = readLedger({ env: repo.env }).labels.map((row) => row.run);
  assert.equal(new Set(runs).size, prefixes.length * perProcess);
});
