// Tests for a fix round on a rewritten lane (`review-tier --delta` with a reviewed sha that is no ancestor of HEAD): the lane is always
// read whole, by tree diffs only (`<base>..HEAD`, plus what changed in the lane's files since the reviewed commit), with the lane's
// set, and the round says so. No commit is matched to a reviewed one: a rebuilt lane that kept every reviewed patch and dropped the
// guard in a merge, or by replaying fewer of two equal patches, showed a docs-only delta (lane r7-delta, security B4 and B5).
// Fixtures: probes `b-rewrite.sh` 1, p1 (i) and p2 (ii) of the security reviews, rebuilt in temp repos. Base and ref tricks:
// review-tier-base.test.mjs; grafts, replace refs and shallow history: review-tier-git-state.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { DELTA_READING } from '../home/tools/review-tier/lib/reviews.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const THREE_LENSES = ['reviewer sonnet high', 'reviewer opus max', 'security-auditor opus max'];
const lenses = (report) => report.reviews.map(({ agent, model, effort }) => `${agent} ${model} ${effort}`);
const rewrittenRange = (base, reviewed) => `${base}..HEAD (rewritten lane: the reviewed commit ${reviewed} is no ancestor of HEAD, so the whole lane is read)`;

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

/** Asserts a fix round that names the guard file as changed, with the lane's three lenses, and tells every reviewer where to look. */
function assertGuardIsRead(result, round0, label) {
  assert.deepEqual(lenses(result), THREE_LENSES, `${label}: never one Sonnet lens for a docs-only look`);
  assert.deepEqual(lenses(result), lenses(round0), label);
  assert.deepEqual(result.fileClasses['src/gate.mjs'], ['logic'], `${label}: the guard file is in the round although the lane no longer changes it`);
  assert.equal(result.files, 2, `${label}: the guard file and the docs`);
  for (const review of result.reviews) assert.ok(review.requiredReading.filter((entry) => entry === 'src/gate.mjs:1').length === 1, `${label}: Read first names the place the guard was taken from, once`);
}

test('security B4: a lane rebuilt without its reviewed guard commit names the guard file, keeps the three lenses and says the lane was rewritten', () => {
  const { dir, write, json, tier, reviewed, round0, base } = guardLane();
  assert.deepEqual(lenses(round0), THREE_LENSES);
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'cherry-pick', reviewed);
  write('README.md', '# r\ngate: chained commands are denied (see src/gate.mjs)\n');
  assert.match(git(dir, 'diff', '--stat', reviewed, 'HEAD'), /src\/gate\.mjs/, 'the rewrite deleted the guard');
  const prior = priorFile();
  const result = json('--delta', reviewed, '--prior', prior);
  assert.equal(result.range, rewrittenRange(base, reviewed));
  assertGuardIsRead(result, round0, 'a dropped commit');
  const rangeDiff = `the output of \`git range-diff ${base}..${reviewed} ${base}..HEAD\` (what the rewrite changed, commit by commit)`;
  const sinceReviewed = `the output of \`git diff ${reviewed} HEAD\` for the lane's files (what the rewrite changed in them, line by line; the places named next are where each of those files first differs)`;
  for (const review of result.reviews) {
    assert.deepEqual(review.requiredReading.slice(0, 2), [rangeDiff, sinceReviewed]);
    assert.ok(review.brief.startsWith(`Review ${result.range}. Delta review: ${result.range} only. `), review.brief);
    assert.ok(review.brief.includes(DELTA_READING) && review.brief.includes(rangeDiff) && review.brief.includes(sinceReviewed), review.brief);
  }
  assert.match(DELTA_READING, /on a rewritten lane, what the rewrite dropped or changed \(the brief names the `git range-diff` to read\)/);
  const text = tier('--delta', reviewed, '--prior', prior).stdout;
  assert.ok(text.split('\n')[0].endsWith(`, ${rewrittenRange(base, reviewed)}`), text.split('\n')[0]);
});

test('security B5 (probe p1 i): a lane rebuilt with every reviewed patch plus a merge whose resolution drops the guard names the guard file and keeps three lenses', () => {
  const { dir, write, json, guard, reviewed, round0 } = guardLane();
  git(dir, 'checkout', '-q', 'main');
  const base = write('other.txt', 'another lane landed\n'); // the lane is rebuilt on the moved base, so every commit is a new one
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'cherry-pick', guard);
  git(dir, 'cherry-pick', reviewed);
  git(dir, 'checkout', '-q', '-b', 'side', 'main');
  write('side.txt', 'a side branch\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  git(dir, 'rm', '-q', '-f', 'side.txt');
  write('src/gate.mjs', GATE_OPEN); // the merge commit itself takes the guard out: no commit's own patch shows it
  write('README.md', '# r\ngate: chained commands are denied (see src/gate.mjs)\n');
  assert.equal(git(dir, 'rev-list', '--count', '--merges', `${base}..HEAD`), '1');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, rewrittenRange(base, reviewed));
  assertGuardIsRead(result, round0, 'a merge that drops the guard');
});

test('security B5 (probe p2 ii): a lane that held the guard patch twice and is rebuilt with it once, then reverted, names the guard file and keeps three lenses', () => {
  const { dir, write, json, guard, round0, base } = guardLane();
  git(dir, 'reset', '-q', '--hard', guard);
  git(dir, 'revert', '--no-edit', 'HEAD');
  const revert = git(dir, 'rev-parse', 'HEAD');
  write('src/gate.mjs', GATE_GUARDED); // the same patch as the guard commit, a second time
  const docs = 'README.md';
  const reviewed = write(docs, '# r\ngate: chained commands are denied\n');
  git(dir, 'reset', '-q', '--hard', 'main');
  for (const commit of [guard, revert, reviewed]) git(dir, 'cherry-pick', commit);
  write(docs, '# r\ngate: chained commands are denied (see src/gate.mjs)\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, rewrittenRange(base, reviewed));
  assertGuardIsRead(result, round0, 'one of two equal patches dropped');
});

test('a reviewed commit that was changed in the rewrite (amended) is read with the whole lane, and so is a file only the old lane had', () => {
  const { dir, write, json, reviewed, base } = guardLane();
  git(dir, 'reset', '-q', '--hard', 'main');
  write('src/gate.mjs', GATE_GUARDED.replace("';'", "'&&'"));
  write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, rewrittenRange(base, reviewed));
  assert.deepEqual(Object.keys(result.fileClasses).sort(), ['NOTES.md', 'README.md', 'src/gate.mjs'], 'README.md was dropped with the docs commit');
  assert.equal(result.files, 3);
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

test('a plain rebase is a rewritten lane too: the whole lane is read, never only the commits that look new, and not what landed on the base', () => {
  const { dir, write, json, reviewed, round0, base } = guardLane();
  git(dir, 'checkout', '-q', 'main');
  const moved = write('other.txt', 'another lane landed\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.notEqual(moved, base);
  assert.equal(result.range, rewrittenRange(moved, reviewed));
  assert.deepEqual(Object.keys(result.fileClasses).sort(), ['NOTES.md', 'README.md', 'src/gate.mjs'], 'other.txt belongs to the base');
  assert.equal(result.files, 3);
  assert.deepEqual(lenses(result), lenses(round0));
  assert.ok(result.reviews.every((review) => review.requiredReading[0].includes(`git range-diff ${moved}..${reviewed} ${moved}..HEAD`)));
});
