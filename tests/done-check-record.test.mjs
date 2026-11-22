// Contract tests for the done-check's records: home/tools/done-check/lib/ledger.mjs, lib/test-diff.mjs, lib/risk.mjs and risk-rules.json
// (design sections 3.2, 3.6, 3.7 and 6, road newchk step 2, lane dc-tests-git). Written from the spec, apart from the code: red until
// lane dc-record lands them.
// Ledger: appendRun, appendLabel, readLedger({sinceMs}), lastRun, stats. The size cap is LEDGER_MAX_BYTES (contract.mjs) for the writer
//   and the reader: tested at the exact boundary. A half line, a foreign line and a row of another version are skipped; two processes
//   appending at once never interleave a line.
// Weakened tests: weakenedTests(scope) -> Failure[] (kind `tests-weakened`) for a deleted test file, fewer cases or assertions, an added
//   skip/only/todo, an added lint or type suppression, a changed test/typecheck/lint script, a changed lint or test config, a tsconfig
//   strictness flag turned off; and none for a stronger or an unrelated change, or without git.
// Risk: riskClasses(scope, rules, extra) -> {class, file}[] with the shipped risk-rules.json, including the false alarms of the old
//   review-tier (`checkout`, `ledger`).
// Decisions this test fixes where the design is silent (the writer of these libs follows them): readLedger({sinceMs}) keeps rows whose `at`
//   is at or after the epoch time sinceMs, and `{}` keeps all; stats returns an array with one entry per check kind that has runs:
//   { kind, runs, blocks, actedOn, ignored, falseAlarmRate (a fraction, 0.2 = 20%), labels: { falseAlarm, real, missed }, medianMs, p90Ms,
//   notRun: { <why>: count } }; a `block` of a kind is a run with verdict `block` whose check of that kind has `new` above 0; an empty
//   ledger gives []; lastRun({ repoId }) matches the row field `repo`.
// Not covered here: the CLI text (`no runs yet`, the WARN line, owned by the CLI tests), the loading of a bad risk-rules.json (the loader's
//   name is the engine's choice), and the weakening that needs a deep parse (a changed `strict` nested in an `extends`).
// Invariants: projects are fixture projects in temp folders; the test process's HOME is pinned to a temp folder, so the ledger and every
//   other state land there, never under the real ~/.claude. This file is long on purpose: the plan names one file for the three libs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LEDGER_MAX_BYTES } from '../home/tools/done-check/lib/contract.mjs';
import { makeDoneCheckRepo } from './done-check-fixture.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const PINNED_HOME = makeTempDir('done-check-record-home-');
process.env.HOME = PINNED_HOME;
process.env.USERPROFILE = PINNED_HOME;

const LIB = new URL('../home/tools/done-check/lib/', import.meta.url);
const loadLedger = () => import(new URL('ledger.mjs', LIB).href);
const loadTestDiff = () => import(new URL('test-diff.mjs', LIB).href);
const loadRisk = () => import(new URL('risk.mjs', LIB).href);
const RULES_FILE = new URL('../home/tools/done-check/risk-rules.json', import.meta.url);
const LEDGER_FILE = join(PINNED_HOME, '.claude', 'state', 'done-check', 'ledger.jsonl');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** A whole run row (design section 6). Self-contained: a child process gets its source text. */
function runRow(overrides = {}) {
  return {
    v: 1, id: 'run-0', at: new Date().toISOString(), where: 'stop', session: 'session-1', agent: 'agent-1', repo: 'repo-1',
    base: 'a'.repeat(40), key: 'k'.repeat(64), files: 2, checks: { types: { result: 'ok', new: 0, old: 0, ms: 100 } },
    verdict: 'ok', risk: [], ms: 100, ...overrides,
  };
}
const labelRow = (overrides = {}) => ({ v: 1, label: 'false-alarm', run: 'run-0', check: 'types', at: new Date().toISOString(), note: 'a note', ...overrides });
const resetLedger = (t) => {
  const clear = () => rmSync(join(PINNED_HOME, '.claude'), { recursive: true, force: true });
  clear();
  t.after(clear);
};
const ledgerLines = () => (existsSync(LEDGER_FILE) ? readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean) : []);
const putLedgerFile = (buffer) => {
  mkdirSync(dirname(LEDGER_FILE), { recursive: true });
  writeFileSync(LEDGER_FILE, buffer);
};

test('an appended run row is read back whole, once, in order', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  const first = runRow({ id: 'run-1' });
  const second = runRow({ id: 'run-2', verdict: 'block', checks: { types: { result: 'fail', new: 1, old: 0, ms: 5 }, tests: { result: 'not-run', new: 0, old: 0, ms: 0, why: 'time' } } });
  assert.equal(await appendRun(first), true);
  assert.equal(await appendRun(second), true);
  const { runs, labels } = await readLedger({});
  assert.deepEqual(runs, [first, second]);
  assert.deepEqual(labels, []);
  assert.equal(ledgerLines().length, 2);
});

