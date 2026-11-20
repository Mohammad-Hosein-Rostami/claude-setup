// Tests of `--rebased-onto` (lane r7-delta, fix round 4, D7): a fix round after the fix rebased the lane onto a newer base tip starts
// from that tip only when the lane really sits on it and the tip is no commit of the reviewed lane; otherwise the start stays the old
// one, which reads more, never less. The start taken is the `base` the tool prints.
// Fixtures: the reviewer's `moved` (review R4-1: another lane lands while this one is in review) and the spec check's p5 (a base ref
// moved to a commit nobody landed). That the tip is one the build recorded itself is the workflow's check: workflow-review-start.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const EXEC_FILE = "import { execSync } from 'node:child_process';\nexport const run = (c) => execSync(c);\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";

/**
 * Review R4-1 (`moved`): a docs-only lane B reviewed at its fork; lane A (an execSync file and a hooks file) lands on main meanwhile.
 * `rebase()` is what B's fix agent then does: rebase onto the new main tip and change the docs file.
 */
function docsLaneBesideARiskyOne() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  const start = made.write('src/util.mjs', 'export const add = (a, b) => a + b;\n');
  git(made.dir, 'checkout', '-q', '-b', 'laneA');
  made.write('src/run.mjs', EXEC_FILE);
  const landed = made.write('home/hooks/a.mjs', 'export const a = 1;\n');
  git(made.dir, 'checkout', '-q', '-B', 'lane', start);
  const reviewed = made.write('docs/b.md', '# b\n');
  const round0 = made.json('--base', 'main');
  git(made.dir, 'branch', '-q', '-f', 'main', landed);
  const fixRound = (...more) => ['--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', round0.laneClasses.join(',') || 'docs', ...more];
  const rebase = () => {
    git(made.dir, 'rebase', '-q', 'main');
    return made.write('docs/b.md', '# b fixed\n');
  };
  return { ...made, start, landed, reviewed, round0, fixRound, rebase };
}

test('review R4-1 (`moved`): after another lane landed and the fix rebased onto it, --rebased-onto moves the start: a docs lane stays tier 0 with 1 file', () => {
  const { json, start, landed, round0, fixRound, rebase } = docsLaneBesideARiskyOne();
  assert.deepEqual([round0.tier, round0.files, round0.base], [0, 1, start]);
  const tip = rebase();
  const moved = json(...fixRound('--rebased-onto', landed));
  assert.deepEqual([moved.tier, moved.files, moved.base, moved.tip], [0, 1, landed, tip]);
  assert.deepEqual(Object.keys(moved.fileClasses), ['docs/b.md'], 'only the lane\'s own file is read');
  assert.equal(moved.reviews.length, 1, 'one docs lens, as in the lane\'s first review');
  assert.match(moved.range, /rewritten lane/);
  // Without the flag the start stays where round 0 put it: the landed lane is read as this lane's (more, never less).
  const kept = json(...fixRound());
  assert.deepEqual([kept.tier, kept.files, kept.base], [2, 3, start]);
  assert.deepEqual(Object.keys(kept.fileClasses).sort(), ['docs/b.md', 'home/hooks/a.mjs', 'src/run.mjs']);
  assert.equal(json(...fixRound('--rebased-onto', start)).base, start, 'the old start as the tip changes nothing');
});

test('--rebased-onto: the fix round line the tool prints carries the start it took', () => {
  const { tier, landed, fixRound, rebase } = docsLaneBesideARiskyOne();
  const tip = rebase();
  const text = tier(...fixRound('--rebased-onto', landed)).stdout;
  assert.match(text.trimEnd().split('\n').at(-1), new RegExp(`^fix round: .* --delta ${tip} --base ${landed} `));
});

test('--rebased-onto a tip the lane does not sit on leaves the start alone: the fix did not rebase', () => {
  const { json, write, start, landed, fixRound } = docsLaneBesideARiskyOne();
  write('docs/b.md', '# b fixed\n'); // a plain fix on the old base
  const report = json(...fixRound('--rebased-onto', landed));
  assert.deepEqual([report.base, report.tier, report.files], [start, 0, 1]);
  assert.doesNotMatch(report.range, /rewritten lane/);
});

