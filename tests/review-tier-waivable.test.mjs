// Tests for `waivable` (lib/reviews.mjs buildWaivable): what a tier-1, non-gate landing may run before land and after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatText } from '../home/tools/review-tier/lib/report.mjs';

const changed = (path, added = []) => ({ path, added: added.map((text, index) => ({ line: index + 1, text })), removed: [] });
const RANGE = 'abc1234^..abc1234';

const report = (files, options = {}) => buildReport({
  files, readNewFile: () => null, landing: true, addClasses: [], laneClasses: null, range: RANGE, deltaOf: null, requiredReading: [], ...options,
});
const logic = () => [changed('src/a.mjs', ['const total = a + b;'])];

test('a tier-1 logic landing is waivable: Sonnet high with the mutation plan now, the Opus max pair after land', () => {
  const { waivable } = report(logic());
  assert.deepEqual(waivable.reviews.map((r) => [r.agent, r.model, r.effort, r.lens]), [['reviewer', 'sonnet', 'high', 'correctness']]);
  assert.deepEqual(waivable.reviews[0].plan, { stress: null, race: null, mutation: { maxMutants: 1 } });
  assert.deepEqual(waivable.audit.map((r) => [r.agent, r.model, r.effort, r.lens]), [
    ['reviewer', 'opus', 'max', 'risk: landing'], ['security-auditor', 'opus', 'max', 'audit: landing'],
  ]);
  for (const review of [...waivable.reviews, ...waivable.audit]) assert.match(review.brief, new RegExp(RANGE.replace(/\^/g, '\\^')));
});

test('the waivable audit pair is the pair `reviews` already holds for a landing', () => {
  const result = report(logic());
  assert.deepEqual(waivable(result).audit, result.reviews.filter((r) => r.lens === 'risk: landing' || r.lens === 'audit: landing'));
});
function waivable(result) { return result.waivable; }

test('no mutation plan when the diff has no code (tests only)', () => {
  const { waivable: waive } = report([changed('tests/a.test.mjs', ['x'])]);
  assert.deepEqual(waive.reviews[0].plan.mutation, null);
});

test('a ui diff adds the ui-quality-pass skill lens to the reviews, not to the audit', () => {
  const { waivable: waive } = report([changed('src/Button.tsx', ['const a = 1;'])]);
  assert.deepEqual(waive.reviews.map((r) => r.agent), ['reviewer', 'skill']);
  assert.ok(!waive.audit.some((r) => r.agent === 'skill'));
});

test('null when not landing', () => assert.equal(report(logic(), { landing: false }).waivable, null));

test('null for tier 0 (docs only)', () => assert.equal(report([changed('docs/x.md', ['x'])]).waivable, null));

test('null for tier 2 and above: a security, data, untrusted-input or concurrency line, or a size class', () => {
  for (const line of ['spawnSync(cmd);', 'rmSync(dir);', 'const b = req.body;', 'readFileSync(p);', 'renameSync(a, b);']) {
    assert.equal(report([changed('src/a.mjs', [line])]).waivable, null, line);
  }
  assert.equal(report([changed('src/a.mjs', Array.from({ length: 401 }, (_, i) => `const v${i} = ${i};`))]).waivable, null);
});

test('null for a gate path, even a docs file or a tier-1 line', () => {
  for (const path of ['package.json', 'home/tools/review-tier/README.md', '.githooks/pre-push', 'home/rules/core.md']) {
    assert.equal(report([changed(path, ['const a = 1;'])]).waivable, null, path);
  }
});

test('null when one file of a mixed diff is gate or risky', () => {
  assert.equal(report([...logic(), changed('package.json', ['x'])]).waivable, null);
  assert.equal(report([...logic(), changed('src/b.mjs', ['spawnSync(c);'])]).waivable, null);
});

test('--add-class raising the tier or adding gate removes the waiver', () => {
  assert.equal(report(logic(), { addClasses: ['security'] }).waivable, null);
  assert.equal(report(logic(), { addClasses: ['gate'] }).waivable, null);
});

test('the text report has a waivable, a weakened and a principles line', () => {
  const lines = formatText(report(logic())).split('\n');
  assert.ok(lines.some((line) => /^waivable: yes/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^weakened: none$/.test(line)));
  assert.ok(lines.some((line) => /^principles: none$/.test(line)));
  const gate = formatText(report([changed('package.json', ['x'])])).split('\n');
  assert.ok(gate.some((line) => /^waivable: no/.test(line)));
  assert.ok(gate.some((line) => /^principles: P3$/.test(line)));
  const weak = formatText(report([changed('tests/a.test.mjs', ["test.only('a', f);"])])).split('\n');
  assert.ok(weak.some((line) => /^weakened: tests\/a\.test\.mjs:1 only$/.test(line)));
});