test('an appended label row is read back with the runs', async (t) => {
  resetLedger(t);
  const { appendLabel, appendRun, readLedger } = await loadLedger();
  const label = labelRow({ run: 'run-1' });
  await appendRun(runRow({ id: 'run-1' }));
  assert.equal(await appendLabel(label), true);
  const { runs, labels } = await readLedger({});
  assert.equal(runs.length, 1);
  assert.deepEqual(labels, [label]);
});

test('a row with a new line and quotes inside a text field is still one line and reads back the same', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  const row = runRow({ id: 'run-1', session: 'a\nb "c"   d' });
  assert.equal(await appendRun(row), true);
  assert.equal(ledgerLines().length, 1);
  assert.deepEqual((await readLedger({})).runs, [row]);
});

test('a note over 200 characters is never stored longer than 200', async (t) => {
  resetLedger(t);
  const { appendLabel, readLedger } = await loadLedger();
  const stored = await appendLabel(labelRow({ note: 'x'.repeat(500) }));
  const { labels } = await readLedger({});
  if (stored) assert.ok(labels[0].note.length <= 200);
  else assert.deepEqual(labels, []);
});

test('reading a ledger that does not exist gives empty lists', async (t) => {
  resetLedger(t);
  const { readLedger } = await loadLedger();
  assert.deepEqual(await readLedger({}), { runs: [], labels: [] });
});

test('sinceMs keeps only the rows at or after that time', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  const now = Date.now();
  await appendRun(runRow({ id: 'old', at: new Date(now - 40 * ONE_DAY_MS).toISOString() }));
  await appendRun(runRow({ id: 'recent', at: new Date(now - ONE_DAY_MS).toISOString() }));
  const { runs } = await readLedger({ sinceMs: now - 30 * ONE_DAY_MS });
  assert.deepEqual(runs.map((row) => row.id), ['recent']);
  assert.deepEqual((await readLedger({})).runs.map((row) => row.id), ['old', 'recent']);
});

test('a half line left by a crash does not eat the next row', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  const before = runRow({ id: 'before-crash' });
  putLedgerFile(`${JSON.stringify(before)}\n{"v":1,"id":"half-written","at":"2026-`); // no closing quote, no line feed
  const after = runRow({ id: 'after-crash' });
  assert.equal(await appendRun(after), true);
  const { runs } = await readLedger({});
  assert.deepEqual(runs.map((row) => row.id), ['before-crash', 'after-crash']);
});

test('lines that are not rows of this version are skipped without an error', async (t) => {
  resetLedger(t);
  const { readLedger } = await loadLedger();
  const good = runRow({ id: 'good' });
  const lines = ['not json at all', '[]', 'null', '"text"', '{"v":0,"id":"older"}', '{"v":2,"id":"newer"}', '{}', JSON.stringify(good)];
  putLedgerFile(`${lines.join('\n')}\n`);
  const { runs } = await readLedger({});
  assert.ok(runs.some((row) => row.id === 'good'));
  assert.ok(!runs.some((row) => row.id === 'older' || row.id === 'newer'), 'a row of another version was counted');
});

/**
 * A ledger file of exactly `total` bytes made of whole valid run rows (the last one is padded), so the reader has real rows to read.
 * @returns {{ buffer: Buffer, rows: number }}
 */
function ledgerOfSize(total) {
  const line = (index, pad) => `${JSON.stringify(runRow({ id: `fill-${String(index).padStart(8, '0')}`, session: 'x'.repeat(pad) }))}\n`;
  const unit = Buffer.byteLength(line(0, 200));
  const count = Math.floor(total / unit) - 1;
  const chunks = Array.from({ length: count }, (_, index) => line(index, 200));
  chunks.push(line(count, 200 + (total - count * unit - unit)));
  const buffer = Buffer.from(chunks.join(''));
  assert.equal(buffer.length, total);
  return { buffer, rows: count + 1 };
}

test('the ledger cap: a row that fills the file to exactly LEDGER_MAX_BYTES is written, and the reader reads all of it', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  const row = runRow({ id: 'last-fit' });
  const rowBytes = Buffer.byteLength(`${JSON.stringify(row)}\n`);
  const { buffer, rows } = ledgerOfSize(LEDGER_MAX_BYTES - rowBytes);
  putLedgerFile(buffer);
  assert.equal(await appendRun(row), true);
  assert.equal(statSync(LEDGER_FILE).size, LEDGER_MAX_BYTES);
  const { runs } = await readLedger({});
  assert.equal(runs.length, rows + 1);
  assert.equal(runs.at(-1).id, 'last-fit');
});

