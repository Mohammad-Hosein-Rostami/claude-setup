// Tests for the review set of a fix round (`review-tier --delta`): it is never lighter than the lane's own review, whatever the fix
// touches and whatever flags the caller leaves out; an empty delta and a delta without the earlier round's report are errors.
// Fixtures: the two attacks of the security review (B2) and the two cases of the code review (B1) of lane r7-delta.
// The delta line and the prior file: review-tier-delta-brief.test.mjs; class and set cases without git: review-tier.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { lane, laneNamesOf, priorFile } from './review-tier-helpers.mjs';

const OPUS_MAX_PAIR = [['reviewer', 'opus', 'max'], ['security-auditor', 'opus', 'max']];
const strength = (report) => report.reviews.map(({ agent, model, effort }) => [agent, model, effort]);
const shape = (report) => report.reviews.map(({ agent, model, effort, lens, rules }) => ({ agent, model, effort, lens, rules }));
const hasMember = (report, member) => strength(report).some((entry) => entry.join(' ') === member.join(' '));

/** Asserts the fix round's set holds every member (agent, model, effort) the lane's review had. */
function assertNotLighter(delta, laneReview, label) {
  for (const member of strength(laneReview)) assert.ok(hasMember(delta, member), `${label}: the fix round lost ${member.join(' ')} (it has ${JSON.stringify(strength(delta))})`);
}

test('security B2, attack 1: a fix that widens the guard of an execSync lane keeps the Opus max lens and the auditor with the plain command', () => {
  const { write, json } = lane();
  const reviewed = write('src/run.mjs', "import { execSync } from 'node:child_process';\nconst SAFE = /^[a-z]+$/;\nexport const run = (cmd) => (SAFE.test(cmd) ? execSync(cmd) : null);\n");
  const round0 = json();
  assert.deepEqual(strength(round0), [['reviewer', 'sonnet', 'high'], ...OPUS_MAX_PAIR], 'the lane review: Sonnet, Opus max risk lens, auditor Opus max');
  write('src/run.mjs', "import { execSync } from 'node:child_process';\nconst SAFE = /^[a-z./ ;$()]+$/;\nexport const run = (cmd) => (SAFE.test(cmd) ? execSync(cmd) : null);\n");
  const delta = json('--delta', reviewed, '--prior', priorFile());
  assertNotLighter(delta, round0, 'an empty --lane-classes, no --landing');
  assert.ok(delta.classes.includes('security'), `classes ${delta.classes}`);
  assert.equal(delta.files, 1, 'the files and lines are still only the fix');
});

test('security B2, attack 2: a fix that opens settings/base.json gets the Opus max pair without --landing', () => {
  const { write, json } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('settings/base.json', '{ "permissions": { "allow": ["Bash(*)"], "deny": [] } }\n');
  const delta = json('--delta', reviewed, '--prior', priorFile());
  for (const member of OPUS_MAX_PAIR) assert.ok(hasMember(delta, member), `missing ${member.join(' ')}: ${JSON.stringify(strength(delta))}`);
  assert.ok(delta.classes.includes('gate'));
});

test('review B1, case 1: a fix that touches only a logic file of a security lane keeps the set, the rules and the mutation plan', () => {
  const { write, json } = lane();
  write('src/auth.mjs', 'export const check = (user) => user.token === expected;\n');
  const reviewed = write('src/util.mjs', 'export const twice = (n) => n * 2;\n');
  const round0 = json();
  const landing0 = json('--landing');
  write('src/util.mjs', 'export const twice = (n) => n + n;\n');
  const delta = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', 'logic');
  assertNotLighter(delta, round0, 'against the mid-lane review');
  assert.deepEqual(shape(delta), shape(landing0), 'the same lenses, models, efforts and rules as the lane landing review');
  for (const review of delta.reviews.filter((entry) => entry.model === 'opus')) assert.ok(review.plan.mutation.maxMutants > 0, `${review.lens} keeps a mutation plan`);
  assert.deepEqual(delta.fileClasses['src/auth.mjs'], round0.fileClasses['src/auth.mjs'], 'the untouched security file keeps its classes');
  assert.deepEqual(delta.kept, ['security'], 'the report says which classes come from the lane, not from the fix');
});

