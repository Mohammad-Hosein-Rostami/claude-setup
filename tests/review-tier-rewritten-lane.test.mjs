// Tests for a fix round on a rewritten lane (`review-tier --delta` with a reviewed sha that is no ancestor of HEAD): a plain rebase
// reads only the fresh patches, but a lane that dropped or changed a reviewed patch reads the whole lane and what the rewrite took
// out, with the lane's set, and says so (lane r7-delta, security B4: a lane rebuilt without its guard commit showed a docs-only delta).
// Fixture: probe `b-rewrite.sh` 1 of the security review, rebuilt in temp repos. The base and ref tricks: review-tier-base.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { DELTA_READING } from '../home/tools/review-tier/lib/reviews.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const lenses = (report) => report.reviews.map(({ agent, model, effort }) => `${agent} ${model} ${effort}`);

/** A lane on a base that holds an open gate: commit 1 adds the guard, commit 2 (the reviewed tip) is docs. */
function guardLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('src/gate.mjs', GATE_OPEN);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  const guard = made.write('src/gate.mjs', GATE_GUARDED);
  const reviewed = made.write('README.md', '# r\ngate: chained commands are denied\n');
  return { ...made, guard, reviewed, round0: made.json('--landing'), base: git(made.dir, 'rev-parse', 'main') };
}

test('security B4: a lane rebuilt without its reviewed guard commit names the guard file, keeps the three lenses and says the lane was rewritten', () => {
  const { dir, write, json, tier, reviewed, round0, base } = guardLane();
  assert.deepEqual(lenses(round0), ['reviewer sonnet high', 'reviewer opus max', 'security-auditor opus max']);
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'cherry-pick', reviewed);
  write('README.md', '# r\ngate: chained commands are denied (see src/gate.mjs)\n');
  assert.match(git(dir, 'diff', '--stat', reviewed, 'HEAD'), /src\/gate\.mjs/, 'the rewrite deleted the guard');
  const prior = priorFile();
  const result = json('--delta', reviewed, '--prior', prior);
  assert.equal(result.range, `${base}...HEAD (rewritten lane: 1 reviewed patch is gone or changed)`);
  assert.deepEqual(lenses(result), lenses(round0), 'never one Sonnet lens for a docs-only look');
  assert.deepEqual(result.fileClasses['src/gate.mjs'], ['logic'], 'the guard file is in the round although no lane commit touches it now');
  assert.equal(result.files, 2);
  const rangeDiff = `the output of \`git range-diff ${base}..${reviewed} ${base}..HEAD\` (what the rewrite dropped or changed)`;
  for (const review of result.reviews) {
    assert.equal(review.requiredReading[0], rangeDiff);
    assert.ok(review.brief.startsWith(`Review ${result.range}. Delta review: ${result.range} only. `), review.brief);
    assert.ok(review.brief.includes(DELTA_READING) && review.brief.includes(rangeDiff), review.brief);
  }
  assert.match(DELTA_READING, /on a rewritten lane, what the rewrite dropped or changed \(the brief names the `git range-diff` to read\)/);
  const text = tier('--delta', reviewed, '--prior', prior).stdout;
  assert.match(text.split('\n')[0], /rewritten lane: 1 reviewed patch is gone or changed\)$/);
  assert.match(text, /\(what the rewrite dropped or changed\), src\/gate\.mjs:1\./, 'Read first names the range-diff, then the place the guard was taken out');
});

test('security B4: a reviewed commit that was changed in the rewrite (amended) is read again with the whole lane, and two gone patches are counted', () => {
  const { dir, write, json, guard, reviewed, base } = guardLane();
  git(dir, 'reset', '-q', '--hard', 'main');
  write('src/gate.mjs', GATE_GUARDED.replace("';'", "'&&'"));
  write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, `${base}...HEAD (rewritten lane: 2 reviewed patches are gone or changed)`, `${guard} was changed, the docs commit dropped`);
  assert.deepEqual(Object.keys(result.fileClasses).sort(), ['NOTES.md', 'README.md', 'src/gate.mjs']);
  assert.equal(lenses(result).length, 3);
});

test('a test the rewrite dropped is listed as a weakened check', () => {
  const { dir, write, json } = lane();
  write('tests/gate.test.mjs', "import test from 'node:test';\ntest('denies chains', () => { assert.equal(decide(';'), 'deny'); });\n");
  const reviewed = write('src/gate.mjs', GATE_GUARDED);
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'cherry-pick', reviewed);
  write('NOTES.md', 'fix: note\n');
  const { weakened } = json('--delta', reviewed, '--prior', priorFile());
  assert.deepEqual(weakened.map(({ path, kind }) => `${path} ${kind}`), ['tests/gate.test.mjs removed-test', 'tests/gate.test.mjs removed-assert']);
});

test('a dropped commit with no hunk (a gate file renamed away) still brings its paths and the gate class into the round', () => {
  const { dir, write, json } = lane();
  git(dir, 'checkout', '-q', 'main');
  write('settings/base.json', '{ "permissions": { "deny": ["Bash(rm:*)"] } }\n');
  git(dir, 'checkout', '-q', '-B', 'lane');
  git(dir, 'mv', 'settings/base.json', 'settings/base.json.off');
  git(dir, 'commit', '-q', '-m', 'park the settings');
  const reviewed = write('README.md', '# r\n');
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'cherry-pick', reviewed);
  write('README.md', '# r\nfixed\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.deepEqual(result.fileClasses['settings/base.json'], ['logic', 'gate']);
  assert.ok(result.classes.includes('gate'));
});

test('a plain rebase keeps every reviewed patch: the round reads only the fresh patches and names no rewrite', () => {
  const { dir, write, json, reviewed, base } = guardLane();
  git(dir, 'checkout', '-q', 'main');
  const moved = write('other.txt', 'another lane landed\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  const fix = write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.notEqual(moved, base);
  assert.equal(result.range, `patches ${fix.slice(0, 8)} of ${moved}..HEAD`);
  assert.equal(result.files, 1);
  assert.ok(result.reviews.every((review) => !review.requiredReading.some((entry) => entry.includes('range-diff'))));
});

test('review N7 (mutant R8): a reviewed commit amended to change only indentation is a changed patch, so its file is read again', () => {
  const { dir, write, json } = lane();
  const reviewed = write('config/deploy.yaml', 'steps:\n  - run: test\n  - run: deploy\n');
  git(dir, 'reset', '-q', '--hard', 'main');
  write('config/deploy.yaml', 'steps:\n  - run: test\n    - run: deploy\n');
  write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.match(result.range, /rewritten lane: 1 reviewed patch is gone or changed/, 'a patch key is verbatim: whitespace counts');
  assert.ok(result.fileClasses['config/deploy.yaml'], 'the re-indented file is in the round');
  assert.equal(result.files, 2);
});
