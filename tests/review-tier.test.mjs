// Tests for home/tools/review-tier: which classes a diff hits, which reviews and plans that asks for, and the CLI around it.
// The tests feed fabricated diffs to buildReport (no git); the CLI and agent-text tests are in review-tier-cli.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../home/tools/review-tier/lib/report.mjs';

/** A changed file: `added` and `removed` are lists of line texts. */
const changed = (path, added = [], removed = []) => ({
  path,
  added: added.map((text, index) => ({ line: index + 1, text })),
  removed: removed.map((text, index) => ({ line: index + 1, text })),
});

/** The report for `files`; `newFiles` maps a path to the whole new file text (for the file-level conditions). */
function report(files, { newFiles = {}, ...options } = {}) {
  return buildReport({
    files, readNewFile: (path) => newFiles[path] ?? null, landing: false, addClasses: [], laneClasses: null,
    range: 'main...HEAD', deltaOf: null, requiredReading: [], ...options,
  });
}

const reviewBy = (result, agent, model, effort) => result.reviews.find((r) => r.agent === agent && r.model === model && r.effort === effort);
const logicLine = (text) => changed('home/tools/x/x.mjs', [text]);

test('a README-only diff is tier 0 and asks for no review', () => {
  const result = report([changed('README.md', ['# title'])]);
  assert.equal(result.tier, 0);
  assert.deepEqual(result.classes, ['docs']);
  assert.deepEqual(result.reviews, []);
});

test('one logic line asks for the Sonnet high correctness lens only', () => {
  const result = report([logicLine('const total = a + b;')]);
  assert.equal(result.tier, 1);
  assert.deepEqual(result.classes, ['logic']);
  assert.deepEqual(result.reviews.map((r) => [r.agent, r.model, r.effort, r.lens]), [['reviewer', 'sonnet', 'high', 'correctness']]);
  assert.equal(result.reviews[0].rules, 'core');
  assert.deepEqual(result.reviews[0].plan, { stress: null, race: null, mutation: null });
});

test('spawnSync is security: Opus max lens and auditor, with a diff-scoped mutation plan', () => {
  const result = report([logicLine('const out = spawnSync(cmd, args);')]);
  assert.deepEqual(result.classes, ['security', 'logic']);
  assert.equal(result.tier, 2);
  assert.ok(reviewBy(result, 'reviewer', 'opus', 'max'));
  const auditor = reviewBy(result, 'security-auditor', 'opus', 'max');
  assert.deepEqual(auditor.plan.mutation, { maxMutants: 1 });
  assert.equal(auditor.rules, 'backend');
});

test('openSync(p, "wx") is a lock: tier 3, Opus max lens with the stress plan of the real failure', () => {
  const result = report([logicLine("const fd = openSync(path, 'wx');")]);
  assert.equal(result.tier, 3);
  assert.ok(result.classes.includes('concurrency'));
  const lens = reviewBy(result, 'reviewer', 'opus', 'max');
  assert.match(lens.lens, /^risk: concurrency/);
  assert.deepEqual(lens.plan.stress, { staleLock: true, killPct: 5, waiters: [8, 20], repeats: 3, count: ['double-holders', 'lost-updates'] });
  assert.equal(lens.plan.race, null);
});

test('a lock word on a changed line adds the stress plan', () => {
  assert.notEqual(reviewBy(report([logicLine('const lock = acquire(file);')]), 'reviewer', 'opus', 'max').plan.stress, null);
});

test('rename(tmp, dest) is concurrency: Opus max lens and a concurrent-actors check, not the stale-lock plan (lock-free race)', () => {
  const result = report([logicLine('renameSync(tmp, dest);')]);
  assert.equal(result.tier, 3);
  const lens = reviewBy(result, 'reviewer', 'opus', 'max');
  assert.equal(lens.plan.stress, null);
  assert.deepEqual(lens.plan.race, { runs: 200 });
});

test('rmSync, unlink, rmdir and a mkdir without recursive are races; mkdir with recursive is not', () => {
  for (const line of ['rmSync(dir);', 'unlinkSync(f);', 'await fs.rmdir(d);', 'mkdirSync(lockDir);']) {
    assert.ok(report([logicLine(line)]).classes.includes('concurrency'), line);
  }
  assert.ok(!report([logicLine('mkdirSync(d, { recursive: true });')]).classes.includes('concurrency'));
});