test('review B1, case 2: a docs-only fix of a gate lane gets the lane landing set, never "run: none" or one Sonnet lens', () => {
  const { write, json, tier } = lane();
  const reviewed = write('home/rules/core.md', '# rules\nC1 | keep it simple | rev\n');
  const landing0 = json('--landing');
  for (const member of OPUS_MAX_PAIR) assert.ok(hasMember(landing0, member), 'the gate lane lands with the Opus max pair');
  write('README.md', '# readme\nfixed a typo\n');
  for (const flags of [[], ['--landing'], ['--lane-classes', laneNamesOf(landing0)]]) {
    const delta = json('--delta', reviewed, '--prior', priorFile(), ...flags);
    assert.deepEqual(shape(delta), shape(landing0), `flags: ${flags.join(' ') || 'none'}`);
  }
  const text = tier('--delta', reviewed, '--prior', priorFile()).stdout;
  assert.doesNotMatch(text, /run: none/);
  assert.match(text, /\n {2}gate \(kept from the lane\)\n/, 'the text output says why a docs fix gets these lenses');
});

test('review B1b: a docs-only or tests-only fix keeps the mutation plan of the lane, on a gate lane and on a plain logic lane', () => {
  for (const [name, lanePath] of [['gate', 'home/tools/test-pass/lib.mjs'], ['logic', 'src/total.mjs']]) {
    for (const [kind, fixPath, fixText] of [['docs', 'README.md', '# fixed a typo\n'], ['tests', 'tests/total.test.mjs', "test('adds', () => {});\n"]]) {
      const { write, json, tier } = lane();
      const reviewed = write(lanePath, 'export const total = (a, b) => a + b;\nexport const twice = (n) => total(n, n);\n');
      const landing0 = json('--landing');
      const planned = landing0.reviews.filter((review) => review.model === 'opus');
      assert.equal(planned.length, 2, `${name}: the lane lands with the Opus max pair`);
      for (const review of planned) assert.deepEqual(review.plan.mutation, { maxMutants: 2 }, `${name}: round 0 asks for mutants`);
      write(fixPath, fixText);
      const delta = json('--delta', reviewed, '--prior', priorFile());
      assertNotLighter(delta, landing0, `${name} lane, ${kind} fix`);
      assert.deepEqual(delta.reviews.map((review) => review.lens), landing0.reviews.map((review) => review.lens));
      for (const review of delta.reviews.filter((entry) => entry.model === 'opus')) {
        assert.deepEqual(review.plan.mutation, { maxMutants: 3 }, `${name} lane, ${kind} fix: ${review.lens} plans by the lane's 3 changed lines, not the fix's 1`);
        assert.match(review.brief, /PLAN: mutants: every id in the prior file's mutants block, plus \d+ over the fix's changed lines\./, `${name} lane, ${kind} fix`);
        assert.ok(review.brief.includes("The set, models, efforts and PLAN items are the lane's. A round-0 mutation plan counts the lane's changed lines; a delta round re-runs the prior mutants block plus mutants of the fix's lines. Nothing else is skipped."), 'the brief says what it keeps (mutant R12)');
      }
      assert.match(tier('--delta', reviewed, '--prior', priorFile()).stdout, /PLAN: mutants: every id in the prior file/);
      assert.deepEqual([delta.files, delta.changedLines], [1, 1], 'files and lines stay the fix\'s');
    }
  }
});

test('review B1b: a fix that removes the lane\'s only code file still gets a mutation plan sized by the lines it removes', () => {
  const { dir, write, json } = lane();
  write('README.md', '# readme\n');
  const reviewed = write('src/total.mjs', 'export const total = (a, b) => a + b;\nexport const twice = (n) => total(n, n);\nexport const zero = 0;\n');
  git(dir, 'rm', '-q', 'src/total.mjs');
  git(dir, 'commit', '-q', '-m', 'drop it');
  const delta = json('--delta', reviewed, '--prior', priorFile());
  assert.deepEqual(delta.reviews.find((review) => review.model === 'opus').plan.mutation, { maxMutants: 3 }, 'the lane range now holds one README line only');
});