test('--rebased-onto a commit of the reviewed lane, or the reviewed commit itself, leaves the start alone: a start inside the lane would hide the lane below it', () => {
  const { dir, write, json } = lane();
  const start = git(dir, 'rev-parse', 'refs/heads/main');
  const risky = write('src/run.mjs', EXEC_FILE);
  const reviewed = write('docs/b.md', '# b\n');
  write('docs/b.md', '# b fixed\n');
  const control = json('--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'docs');
  assert.deepEqual([control.tier, control.base, Object.keys(control.fileClasses).sort()], [2, start, ['docs/b.md', 'src/run.mjs']]);
  for (const onto of [risky, reviewed]) {
    const report = json('--delta', reviewed, '--base', start, '--rebased-onto', onto, '--prior', priorFile(), '--lane-classes', 'docs');
    assert.deepEqual([report.tier, report.base, Object.keys(report.fileClasses).sort()], [2, start, ['docs/b.md', 'src/run.mjs']], onto === risky ? 'a lane commit' : 'the reviewed commit');
  }
});

test('--rebased-onto a tip that does not hold the old start leaves the start alone, and a lane no longer on it is exit 2: the base was rewritten', () => {
  const { dir, write, tier } = lane();
  const root = git(dir, 'rev-parse', 'refs/heads/main');
  git(dir, 'checkout', '-q', 'main');
  const start = write('src/util.mjs', 'export const add = (a, b) => a + b;\n');
  git(dir, 'checkout', '-q', '-B', 'lane');
  const reviewed = write('src/run.mjs', EXEC_FILE);
  git(dir, 'checkout', '-q', '-B', 'side', root);
  const sibling = write('docs/other.md', '# other\n'); // not a descendant of the lane's start
  git(dir, 'checkout', '-q', '-B', 'lane', sibling);
  write('docs/b.md', '# b only\n'); // the lane rebuilt on the sibling, without its risky file
  const result = tier('--delta', reviewed, '--base', start, '--rebased-onto', sibling, '--prior', priorFile(), '--lane-classes', 'security,logic', '--json');
  assert.equal(result.status, 2, result.stdout.slice(0, 200));
  assert.ok(result.stderr.includes(`--base ${start} is no ancestor of HEAD`), result.stderr);
});

test('spec check F5 (probe p5): a base ref moved to a commit nobody landed, which drops a guard: without --rebased-onto the start stays and that commit is read', () => {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  const start = made.write('src/gate.mjs', GATE_GUARDED);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  const reviewed = made.write('docs.md', '# docs\n');
  git(made.dir, 'checkout', '-q', 'main');
  const planted = made.write('src/gate.mjs', GATE_OPEN); // the writer moves refs/heads/main onto its own commit
  git(made.dir, 'checkout', '-q', 'lane');
  git(made.dir, 'rebase', '-q', 'main');
  made.write('docs.md', '# docs fixed\n');
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'docs'];
  const kept = made.json(...fixRound);
  assert.deepEqual([kept.base, Object.keys(kept.fileClasses).sort()], [start, ['docs.md', 'src/gate.mjs']], 'the planted commit is read as the lane\'s');
  assert.ok(kept.tier >= 1 && kept.reviews.length > 1, 'with more than the docs lens');
  // The three ancestry tests hold for the planted commit too, so the tool would move the start: only the caller knows it recorded no such tip.
  assert.equal(made.json(...fixRound, '--rebased-onto', planted).base, planted);
});

test('--rebased-onto belongs to a fix round and takes a full sha', () => {
  const { tier, landed, fixRound, rebase } = docsLaneBesideARiskyOne();
  rebase();
  const alone = tier('--rebased-onto', landed);
  assert.equal(alone.status, 2);
  assert.match(alone.stderr, /--rebased-onto belongs to a --delta round/);
  for (const name of ['main', landed.slice(0, 12), 'HEAD']) {
    const result = tier(...fixRound('--rebased-onto', name));
    assert.equal(result.status, 2, name);
    assert.ok(result.stderr.includes('--rebased-onto takes the full 40-character sha of a commit in a fix round'), result.stderr);
  }
});
