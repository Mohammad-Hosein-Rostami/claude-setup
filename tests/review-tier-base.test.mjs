// Tests for where review-tier lets a lane start (the base): only the local branch `refs/heads/<name>` or a full sha, resolved once.
// A ref the fix's writer can make (a tag `main`, `refs/main`, a file `$GIT_DIR/main`, a branch `main` in a master repo) must never move
// the lane start: it made a fix round lighter than the lane's first review and hid a fix commit (lane r7-delta, security B3).
// Fixtures: the probes `a-tag-base.sh`, `b-rewrite.sh` 2 and `f-final.sh` ii of the security review, rebuilt in temp repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const EXEC_LANE = "import { execSync } from 'node:child_process';\nconst SAFE = /^[a-z]+$/;\nexport const run = (name) => (SAFE.test(name) ? execSync(`ls ${name}`) : null);\n";
const lenses = (report) => report.reviews.map(({ agent, model, effort, lens }) => `${agent} ${model} ${effort} ${lens}`);
const seen = ({ tier, classes, range, files, reviews }) => ({ tier, classes, range, files, lenses: lenses({ reviews }) });

/** A security lane (an execSync file, then docs), reviewed at its tip, with a docs fix on top: the `a-tag-base.sh` fixture. */
function securityLaneWithDocsFix() {
  const made = lane();
  const first = made.write('src/run.mjs', EXEC_LANE);
  const reviewed = made.write('README.md', '# r\nusage: run\n');
  const round0 = made.json('--landing');
  made.write('README.md', '# r\nusage: run <name>\n');
  return { ...made, first, reviewed, round0, prior: priorFile() };
}

test('security B3: a tag, refs/main or a file $GIT_DIR/main named like the base does not move the lane start of a fix round', () => {
  const { dir, json, first, reviewed, round0, prior } = securityLaneWithDocsFix();
  const control = json('--delta', reviewed, '--prior', prior);
  assert.deepEqual(lenses(control), lenses(round0), 'the control fix round has the lane landing set');
  assert.equal(lenses(control).length, 3);
  const tricks = [
    ['a tag main at the first lane commit', () => git(dir, 'tag', 'main', first), () => git(dir, 'tag', '-d', 'main')],
    ['refs/main', () => git(dir, 'update-ref', 'refs/main', first), () => git(dir, 'update-ref', '-d', 'refs/main')],
    ['a file $GIT_DIR/main', () => writeFileSync(join(dir, '.git', 'main'), `${first}\n`), () => rmSync(join(dir, '.git', 'main'))],
  ];
  for (const [name, plant, remove] of tricks) {
    plant();
    assert.equal(git(dir, 'rev-parse', 'main'), first, `${name}: plain git now reads the short name as the mid-lane commit`);
    assert.deepEqual(seen(json('--delta', reviewed, '--prior', prior)), seen(control), name);
    assert.deepEqual(seen(json('--landing')), seen(round0), `${name}: a first review with the default range`);
    remove();
  }
});

test('the default range and the delta range name the resolved base sha, never the branch name a tag could shadow', () => {
  const { dir, json, tier, reviewed, prior } = securityLaneWithDocsFix();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  assert.equal(json().range, `${base}...HEAD`);
  assert.ok(tier().stdout.split('\n')[0].endsWith(`, ${base}...HEAD`));
  for (const review of json().reviews) assert.ok(review.brief.startsWith(`Review ${base}...HEAD.`), review.brief);
  assert.equal(json('--delta', reviewed, '--prior', prior).range, `${reviewed}..HEAD`);
});

test('security B3: more than one of main, master, develop as a branch is exit 2 without --base, also for a first review', () => {
  const { dir, write, tier, json } = lane();
  git(dir, 'branch', '-m', 'main', 'master');
  const first = write('src/run.mjs', EXEC_LANE);
  const reviewed = write('README.md', '# r\nusage\n');
  const round0 = json('--landing');
  write('README.md', '# r\nusage!\n');
  const prior = priorFile();
  assert.equal(lenses(json('--delta', reviewed, '--prior', prior)).length, 3, 'the control run in a master repo');
  git(dir, 'branch', 'main', first); // what the fix's writer adds
  for (const args of [['--delta', reviewed, '--prior', prior], ['--landing'], []]) {
    const result = tier(...args, '--json');
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /more than one base branch exists here \(main, master\): name the base with --base <branch>/);
  }
  assert.deepEqual(lenses(json('--delta', reviewed, '--prior', prior, '--base', 'master')), lenses(round0), 'with the base named the set is the lane landing set');
  assert.deepEqual(seen(json('--landing', '--base', 'master')), seen(round0));
});

test('--base takes a local branch or a full sha: a tag, a remote-style name, a short sha and a revision expression are exit 2 with the cause', () => {
  const { dir, tier, json, first, reviewed, prior } = securityLaneWithDocsFix();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  git(dir, 'tag', 'v1', base);
  for (const name of ['v1', 'origin/main', base.slice(0, 12), 'main~0', 'main^{commit}', 'refs/heads/main', '-main', 'nope']) {
    const result = tier('--delta', reviewed, '--prior', prior, '--base', name);
    assert.equal(result.status, 2, name);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown base .*--base takes a local branch \(read as refs\/heads\/<name>, never a tag or another ref of that name\) or a full 40-character sha/, name);
  }
  assert.equal(json('--delta', reviewed, '--prior', prior, '--base', base).range, `${reviewed}..HEAD`, 'a full sha is a base');
  assert.equal(tier('--delta', reviewed, '--prior', prior, '--base', '0'.repeat(40)).status, 2, 'a full sha that names no commit');
  // The caller's own base is the caller's word: a mid-lane sha is accepted, and the lane's classes then come from --lane-classes.
  assert.equal(tier('--delta', reviewed, '--prior', prior, '--base', first).status, 0);
});

test('security B3: on a rewritten lane a tag at a fix commit does not take that commit out of the delta', () => {
  const { dir, write, json } = lane();
  git(dir, 'checkout', '-q', 'main');
  write('src/gate.mjs', "export function decide(cmd) {\n  return 'allow';\n}\n");
  git(dir, 'checkout', '-q', '-B', 'lane');
  write('src/gate.mjs', "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n");
  const reviewed = write('README.md', '# r\ngate: chained commands are denied\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'another lane landed\n');
  git(dir, 'checkout', '-q', 'lane');
  git(dir, 'rebase', '-q', 'main');
  const opensGate = write('src/gate.mjs', "export function decide(cmd) {\n  return 'allow';\n}\n");
  write('README.md', '# r\ngate: see src/gate.mjs\n');
  const prior = priorFile();
  const control = json('--delta', reviewed, '--prior', prior);
  assert.ok(control.range.includes(opensGate.slice(0, 8)), control.range);
  assert.ok(Object.keys(control.fileClasses).includes('src/gate.mjs'));
  git(dir, 'tag', 'main', opensGate);
  assert.deepEqual(seen(json('--delta', reviewed, '--prior', prior)), seen(control), 'the commit that removes the guard is still read');
});