test('a docs-only lane with a docs-only fix asks for no mutants: there is no code to mutate', () => {
  const { write, json } = lane();
  const reviewed = write('README.md', '# readme\n');
  write('README.md', '# readme\nfixed\n');
  for (const review of json('--delta', reviewed, '--prior', priorFile()).reviews) assert.equal(review.plan.mutation, null);
});

test('a class the first review got by hand (--add-class) stays: through --lane-classes, and on the fix round line the tool prints', () => {
  const { write, json, tier } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  const round0 = json('--add-class', 'concurrency');
  assert.deepEqual(round0.added, ['concurrency']);
  assert.match(tier('--add-class', 'concurrency').stdout.trimEnd().split('\n').at(-1), /^fix round: .* --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes concurrency,logic$/);
  write('src/a.mjs', 'export const a = 2;\n');
  const delta = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', laneNamesOf(round0));
  assert.ok(delta.classes.includes('concurrency'));
  assert.ok(delta.reviews.find((review) => review.model === 'opus' && review.agent === 'reviewer').plan.stress, 'the stress plan of the added class is kept');
});

test('two fix rounds: a class the first fix removed from the code stays through --lane-classes of the round before', () => {
  const { write, json } = lane();
  const reviewed = write('src/store.mjs', 'renameSync(tmp, dest);\nexport const a = 1;\n');
  const round0 = json('--landing');
  const fixed = write('src/store.mjs', 'export const a = 1;\n');
  const round1 = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', laneNamesOf(round0));
  assert.ok(round1.classes.includes('concurrency'), 'round 1 sees the removed line');
  write('README.md', '# note\n');
  const round2 = json('--delta', fixed, '--prior', priorFile(), '--lane-classes', laneNamesOf(round1));
  assert.ok(round2.classes.includes('concurrency'), 'round 2 keeps what the lane had');
  const { plan } = round2.reviews.find((review) => review.model === 'opus' && review.agent === 'reviewer');
  assert.deepEqual(plan.race, { runs: 200 });
  // What the tag among the names is for (mutant R5): the kind of the removed line (lock-free) rides in it, so the plan stays a race
  // check. The class names alone would ask for both kinds, and a stale-lock stress run means nothing for a rename.
  assert.equal(plan.stress, null);
  for (const report of [round0, round1, round2]) assert.ok(['concurrency', 'lock-free'].every((name) => laneNamesOf(report).split(',').includes(name)), `every round hands the class and its tag on: ${laneNamesOf(report)}`);
});

test('a fix round is never waivable: the waiver belongs to the first review of the whole range', () => {
  const { write, json, tier } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  assert.notEqual(json('--landing').waivable, null, 'the lane itself is a tier-1 landing with no gate path');
  write('src/a.mjs', 'export const a = 2;\n');
  for (const flags of [[], ['--landing']]) {
    assert.equal(json('--delta', reviewed, '--prior', priorFile(), ...flags).waivable, null, `flags: ${flags}`);
    assert.match(tier('--delta', reviewed, '--prior', priorFile(), ...flags).stdout, /\nwaivable: no\n/);
  }
});