test('the ledger cap: a file of exactly LEDGER_MAX_BYTES refuses the next row and is still read whole', async (t) => {
  resetLedger(t);
  const { appendLabel, appendRun, readLedger } = await loadLedger();
  const { buffer, rows } = ledgerOfSize(LEDGER_MAX_BYTES);
  putLedgerFile(buffer);
  assert.equal(await appendRun(runRow({ id: 'too-much' })), false);
  assert.equal(await appendLabel(labelRow()), false);
  assert.equal(statSync(LEDGER_FILE).size, LEDGER_MAX_BYTES);
  assert.equal((await readLedger({})).runs.length, rows);
});

test('the ledger cap: one byte too few room refuses the row and leaves the file as it was', async (t) => {
  resetLedger(t);
  const { appendRun } = await loadLedger();
  const row = runRow({ id: 'one-byte-short' });
  const rowBytes = Buffer.byteLength(`${JSON.stringify(row)}\n`);
  const size = LEDGER_MAX_BYTES - rowBytes + 1;
  putLedgerFile(ledgerOfSize(size).buffer);
  assert.equal(await appendRun(row), false);
  assert.equal(statSync(LEDGER_FILE).size, size);
});

test('the ledger cap: a file one byte over LEDGER_MAX_BYTES is refused by the writer and read as empty, without an error', async (t) => {
  resetLedger(t);
  const { appendRun, readLedger } = await loadLedger();
  putLedgerFile(ledgerOfSize(LEDGER_MAX_BYTES + 1).buffer);
  assert.equal(await appendRun(runRow({ id: 'over' })), false);
  assert.equal(statSync(LEDGER_FILE).size, LEDGER_MAX_BYTES + 1);
  assert.deepEqual(await readLedger({}), { runs: [], labels: [] });
});

const APPENDER = `import { appendRun } from ${JSON.stringify(new URL('ledger.mjs', LIB).href)};
  const runRow = ${runRow.toString()};
  const [prefix, count, pad] = JSON.parse(process.argv[1]);
  for (let index = 0; index < count; index += 1) {
    if ((await appendRun(runRow({ id: prefix + '-' + index, session: 'x'.repeat(pad) }))) !== true) { console.error('appendRun did not return true'); process.exit(3); }
  }`;

test('several processes appending at once never interleave a line', async (t) => {
  resetLedger(t);
  const prefixes = ['p1', 'p2', 'p3', 'p4'];
  const perProcess = 60;
  const results = await Promise.all(prefixes.map((prefix) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', APPENDER, JSON.stringify([prefix, perProcess, 3000])], {
      env: { ...process.env, HOME: PINNED_HOME, USERPROFILE: PINNED_HOME }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  })));
  for (const { status, stderr } of results) assert.equal(status, 0, stderr);
  const lines = ledgerLines();
  assert.equal(lines.length, prefixes.length * perProcess);
  const ids = lines.map((line) => JSON.parse(line).id);
  assert.equal(new Set(ids).size, ids.length);
  const { readLedger } = await loadLedger();
  assert.equal((await readLedger({})).runs.length, prefixes.length * perProcess);
});

test('lastRun gives the newest run that matches every filter, and null when none does', async (t) => {
  resetLedger(t);
  const { appendRun, lastRun } = await loadLedger();
  assert.equal(await lastRun({}), null);
  await appendRun(runRow({ id: 'r1-s1-a1', repo: 'repo-1', session: 's1', agent: 'a1' }));
  await appendRun(runRow({ id: 'r1-s1-a2', repo: 'repo-1', session: 's1', agent: 'a2' }));
  await appendRun(runRow({ id: 'r2-s2-a1', repo: 'repo-2', session: 's2', agent: 'a1' }));
  await appendRun(runRow({ id: 'r1-s1-a1-again', repo: 'repo-1', session: 's1', agent: 'a1' }));
  assert.equal((await lastRun({ repoId: 'repo-1' })).id, 'r1-s1-a1-again');
  assert.equal((await lastRun({ repoId: 'repo-1', agent: 'a2' })).id, 'r1-s1-a2');
  assert.equal((await lastRun({ session: 's2' })).id, 'r2-s2-a1');
  assert.equal((await lastRun({ repoId: 'repo-2', agent: 'a2' })), null);
});

/** A block run of `agent` on the types check, and the next run of that agent: left open (same key) or fixed (another key, types ok). */
function blockAndNext(index, { ignored, startMs, extraChecks = {} }) {
  const at = (offsetMs) => new Date(startMs + index * 10_000 + offsetMs).toISOString();
  const blocked = runRow({ id: `block-${index}`, agent: `agent-${index}`, key: `key-${index}`, at: at(0), verdict: 'block', checks: { types: { result: 'fail', new: 1, old: 0, ms: 100 }, lint: { result: 'ok', new: 0, old: 0, ms: 10 }, ...extraChecks } });
  const next = ignored
    ? runRow({ id: `next-${index}`, agent: `agent-${index}`, key: `key-${index}`, at: at(1000), verdict: 'left-open', checks: { types: { result: 'fail', new: 1, old: 0, ms: 100 }, lint: { result: 'ok', new: 0, old: 0, ms: 10 } } })
    : runRow({ id: `next-${index}`, agent: `agent-${index}`, key: `key-${index}-fixed`, at: at(1000), verdict: 'ok', checks: { types: { result: 'ok', new: 0, old: 0, ms: 100 }, lint: { result: 'ok', new: 0, old: 0, ms: 10 } } });
  return [blocked, next];
}

