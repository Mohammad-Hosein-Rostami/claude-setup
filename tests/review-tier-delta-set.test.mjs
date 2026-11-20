// Tests for the review set of a fix round (`review-tier --delta`): it is never lighter than the lane's own review, whatever the fix
// touches and whatever flags the caller leaves out; an empty delta and a delta without the earlier round's report are errors.
// Fixtures: the two attacks of the security review (B2) and the two cases of the code review (B1) of lane r7-delta.
// The delta line and the prior file: review-tier-delta-brief.test.mjs; class and set cases without git: review-tier.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

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
  assertNotLighter(delta, round0, 'no --lane-classes, no --landing');
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
  const delta = json('--delta', reviewed, '--prior', priorFile());
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
  for (const flags of [[], ['--landing'], ['--lane-classes', laneJson(landing0)]]) {
    const delta = json('--delta', reviewed, '--prior', priorFile(), ...flags);
    assert.deepEqual(shape(delta), shape(landing0), `flags: ${flags.join(' ') || 'none'}`);
  }
  const text = tier('--delta', reviewed, '--prior', priorFile()).stdout;
  assert.doesNotMatch(text, /run: none/);
  assert.match(text, /\n {2}gate \(kept from the lane\)\n/, 'the text output says why a docs fix gets these lenses');
});

/** A previous round's JSON as a file, for `--lane-classes`. */
function laneJson(report) {
  const path = priorFile().replace(/findings-round1\.md$/, 'round0.json');
  writeFileSync(path, JSON.stringify(report));
  return path;
}

test('a class the first review got by hand (--add-class) stays: through --lane-classes, and on the fix round line the tool prints', () => {
  const { write, json, tier } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  const round0 = json('--add-class', 'concurrency');
  assert.deepEqual(round0.added, ['concurrency']);
  assert.match(tier('--add-class', 'concurrency').stdout.trimEnd().split('\n').at(-1), /^fix round: .* --delta <reviewed-sha> --prior <findings-file> --add-class concurrency$/);
  write('src/a.mjs', 'export const a = 2;\n');
  const delta = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', laneJson(round0));
  assert.ok(delta.classes.includes('concurrency'));
  assert.ok(delta.reviews.find((review) => review.model === 'opus' && review.agent === 'reviewer').plan.stress, 'the stress plan of the added class is kept');
});

test('two fix rounds: a class the first fix removed from the code stays through --lane-classes of the round before', () => {
  const { write, json } = lane();
  const reviewed = write('src/store.mjs', 'renameSync(tmp, dest);\nexport const a = 1;\n');
  const round0 = json('--landing');
  const fixed = write('src/store.mjs', 'export const a = 1;\n');
  const round1 = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', laneJson(round0));
  assert.ok(round1.classes.includes('concurrency'), 'round 1 sees the removed line');
  write('README.md', '# note\n');
  const round2 = json('--delta', fixed, '--prior', priorFile(), '--lane-classes', laneJson(round1));
  assert.ok(round2.classes.includes('concurrency'), 'round 2 keeps what the lane had');
  assert.deepEqual(round2.reviews.find((review) => review.model === 'opus' && review.agent === 'reviewer').plan.race, { runs: 200 });
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
    assert.match(result.stderr, /nothing to review: .*check the range/);
  }
});

test('an empty delta on a rebased lane (every patch already reviewed) is the same error', () => {
  const { dir, write, tier } = lane();
  const reviewed = write('src/one.mjs', 'const one = 1;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'main moved\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  const result = tier('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /nothing to review/);
});

test('--delta without --prior exits 2: a fix round always names the report of the round before', () => {
  const { write, tier } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/a.mjs', 'export const a = 2;\n');
  for (const flags of [[], ['--landing'], ['--json'], ['--lane-classes', join(priorFile(), '..', 'none.json')]]) {
    const result = tier('--delta', reviewed, ...flags);
    assert.equal(result.status, 2, flags.join(' '));
    assert.equal(result.stdout, '');
  }
  assert.match(tier('--delta', reviewed).stderr, /--delta needs --prior/);
});

test('review S4: a rebased lane gets one range: the delta line names the patches, never <old tip>..HEAD', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/two.mjs', 'const two = 2;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.mjs', 'export const landedByAnotherLane = 1;\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  const fix = write('src/three.mjs', 'const three = 3;\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, `patches ${fix.slice(0, 8)} of main..HEAD`);
  assert.equal(result.files, 1, 'only the fix: not the commit another lane landed, not the reviewed patch');
  for (const review of result.reviews) {
    assert.ok(review.brief.startsWith(`Review ${result.range}. Delta review: ${result.range} only`), review.brief);
    assert.ok(!review.brief.includes(`${reviewed}..HEAD`), 'the old tip is no second range');
  }
});

test('review N12: the brief names the resolved full sha, not the text given to --delta', () => {
  const { write, json } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/a.mjs', 'export const a = 2;\n');
  const result = json('--delta', 'HEAD~1', '--prior', priorFile());
  assert.equal(result.deltaOf, reviewed);
  assert.equal(result.range, `${reviewed}..HEAD`);
  for (const review of result.reviews) assert.doesNotMatch(review.brief, /HEAD~1/);
});

test('security N1: a rewritten lane commit whose added line moved to another place is not counted as reviewed', () => {
  const { dir, write, json } = lane();
  const before = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const reviewed = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nallowAll();\nconst verdict = decide();\n');
  git(dir, 'reset', '-q', '--hard', before);
  const moved = write('src/gate.mjs', 'allowAll();\nconst checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const note = write('NOTES.md', 'fix: note\n');
  const result = json('--delta', reviewed, '--prior', priorFile());
  assert.equal(result.range, `patches ${moved.slice(0, 8)},${note.slice(0, 8)} of main..HEAD`, 'the same added line before the checks is a new patch');
  assert.equal(result.files, 2);
});

test('a base that hides the lane is refused: --base at or past the reviewed sha, or a reviewed sha that is on the base (a first review as a delta)', () => {
  const { dir, write, tier, json } = lane();
  const start = git(dir, 'rev-parse', 'main');
  const reviewed = write('src/lock-store.mjs', 'renameSync(tmp, dest);\n');
  write('README.md', '# note\n');
  assert.ok(json('--delta', reviewed, '--prior', priorFile()).classes.includes('concurrency'), 'with the real base the lane keeps its class');
  for (const args of [['--delta', reviewed, '--base', reviewed], ['--delta', reviewed, '--base', 'HEAD'], ['--delta', 'main'], ['--delta', start]]) {
    const result = tier(...args, '--prior', priorFile(), '--json');
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout.slice(0, 200)}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no lane commit lies between the base .* and the reviewed sha/);
  }
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'lane');
  const onBase = tier('--delta', reviewed, '--prior', priorFile());
  assert.equal(onBase.status, 2, 'work on the base branch itself: the tool cannot see where the lane starts');
  assert.match(onBase.stderr, /pass --base <where the work started>/);
  assert.ok(json('--delta', reviewed, '--prior', priorFile(), '--base', start).classes.includes('concurrency'), 'with --base it works there too');
});