test('security S2: an empty delta is an error, never a pass: exit 2, nothing on stdout, with and without --landing', () => {
  const { write, tier } = lane();
  write('src/a.mjs', 'export const a = 1;\n');
  const tip = write('src/a.mjs', 'export const a = 2;\n');
  for (const flags of [[], ['--landing'], ['--json']]) {
    const result = tier('--delta', tip, '--prior', priorFile(), ...flags);
    assert.equal(result.status, 2, `flags ${flags}: ${result.stdout}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /nothing to review: [0-9a-f]{40}\.\.HEAD holds no changed file; check the shas/);
  }
});

test('a rebased lane with no fix on top is no empty delta: the whole lane is read again', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/one.mjs', 'const one = 1;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'main moved\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  // review R3-3: also in a repo whose diff.context is above 3, where the patch-key rule found every patch reviewed and exited 2.
  for (const context of [null, '5']) {
    if (context !== null) git(dir, 'config', 'diff.context', context);
    const result = json('--delta', reviewed, '--prior', priorFile());
    assert.match(result.range, /^[0-9a-f]{40}\.\.HEAD \(rewritten lane: /, `diff.context ${context}`);
    assert.deepEqual(Object.keys(result.fileClasses), ['src/one.mjs']);
  }
});

test('--delta without --prior exits 2: a fix round always names the report of the round before', () => {
  const { write, tier } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/a.mjs', 'export const a = 2;\n');
  for (const flags of [[], ['--landing'], ['--json'], ['--lane-classes', 'logic']]) {
    const result = tier('--delta', reviewed, ...flags);
    assert.equal(result.status, 2, flags.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.match(tier('--delta', reviewed).stderr, /--delta needs --prior/);
});

test('review S4: a rebased lane gets one range: the delta line names the whole lane, never <old tip>..HEAD', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/two.mjs', 'const two = 2;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.mjs', 'export const landedByAnotherLane = 1;\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  write('src/three.mjs', 'const three = 3;\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.ok(result.range.startsWith(`${git(dir, 'rev-parse', 'main')}..HEAD (rewritten lane: `), result.range);
  assert.equal(result.files, 2, 'the lane: not the commit another lane landed');
  for (const review of result.reviews) {
    assert.ok(review.brief.startsWith(`Review ${result.range}. Delta review: ${result.range} only`), review.brief);
    assert.ok(!review.brief.includes(`${reviewed}..HEAD`), 'the old tip is no second range');
  }
});

test('security N1: a rewritten lane commit whose added line moved to another place is read again with the whole lane', () => {
  const { dir, write, json } = lane();
  const before = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const reviewed = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nallowAll();\nconst verdict = decide();\n');
  git(dir, 'reset', '-q', '--hard', before);
  const moved = write('src/gate.mjs', 'allowAll();\nconst checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const note = write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  // No commit of a rewritten lane counts as reviewed: the whole lane is read, so where the line now stands is in front of the reviewer.
  assert.equal(result.range, `${git(dir, 'rev-parse', 'main')}..HEAD (rewritten lane: the reviewed commit ${reviewed} is no ancestor of HEAD, so the whole lane is read)`);
  assert.equal(result.files, 2);
  assert.ok(result.fileClasses['src/gate.mjs'] && result.fileClasses['NOTES.md'], `${moved} and ${note} are both read`);
});

test('a base that hides the lane is refused: --base at or past the reviewed sha, or a reviewed sha that is on the base (a first review as a delta)', () => {
  const { dir, write, tier, json } = lane();
  const start = git(dir, 'rev-parse', 'main');
  const reviewed = write('src/lock-store.mjs', 'renameSync(tmp, dest);\n');
  write('README.md', '# note\n');
  assert.ok(json('--delta', reviewed, '--prior', priorFile()).classes.includes('concurrency'), 'with the real base the lane keeps its class');
  for (const args of [['--delta', reviewed, '--base', reviewed], ['--delta', reviewed, '--base', git(dir, 'rev-parse', 'HEAD')], ['--delta', start, '--base', start]]) {
    const result = tier(...args, '--prior', priorFile(), '--json');
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout.slice(0, 200)}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no lane commit lies between the base .* and the reviewed sha/);
  }
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'lane');
  const onBase = tier('--delta', reviewed, '--prior', priorFile());
  assert.equal(onBase.status, 2, 'work on the base branch itself: the tool cannot see where the lane starts');
  assert.match(onBase.stderr, /pass --base <the full sha where the work started>/);
  assert.ok(json('--delta', reviewed, '--prior', priorFile(), '--base', start).classes.includes('concurrency'), 'with --base it works there too');
});