/** The A11 ledger: 10 blocks of the types check, the next run of 2 agents has the same key (ignored), of 8 another key and types ok. */
const tenBlocksTwoIgnored = () => {
  const startMs = Date.now() - ONE_DAY_MS;
  return Array.from({ length: 10 }, (_, index) => blockAndNext(index, { ignored: index < 2, startMs })).flat();
};
const entryOf = (stats, kind) => stats.find((entry) => entry.kind === kind);

test('stats of 10 blocks with 2 ignored: types acted-on 8, ignored 2, false-alarm rate 20%', async () => {
  const { stats } = await loadLedger();
  const types = entryOf(stats({ runs: tenBlocksTwoIgnored(), labels: [] }), 'types');
  assert.equal(types.runs, 20);
  assert.equal(types.blocks, 10);
  assert.equal(types.ignored, 2);
  assert.equal(types.actedOn, 8);
  assert.equal(types.falseAlarmRate, 0.2);
  assert.deepEqual(types.labels, { falseAlarm: 0, real: 0, missed: 0 });
});

test('stats: a check that never blocked has 0 blocks and a false-alarm rate of 0, not NaN', async () => {
  const { stats } = await loadLedger();
  const lint = entryOf(stats({ runs: tenBlocksTwoIgnored(), labels: [] }), 'lint');
  assert.equal(lint.blocks, 0);
  assert.equal(lint.falseAlarmRate, 0);
});

test('stats: an owner false-alarm label counts as a false alarm, a real label takes one back, a missed label changes no rate', async () => {
  const { stats } = await loadLedger();
  const runs = tenBlocksTwoIgnored();
  const label = (label, run, check = 'types') => labelRow({ label, run, check });
  const falseAlarm = entryOf(stats({ runs, labels: [label('false-alarm', 'block-5')] }), 'types');
  assert.equal(falseAlarm.falseAlarmRate, 0.3);
  assert.equal(falseAlarm.labels.falseAlarm, 1);
  const real = entryOf(stats({ runs, labels: [label('real', 'block-0')] }), 'types'); // block-0 was ignored, the owner says it was real
  assert.equal(real.falseAlarmRate, 0.1);
  assert.equal(real.labels.real, 1);
  const missed = entryOf(stats({ runs, labels: [label('missed', 'next-9')] }), 'types');
  assert.equal(missed.falseAlarmRate, 0.2);
  assert.equal(missed.labels.missed, 1);
  const otherKind = entryOf(stats({ runs, labels: [label('false-alarm', 'block-5', 'lint')] }), 'types');
  assert.equal(otherKind.falseAlarmRate, 0.2);
});

test('stats: a label for a run that is not in the ledger changes nothing and is no error', async () => {
  const { stats } = await loadLedger();
  const types = entryOf(stats({ runs: tenBlocksTwoIgnored(), labels: [labelRow({ run: 'no-such-run' })] }), 'types');
  assert.equal(types.blocks, 10);
  assert.equal(types.falseAlarmRate, 0.2);
});

test('stats: median and p90 time of a check, and its not-run runs by reason', async () => {
  const { stats } = await loadLedger();
  const timed = [...Array.from({ length: 8 }, () => 10), 500, 500];
  const runs = timed.map((ms, index) => runRow({ id: `lint-${index}`, agent: `lint-${index}`, checks: { lint: { result: 'ok', new: 0, old: 0, ms }, tests: { result: 'not-run', new: 0, old: 0, ms: 0, why: index < 2 ? 'time' : 'no-command' } } }));
  const result = stats({ runs, labels: [] });
  assert.equal(entryOf(result, 'lint').medianMs, 10);
  assert.equal(entryOf(result, 'lint').p90Ms, 500);
  assert.deepEqual(entryOf(result, 'tests').notRun, { time: 2, 'no-command': 8 });
  assert.equal(entryOf(result, 'tests').blocks, 0);
});

test('stats of an empty ledger is an empty list', async () => {
  const { stats } = await loadLedger();
  assert.deepEqual(stats({ runs: [], labels: [] }), []);
});

/** A scope for the test-diff and risk libs: the repo, its base commit and the changed files (the lib reads the changes from git). */
const scopeOf = (repo, files, wide = []) => ({ top: repo.dir, git: true, base: repo.baseSha, files, wide, key: 'f'.repeat(64) });
const ONE_TEST = "import test from 'node:test';\ntest('works', () => {});\n";
const THREE_TESTS = "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\ntest('three', () => {});\n";
const THREE_EXPECTS = "import { test, expect } from 'vitest';\ntest('works', () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n";