test('link( with a write call in the same file is concurrency-lite: Opus high lens and the stress plan', () => {
  const file = 'home/tools/x/x.mjs';
  const result = report([changed(file, ['linkSync(a, b);'])], { newFiles: { [file]: "writeFileSync(a, 'x');\nlinkSync(a, b);\n" } });
  assert.deepEqual(result.classes, ['concurrency-lite', 'logic']);
  assert.equal(result.tier, 2);
  const lens = reviewBy(result, 'reviewer', 'opus', 'high');
  assert.notEqual(lens.plan.stress, null);
  assert.equal(reviewBy(result, 'reviewer', 'opus', 'max'), undefined);
  assert.equal(result.reviews.find((r) => r.agent === 'security-auditor'), undefined);
});

test('link( alone, and unlink( as a plain race, are not concurrency-lite', () => {
  assert.ok(!report([logicLine('linkSync(a, b);')]).classes.includes('concurrency-lite'));
  assert.ok(!report([logicLine('unlinkSync(a);')]).classes.includes('concurrency-lite'));
});

test('existsSync added in a file with an unchanged writeFileSync is concurrency (file-level co-occurrence)', () => {
  const file = 'home/tools/x/x.mjs';
  const newFiles = { [file]: "writeFileSync(p, 'x');\nif (existsSync(p)) {}\n" };
  assert.ok(report([changed(file, ['if (existsSync(p)) {}'])], { newFiles }).classes.includes('concurrency'));
  assert.ok(!report([changed(file, ['if (existsSync(p)) {}'])], { newFiles: { [file]: 'if (existsSync(p)) {}\n' } }).classes.includes('concurrency'));
});

test('--landing on a one-line logic change asks Sonnet high, Opus max, the auditor at Opus max and a mutation plan', () => {
  const result = report([logicLine('const total = a + b;')], { landing: true });
  assert.ok(reviewBy(result, 'reviewer', 'sonnet', 'high'));
  assert.match(reviewBy(result, 'reviewer', 'opus', 'max').lens, /landing/);
  assert.deepEqual(reviewBy(result, 'security-auditor', 'opus', 'max').plan.mutation, { maxMutants: 1 });
});

test('mutation plan is at most one mutant per changed line and 7 per changed file', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `spawnSync(c${index});`);
  assert.deepEqual(report([changed('a.mjs', lines)]).reviews.at(-1).plan.mutation, { maxMutants: 7 });
});

test('req.body outside a security path is untrusted-input with the auditor at Opus max', () => {
  const result = report([logicLine('const name = req.body.name;')]);
  assert.deepEqual(result.classes, ['untrusted-input', 'logic']);
  assert.ok(reviewBy(result, 'security-auditor', 'opus', 'max'));
});

test('path.join with a variable is untrusted-input; with literals or a trusted base it is not; fetch(url) is, fetch("/x") is not', () => {
  for (const line of ['path.join(dir, name)', 'fetch(url)', 'fetch(`/api/${id}`)']) assert.ok(report([logicLine(line)]).classes.includes('untrusted-input'), line);
  for (const line of ["path.join('a', 'b')", "path.join(__dirname, 'b')", "fetch('/x', { method: 'POST' })"]) assert.ok(!report([logicLine(line)]).classes.includes('untrusted-input'), line);
});

test('prisma.user.deleteMany({ is data with the auditor at Opus max; a migration folder carries core+db', () => {
  const orm = report([logicLine('await prisma.user.deleteMany({ where });')]);
  assert.ok(orm.classes.includes('data'));
  assert.ok(reviewBy(orm, 'security-auditor', 'opus', 'max'));
  const migration = report([changed('migrations/1.sql', ['select 1;'])]);
  assert.ok(migration.classes.includes('data'));
  assert.equal(migration.reviews[0].rules, 'core+db');
});

test('ordinary words are not data or money: truncated, truncate(text), git checkout', () => {
  for (const line of ['outcome.truncated = true;', 'const short = truncate(text);', "run('git checkout main');"]) {
    const classes = report([logicLine(line)]).classes;
    assert.ok(!classes.includes('data') && !classes.includes('money'), line);
  }
  assert.ok(report([logicLine('TRUNCATE users;')]).classes.includes('data'));
  assert.ok(report([logicLine('await stripe.checkout.sessions.create(x);')]).classes.includes('money'));
});