/** Runs weakenedTests on a fresh repo where `base` files exist at the base commit and `change(repo)` then edits the tree. */
async function weakenedAfter(t, { base = {}, change, files, wide = [], commit = false }) {
  const repo = makeDoneCheckRepo({ files: base });
  t.after(() => repo.cleanup());
  change(repo);
  if (commit) repo.commit('the change');
  const { weakenedTests } = await loadTestDiff();
  return weakenedTests(scopeOf(repo, files, wide));
}

function assertWeakened(failures, file) {
  assert.ok(failures.some((failure) => failure.file === file), `no weakened-test failure for ${file}: ${JSON.stringify(failures)}`);
  for (const failure of failures) {
    assert.equal(failure.kind, 'tests-weakened');
    assert.ok(typeof failure.id === 'string' && failure.id !== '');
    assert.ok(typeof failure.text === 'string' && failure.text !== '' && !failure.text.includes('\n'), 'the text is one line');
  }
}

test('a deleted test file is weakened', async (t) => {
  const failures = await weakenedAfter(t, { base: { 'src/a.test.ts': THREE_TESTS }, change: (repo) => repo.remove('src/a.test.ts'), files: ['src/a.test.ts'] });
  assertWeakened(failures, 'src/a.test.ts');
});

test('a deleted test file whose name has a space and a quote is weakened', async (t) => {
  const name = "src/my test's.test.ts";
  const failures = await weakenedAfter(t, { base: { [name]: THREE_TESTS }, change: (repo) => repo.remove(name), files: [name] });
  assertWeakened(failures, name);
});

test('fewer test cases in a changed test file is weakened', async (t) => {
  const failures = await weakenedAfter(t, {
    base: { 'src/a.test.ts': THREE_TESTS },
    change: (repo) => repo.write('src/a.test.ts', "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n"),
    files: ['src/a.test.ts'],
  });
  assertWeakened(failures, 'src/a.test.ts');
});

test('fewer assertions in a changed test file is weakened', async (t) => {
  const failures = await weakenedAfter(t, {
    base: { 'src/a.test.ts': THREE_EXPECTS },
    change: (repo) => repo.write('src/a.test.ts', "import { test, expect } from 'vitest';\ntest('works', () => {\n  expect(1).toBe(1);\n});\n"),
    files: ['src/a.test.ts'],
  });
  assertWeakened(failures, 'src/a.test.ts');
});

const SOFTENINGS = [
  ['toBe to toBeDefined', 'expect(1).toBe(1);', 'expect(1).toBeDefined();'],
  ['toEqual to toBeTruthy', 'expect(2).toEqual(2);', 'expect(2).toBeTruthy();'],
  ['assert.equal to toBeDefined', 'assert.equal(3, 3);', 'expect(3).toBeDefined();'],
];
const softSource = (line) => `import { test, expect } from 'vitest';\ntest('works', () => {\n  ${line}\n  expect(4).toBe(4);\n});\n`;
for (const [name, strong, weak] of SOFTENINGS) {
  test(`an assertion softened from ${name} is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { 'src/a.test.ts': softSource(strong) }, change: (repo) => repo.write('src/a.test.ts', softSource(weak)), files: ['src/a.test.ts'] });
    assertWeakened(failures, 'src/a.test.ts');
    assert.ok(failures.some((failure) => failure.id === 'src/a.test.ts|softened-assertion'), JSON.stringify(failures));
  });
}

const SKIPS = [
  ['test.skip', "test.skip('later', () => {});"], ['it.skip', "it.skip('later', () => {});"], ['describe.skip', "describe.skip('suite', () => {});"],
  ['test.only', "test.only('only this', () => {});"], ['it.only', "it.only('only this', () => {});"], ['it.todo', "it.todo('later');"],
  ['xit', "xit('later', () => {});"], ['xdescribe', "xdescribe('suite', () => {});"], ['a node:test skip option', "test('later', { skip: true }, () => {});"],
];
for (const [name, line] of SKIPS) {
  test(`an added ${name} is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { 'src/a.test.ts': ONE_TEST }, change: (repo) => repo.write('src/a.test.ts', `${ONE_TEST}${line}\n`), files: ['src/a.test.ts'] });
    assertWeakened(failures, 'src/a.test.ts');
  });
}

const SUPPRESSIONS = ['// eslint-disable-next-line no-console', '/* eslint-disable */', '// @ts-ignore', '// @ts-expect-error', '// @ts-nocheck',
  '/* istanbul ignore next */', '/* c8 ignore next */', '/* v8 ignore next */'];
for (const line of SUPPRESSIONS) {
  test(`an added ${line.replace(/^\/[/*] |\s*\*\/$/g, '')} is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { 'src/a.ts': 'export const a = 1;\n' }, change: (repo) => repo.write('src/a.ts', `${line}\nexport const a = 1;\n`), files: ['src/a.ts'] });
    assertWeakened(failures, 'src/a.ts');
  });
}

test('a weakening that is already committed is still seen', async (t) => {
  const failures = await weakenedAfter(t, { base: { 'src/a.test.ts': ONE_TEST }, change: (repo) => repo.write('src/a.test.ts', `${ONE_TEST}test.skip('later', () => {});\n`), files: ['src/a.test.ts'], commit: true });
  assertWeakened(failures, 'src/a.test.ts');
});

const PACKAGE = { name: 'p', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'tsc' }, dependencies: {} };
const withScripts = (scripts, extra = {}) => `${JSON.stringify({ ...PACKAGE, ...extra, scripts: { ...PACKAGE.scripts, ...scripts } }, null, 2)}\n`;
for (const script of ['test', 'typecheck', 'lint']) {
  test(`a changed ${script} script in package.json is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { 'package.json': withScripts({}) }, change: (repo) => repo.write('package.json', withScripts({ [script]: 'echo skipped' })), files: [], wide: ['package.json'] });
    assertWeakened(failures, 'package.json');
  });
}

test('a removed lint script in package.json is weakened', async (t) => {
  const failures = await weakenedAfter(t, {
    base: { 'package.json': withScripts({}) },
    change: (repo) => repo.write('package.json', `${JSON.stringify({ ...PACKAGE, scripts: { test: PACKAGE.scripts.test, typecheck: PACKAGE.scripts.typecheck, build: PACKAGE.scripts.build } }, null, 2)}\n`),
    files: [], wide: ['package.json'],
  });
  assertWeakened(failures, 'package.json');
});

test('a changed build script, a new dependency, a new script and a reformat of package.json are not weakened', async (t) => {
  const changes = [withScripts({ build: 'tsc -p .' }), withScripts({}, { dependencies: { left: '1.0.0' } }), withScripts({ format: 'prettier .' }), `${JSON.stringify(JSON.parse(withScripts({})), null, 4)}\n`];
  for (const text of changes) {
    assert.deepEqual(await weakenedAfter(t, { base: { 'package.json': withScripts({}) }, change: (repo) => repo.write('package.json', text), files: [], wide: ['package.json'] }), []);
  }
});