test('a behaviour-text file is tier 1 and its prose lines are not scanned', () => {
  const result = report([changed('home/modes/x.md', ['never print the password or the secret'])]);
  assert.deepEqual(result.classes, ['behaviour']);
  assert.equal(result.tier, 1);
});

test('a .tsx file adds the ui-quality-pass skill line', () => {
  const result = report([changed('src/App.tsx', ['const a = 1;'])]);
  assert.ok(result.reviews.some((r) => r.agent === 'skill' && r.lens === 'ui-quality-pass'));
});

test('a lockfile is security and not concurrency; an svg is logic', () => {
  const lock = report([changed('pnpm-lock.yaml', ['x: 1'])]);
  assert.ok(lock.classes.includes('security') && !lock.classes.includes('concurrency'));
  assert.deepEqual(report([changed('assets/x.svg', ['<svg/>'])]).classes, ['logic']);
});

test('a path with block or clock is not a lock; session-lock is', () => {
  assert.ok(!report([changed('src/clock.mjs', ['x'])]).classes.includes('concurrency'));
  assert.ok(report([changed('src/sessionLock.mjs', ['x'])]).classes.includes('concurrency'));
});

test('hooks-only is the audit class: auditor Opus high mid-lane, Opus max with --landing', () => {
  const files = [changed('home/hooks/x-gate.mjs', ['const a = 1;'])];
  assert.ok(report(files).classes.includes('audit'));
  assert.ok(reviewBy(report(files), 'security-auditor', 'opus', 'high'));
  assert.ok(reviewBy(report(files, { landing: true }), 'security-auditor', 'opus', 'max'));
});

test('a hooks file with a security hit is security, so the auditor runs at Opus max mid-lane', () => {
  const result = report([changed('home/hooks/x.mjs', ['spawnSync(a);'])]);
  assert.ok(result.classes.includes('security') && !result.classes.includes('audit'));
  assert.ok(reviewBy(result, 'security-auditor', 'opus', 'max'));
});

test('a docs-only --landing asks the Sonnet lens only', () => {
  const result = report([changed('docs/guide.md', ['text'])], { landing: true });
  assert.deepEqual(result.reviews.map((r) => [r.agent, r.model, r.effort]), [['reviewer', 'sonnet', 'high']]);
});

test('more than 400 changed lines is the size class: an Opus high lens, no auditor', () => {
  const lines = Array.from({ length: 450 }, (_, index) => `const v${index} = ${index};`);
  const result = report([changed('src/a.mjs', lines)]);
  assert.ok(result.classes.includes('size'));
  assert.ok(reviewBy(result, 'reviewer', 'opus', 'high'));
  assert.equal(result.reviews.find((r) => r.agent === 'security-auditor'), undefined);
});

test('concurrency in a file with a security hit gives the auditor the stress plan; in another file it does not', () => {
  const same = report([changed('src/auth.mjs', ['const lock = acquire(f);'])]);
  assert.notEqual(reviewBy(same, 'security-auditor', 'opus', 'max').plan.stress, null);
  const apart = report([changed('src/auth.mjs', ['const a = 1;']), changed('src/b.mjs', ['const lock = acquire(f);'])]);
  assert.equal(reviewBy(apart, 'security-auditor', 'opus', 'max').plan.stress, null);
  assert.notEqual(reviewBy(apart, 'reviewer', 'opus', 'max').plan.stress, null);
});

test('concurrency alone mid-lane asks no auditor', () => {
  assert.equal(report([logicLine('const lock = acquire(f);')]).reviews.find((r) => r.agent === 'security-auditor'), undefined);
});

test('a plain regex .exec( is not security; exec next to child_process is', () => {
  assert.ok(!report([logicLine('const m = re.exec(text);')]).classes.includes('security'));
  const file = 'home/tools/x/x.mjs';
  assert.ok(report([changed(file, ['exec(cmd);'])], { newFiles: { [file]: "import { exec } from 'node:child_process';\nexec(cmd);\n" } }).classes.includes('security'));
});

test('test and doc files are not scanned for risky lines', () => {
  assert.deepEqual(report([changed('tests/a.test.mjs', ['spawnSync(x);'])]).classes, ['tests']);
});

test('a planted fake key never appears in the report', () => {
  const key = 'sk-test-PLANTEDFAKEKEY0123456789';
  const result = report([logicLine(`const apiKey = "${key}";`)]);
  assert.ok(result.classes.includes('security'));
  assert.ok(!JSON.stringify(result).includes(key));
});