const CONFIGS = ['eslint.config.js', 'vitest.config.ts', 'jest.config.js', '.eslintrc.json'];
for (const config of CONFIGS) {
  test(`a changed ${config} is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { [config]: '{ "rules": { "no-var": "error" } }\n' }, change: (repo) => repo.write(config, '{ "rules": {} }\n'), files: [config], wide: [config] });
    assertWeakened(failures, config);
  });
}

const tsconfig = (options) => `${JSON.stringify({ compilerOptions: { target: 'es2022', ...options } }, null, 2)}\n`;
for (const flag of ['strict', 'noImplicitAny', 'strictNullChecks']) {
  test(`a tsconfig ${flag} turned off is weakened`, async (t) => {
    const failures = await weakenedAfter(t, { base: { 'tsconfig.json': tsconfig({ [flag]: true }) }, change: (repo) => repo.write('tsconfig.json', tsconfig({ [flag]: false })), files: [], wide: ['tsconfig.json'] });
    assertWeakened(failures, 'tsconfig.json');
  });
}

test('a tsconfig change that is not a strictness flag turned off is not weakened', async (t) => {
  const stricter = await weakenedAfter(t, { base: { 'tsconfig.json': tsconfig({ strict: false }) }, change: (repo) => repo.write('tsconfig.json', tsconfig({ strict: true })), files: [], wide: ['tsconfig.json'] });
  const unrelated = await weakenedAfter(t, { base: { 'tsconfig.json': tsconfig({ strict: true }) }, change: (repo) => repo.write('tsconfig.json', tsconfig({ strict: true, target: 'es2023' })), files: [], wide: ['tsconfig.json'] });
  assert.deepEqual([stricter, unrelated], [[], []]);
});

const NOT_WEAKENED = [
  ['a new test file', { base: {}, change: (repo) => repo.write('src/new.test.ts', THREE_TESTS), files: ['src/new.test.ts'] }],
  ['more test cases', { base: { 'src/a.test.ts': ONE_TEST }, change: (repo) => repo.write('src/a.test.ts', THREE_TESTS), files: ['src/a.test.ts'] }],
  ['a renamed test with the same count', { base: { 'src/a.test.ts': THREE_TESTS }, change: (repo) => repo.write('src/a.test.ts', THREE_TESTS.replace("'one'", "'first'")), files: ['src/a.test.ts'] }],
  ['a removed skip', { base: { 'src/a.test.ts': `${ONE_TEST}test.skip('later', () => {});\n` }, change: (repo) => repo.write('src/a.test.ts', ONE_TEST), files: ['src/a.test.ts'] }],
  ['a removed @ts-ignore', { base: { 'src/a.ts': '// @ts-ignore\nexport const a = 1;\n' }, change: (repo) => repo.write('src/a.ts', 'export const a = 1;\n'), files: ['src/a.ts'] }],
  ['an old skip that is not touched', { base: { 'src/a.test.ts': `${ONE_TEST}test.skip('old', () => {});\n` }, change: (repo) => repo.write('src/a.test.ts', `${ONE_TEST}test.skip('old', () => {});\n// a comment\n`), files: ['src/a.test.ts'] }],
  ['the word skip in a name or a string', { base: { 'src/a.test.ts': ONE_TEST }, change: (repo) => repo.write('src/a.test.ts', `${ONE_TEST}test('handles skipped rows', () => { const note = 'skip this'; });\n`), files: ['src/a.test.ts'] }],
  ['a toBeDefined added next to the strong checks that stay', { base: { 'src/a.test.ts': softSource('expect(1).toBe(1);') }, change: (repo) => repo.write('src/a.test.ts', softSource('expect(1).toBe(1);\n  expect(5).toBeDefined();')), files: ['src/a.test.ts'] }],
  ['a toBe changed to a toEqual', { base: { 'src/a.test.ts': softSource('expect(1).toBe(1);') }, change: (repo) => repo.write('src/a.test.ts', softSource('expect(1).toEqual(1);')), files: ['src/a.test.ts'] }],
  ['an ordinary code change', { base: { 'src/a.ts': 'export const a = 1;\n' }, change: (repo) => repo.write('src/a.ts', 'export const a = 2;\nexport const b = 3;\n'), files: ['src/a.ts'] }],
];
for (const [name, options] of NOT_WEAKENED) {
  test(`${name} is not weakened`, async (t) => {
    assert.deepEqual(await weakenedAfter(t, options), []);
  });
}

test('without git there is no base and nothing is reported', async (t) => {
  const repo = makeDoneCheckRepo({ plain: true, files: { 'src/a.test.ts': ONE_TEST } });
  t.after(() => repo.cleanup());
  const { weakenedTests } = await loadTestDiff();
  assert.deepEqual(await weakenedTests({ top: repo.dir, git: false, base: null, files: ['src/a.test.ts'], wide: [], key: 'f'.repeat(64) }), []);
});

let sharedRepo = null;
const quietRepo = () => {
  sharedRepo ??= makeDoneCheckRepo(); // removed by the fixture when the process ends
  return sharedRepo;
};
const classesOf = async (files, extra) => {
  const { riskClasses } = await loadRisk();
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  const found = await riskClasses(scopeOf(quietRepo(), files), rules, extra);
  return { classes: [...new Set(found.map((entry) => entry.class))].sort(), found };
};

const RISKY_PATHS = {
  security: ['src/auth/login.ts', 'src/session.ts', 'lib/token.ts', 'src/secret.ts', 'src/credential-store.ts', 'src/crypto.ts', 'src/permission.ts', 'hooks/guard.mjs',
    'src/sandbox.ts', 'src/sanitize.ts', 'api/upload.ts', 'api/webhook.ts', 'src/oauth.ts', 'src/jwt.ts', 'src/cookie.ts', 'src/csrf.ts', 'src/cors.ts'],
  data: ['prisma/migrations/001_init/migration.sql', 'db/schema.ts', 'reports/query.sql', 'prisma/seed.ts'],
  money: ['src/payment.ts', 'src/invoice.ts', 'services/bb-billing/index.ts', 'src/refund.ts', 'src/stripe.ts', 'src/wallet.ts'],
  concurrency: ['src/lock.ts', 'src/mutex.ts', 'src/semaphore.ts', 'src/job-queue.ts', 'src/worker.ts'],
  gate: ['home/hooks/commit-gate.mjs', 'home/hooks/lib/gated-folder.mjs', 'home/tools/land-lane/land-lane.mjs', 'home/tools/road/road.mjs'],
};
for (const [riskClass, paths] of Object.entries(RISKY_PATHS)) {
  for (const path of paths) {
    test(`${path} is in the ${riskClass} class`, async () => {
      const { classes, found } = await classesOf([path]);
      assert.ok(classes.includes(riskClass), `classes of ${path}: ${classes.join(', ') || 'none'}`);
      assert.ok(found.some((entry) => entry.class === riskClass && entry.file === path));
    });
  }
}

test('ordinary source files have no risk class', async () => {
  assert.deepEqual((await classesOf(['src/components/Button.tsx', 'src/utils/format.ts', 'src/pages/home.tsx'])).classes, []);
});

test('no changed file gives no risk class', async () => {
  assert.deepEqual((await classesOf([])).classes, []);
});

for (const path of ['src/checkout/cart.ts', 'home/tools/done-check/lib/ledger.mjs', 'home/hooks/lib/stale-checkout.mjs', 'src/git checkout.ts']) {
  test(`${path} is not money`, async () => {
    assert.ok(!(await classesOf([path])).classes.includes('money'));
  });
}

test('one file can be in two classes', async () => {
  const { classes } = await classesOf(['src/payment/webhook.ts']);
  assert.deepEqual(classes, ['money', 'security']);
});

// A file in the money class (by its path) whose lines change in different ways: only comments and blank lines leave the class.
const BILLING_FILE = 'services/bb-billing/src/state.ts';
const BILLING_SOURCE = ['// Billing state.', '/**', ' * Charges one invoice.', ' */', 'export function charge(amount: number) {', '  return amount * 2;', '}', ''].join('\n');
async function billingClassesAfter(t, change) {
  const repo = makeDoneCheckRepo({ files: { [BILLING_FILE]: BILLING_SOURCE } });
  t.after(() => repo.cleanup());
  repo.write(BILLING_FILE, change(BILLING_SOURCE));
  const { riskClasses } = await loadRisk();
  return (await riskClasses(scopeOf(repo, [BILLING_FILE]), JSON.parse(readFileSync(RULES_FILE, 'utf8')))).map((entry) => entry.class);
}
const COMMENT_ONLY_EDITS = {
  'a reworded line comment': (text) => text.replace('// Billing state.', '// Billing state, reworded.'),
  'a reworded doc comment line': (text) => text.replace(' * Charges one invoice.', ' * Charges one invoice, once.'),
  'a new comment line': (text) => text.replace('export function', '// Doubles the amount.\nexport function'),
  'a prose line without a star inside a block comment': (text) => text.replace(' */', ' prose without a star\n */'),
  'blank lines': (text) => text.replace('}\n', '}\n\n\n'),
};
for (const [name, change] of Object.entries(COMMENT_ONLY_EDITS)) {
  test(`billing code with ${name} only is not money`, async (t) => {
    assert.deepEqual(await billingClassesAfter(t, change), []);
  });
}

const CODE_EDITS = {
  'a changed return': (text) => text.replace('amount * 2', 'amount * 3'),
  'a trailing comment added to a code line': (text) => text.replace('return amount * 2;', 'return amount * 2; // double'),
  'a code line next to a comment edit': (text) => text.replace('// Billing state.', '// Billing state.\nexport const FEE = 1;'),
  'a line removed': (text) => text.replace('  return amount * 2;\n', ''),
};
for (const [name, change] of Object.entries(CODE_EDITS)) {
  test(`billing code with ${name} is still money`, async (t) => {
    assert.deepEqual(await billingClassesAfter(t, change), ['money']);
  });
}

test('a billing file the change cannot be read for (no base) keeps its class', async () => {
  const { riskClasses } = await loadRisk();
  const scope = { ...scopeOf(quietRepo(), [BILLING_FILE]), git: false, base: null };
  assert.deepEqual((await riskClasses(scope, JSON.parse(readFileSync(RULES_FILE, 'utf8')))).map((entry) => entry.class), ['money']);
});

test('a class a lane adds by name is always in the result, also with no matching path', async () => {
  const { classes } = await classesOf(['src/utils/format.ts'], ['security', 'audit']);
  assert.deepEqual(classes, ['audit', 'security']);
});

/** The risk classes of a change made in a fresh repo (the shared one stays clean); `files` is what the scope lists as changed. */
async function largeClassAfter(t, change, files) {
  const repo = makeDoneCheckRepo({ files: { 'src/big.ts': 'export const first = 1;\n' } });
  t.after(() => repo.cleanup());
  change(repo);
  const { riskClasses } = await loadRisk();
  const found = await riskClasses(scopeOf(repo, files), JSON.parse(readFileSync(RULES_FILE, 'utf8')));
  return found.map((entry) => entry.class);
}
const lines = (count) => `${Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`).join('\n')}\n`;
const sixteen = Array.from({ length: 16 }, (_, index) => `src/part${index}.ts`);

test('a change of more than 400 lines is large, 400 lines are not', async (t) => {
  assert.ok(!(await largeClassAfter(t, (repo) => repo.write('src/big.ts', `export const first = 1;\n${lines(400)}`), ['src/big.ts'])).includes('large'));
  assert.ok((await largeClassAfter(t, (repo) => repo.write('src/big.ts', `export const first = 1;\n${lines(401)}`), ['src/big.ts'])).includes('large'));
});

test('a change of more than 15 files is large, 15 files are not', async (t) => {
  const write = (count) => (repo) => sixteen.slice(0, count).forEach((file) => repo.write(file, 'export {};\n'));
  assert.ok(!(await largeClassAfter(t, write(15), sixteen.slice(0, 15))).includes('large'));
  assert.ok((await largeClassAfter(t, write(16), sixteen)).includes('large'));
});

test('the shipped risk-rules.json exists and is valid JSON', () => {
  assert.ok(existsSync(RULES_FILE));
  assert.doesNotThrow(() => JSON.parse(readFileSync(RULES_FILE, 'utf8')));
});
