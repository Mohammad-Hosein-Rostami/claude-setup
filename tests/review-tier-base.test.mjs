// Tests for where review-tier lets a lane start (the base): only the local branch `refs/heads/<name>` or a full sha, resolved once.
// A ref the fix's writer can make (a tag `main`, `refs/main`, a file `$GIT_DIR/main`, a branch `main` in a master repo) must never move
// the lane start: it made a fix round lighter than the lane's first review and hid a fix commit (lane r7-delta, security B3).
// A fix round reads no name at all: `--base` and `--delta` are full shas from the lead's record (security B7 of the third review).
// Fixtures: the probes `a-tag-base.sh`, `b-rewrite.sh` 2, `f-final.sh` ii, p3 (a, c), p4 and p5 of the security reviews, rebuilt in temp repos.
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

test('security B3: more than one of main, master, develop as a branch is exit 2 without --base for a first review; a fix round reads no branch at all', () => {
  const { dir, write, tier, json } = lane();
  git(dir, 'branch', '-m', 'main', 'master');
  const start = git(dir, 'rev-parse', 'refs/heads/master');
  const first = write('src/run.mjs', EXEC_LANE);
  const reviewed = write('README.md', '# r\nusage\n');
  const round0 = json('--landing');
  write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', priorFile()];
  const control = json(...fixRound);
  assert.deepEqual(lenses(control), lenses(round0), 'the control fix round in a master repo has the lane landing set');
  git(dir, 'branch', 'main', first); // what the fix's writer adds
  for (const args of [['--landing'], []]) {
    const result = tier(...args, '--json');
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /more than one base branch exists here \(main, master\): name the base with --base <branch>/);
  }
  assert.deepEqual(seen(json(...fixRound)), seen(control), 'the fix round takes its base as a sha: the new branch changes nothing');
  assert.deepEqual(seen(json('--landing', '--base', 'master')), seen(round0));
});

test('--base of a first review takes a local branch or a full sha: a tag, a remote-style name, a short sha and a revision expression are exit 2 with the cause', () => {
  const { dir, tier, json, round0 } = securityLaneWithDocsFix();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  git(dir, 'tag', 'v1', base);
  for (const name of ['v1', 'origin/main', base.slice(0, 12), 'main~0', 'main^{commit}', '-main', 'nope', '0'.repeat(40)]) {
    const result = tier('--landing', '--base', name);
    assert.equal(result.status, 2, name);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown base .*--base takes a local branch \(read as refs\/heads\/<name>, never a tag or another ref of that name\) or a full 40-character sha/, name);
  }
  assert.deepEqual(seen(json('--landing', '--base', base)), seen(round0), 'a full sha is a base');
});

test('security B7: in a fix round --base and --delta take only a full sha: a branch, a tag, a short sha, HEAD and an expression are exit 2 with what to pass', () => {
  const { dir, tier, json, first, reviewed, prior } = securityLaneWithDocsFix();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  git(dir, 'tag', 'v1', base);
  for (const name of ['main', 'lane', 'v1', 'HEAD', 'HEAD~1', 'main~0', 'refs/heads/main', base.slice(0, 12), reviewed.slice(0, 39), reviewed.toUpperCase(), `${reviewed}^`]) {
    for (const [flag, args] of [['--base', ['--delta', reviewed, '--base', name]], ['--delta', ['--delta', name, '--base', base]]]) {
      const result = tier(...args, '--prior', prior);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(`${flag} takes the full 40-character sha of a commit in a fix round, from the lead's own record: pass the output of \`git rev-parse <sha>\`, never a short sha or a name`), result.stderr);
    }
  }
  // Review R4-3: 40 hex digits that name no commit here get their own cause, not the short-sha message. A tree's sha is no commit either.
  for (const unknown of ['0'.repeat(40), 'f'.repeat(40), git(dir, 'rev-parse', `${reviewed}^{tree}`)]) {
    for (const [flag, args] of [['--base', ['--delta', reviewed, '--base', unknown]], ['--delta', ['--delta', unknown, '--base', base]], ['--rebased-onto', ['--delta', reviewed, '--base', base, '--rebased-onto', unknown]]]) {
      const result = tier(...args, '--prior', prior);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(`${flag} ${unknown} names no commit of this repository: pass the full sha from the lead's own record of this lane`), result.stderr);
      assert.ok(!result.stderr.includes('never a short sha or a name'), result.stderr);
    }
  }
  assert.equal(json('--delta', reviewed, '--prior', prior, '--base', base).range, `${reviewed}..HEAD`, 'two full shas are a fix round');
  // The caller's own base is the caller's word: a mid-lane sha is accepted, and the lane's classes then come from --lane-classes.
  assert.equal(tier('--delta', reviewed, '--prior', prior, '--base', first).status, 0);
});

test('security B7 (probe p4): a tag named like the first characters of the reviewed sha moves nothing: the short sha is exit 2, the full sha reads the fix that drops the guard', () => {
  const { dir, write, tier, json } = lane();
  git(dir, 'checkout', '-q', 'main');
  write('src/gate.mjs', "export function decide(cmd) {\n  return 'allow';\n}\n");
  git(dir, 'checkout', '-q', '-B', 'lane');
  write('src/gate.mjs', "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n");
  const reviewed = write('README.md', '# r\ngate: chained commands are denied\n');
  const dropsGuard = write('src/gate.mjs', "export function decide(cmd) {\n  return 'allow';\n}\n");
  write('README.md', '# r\ngate: see src/gate.mjs\n');
  const [base, prior] = [git(dir, 'rev-parse', 'refs/heads/main'), priorFile()];
  for (const length of [7, 12]) {
    const short = reviewed.slice(0, length);
    git(dir, 'tag', short, dropsGuard); // what the fix's writer adds
    assert.equal(git(dir, 'rev-parse', '--verify', '--quiet', `${short}^{commit}`), dropsGuard, 'plain git reads the short sha as the tag: the commit after the one that drops the guard would be the start');
    const result = tier('--delta', short, '--base', base, '--prior', prior);
    assert.equal(result.status, 2, short);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--delta takes the full 40-character sha .*pass the output of `git rev-parse <sha>`/);
  }
  const result = json('--delta', reviewed, '--base', base, '--prior', prior);
  assert.equal(result.range, `${reviewed}..HEAD`);
  assert.deepEqual([result.files, Object.keys(result.fileClasses).includes('src/gate.mjs'), lenses(result).length], [2, true, 3], 'the guard file is read, by three lenses');
});

test('security B6 (probes p3 a and c): with docs as the only --lane-classes name and the base branch moved into the lane, a docs fix of an execSync lane keeps tier 2, three lenses and the mutation plan', () => {
  const { dir, json, first, reviewed, round0, prior } = securityLaneWithDocsFix();
  const fixRound = ['--delta', reviewed, '--base', git(dir, 'rev-parse', 'refs/heads/main'), '--prior', prior, '--lane-classes', 'docs'];
  const control = json(...fixRound);
  assert.equal(control.tier, 2, 'the tool reads the lane itself: the names a caller passes only raise');
  assert.deepEqual(lenses(control), lenses(round0));
  assert.equal(lenses(control).length, 3);
  for (const review of control.reviews.filter((entry) => entry.model === 'opus')) assert.ok(review.plan.mutation.maxMutants > 0, `${review.lens} keeps the mutation plan`);
  git(dir, 'update-ref', 'refs/heads/main', first); // what the fix's writer does: the lane now seems to start after the execSync commit
  assert.deepEqual(json(...fixRound), control, 'the recorded base sha is read, never the branch');
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
  assert.match(control.range, /^[0-9a-f]{40}\.\.HEAD \(rewritten lane: /, `${opensGate} is read with the whole lane`);
  assert.ok(Object.keys(control.fileClasses).includes('src/gate.mjs'));
  git(dir, 'tag', 'main', opensGate);
  assert.deepEqual(seen(json('--delta', reviewed, '--prior', prior)), seen(control), 'the commit that removes the guard is still read');
});

test('a first review by an explicit range reads a named side only as the local branch: a tag, refs/main or a file $GIT_DIR/main changes nothing', () => {
  const { dir, json, first } = securityLaneWithDocsFix();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  const tip = git(dir, 'rev-parse', 'refs/heads/lane');
  const ranges = [['main...HEAD', `${base}...HEAD`], ['main..HEAD', `${base}..HEAD`], ['main...lane', `${base}...${tip}`], ['main..', `${base}..HEAD`]];
  const control = ranges.map(([range]) => seen(json(range, '--landing')));
  ranges.forEach(([range, printed], at) => assert.equal(control[at].range, printed, `${range}: the printed range holds the resolved sha`));
  assert.ok(control[0].classes.includes('security') && control[0].files === 2 && control[0].lenses.length === 3, 'the control reads the whole lane');
  const tricks = [
    ['a tag main at a mid-lane commit', () => git(dir, 'tag', 'main', first), () => git(dir, 'tag', '-d', 'main')],
    ['refs/main', () => git(dir, 'update-ref', 'refs/main', first), () => git(dir, 'update-ref', '-d', 'refs/main')],
    ['a file $GIT_DIR/main', () => writeFileSync(join(dir, '.git', 'main'), `${first}\n`), () => rmSync(join(dir, '.git', 'main'))],
    ['a tag lane at the base', () => git(dir, 'tag', 'lane', base), () => git(dir, 'tag', '-d', 'lane')],
  ];
  for (const [name, plant, remove] of tricks) {
    plant();
    ranges.forEach(([range], at) => assert.deepEqual(seen(json(range, '--landing')), control[at], `${name}: ${range}`));
    remove();
  }
});

test('a side of a range that is no HEAD, local branch or full sha exits 2 with what to pass; an ancestry step on such a side is read', () => {
  const { dir, tier, json, first, reviewed } = securityLaneWithDocsFix();
  git(dir, 'tag', 'v1', first);
  git(dir, 'update-ref', 'refs/remotes/origin/main', first);
  git(dir, 'update-ref', 'refs/main2', first);
  for (const range of ['v1...HEAD', 'main...v1', `${first.slice(0, 12)}..HEAD`, 'origin/main...HEAD', 'main2..HEAD', 'main@{0}...HEAD', 'HEAD@{0}..HEAD', 'v1~0..HEAD', 'main~x..HEAD']) {
    const result = tier(range, '--landing');
    assert.equal(result.status, 2, range);
    assert.equal(result.stdout, '', range);
    assert.match(result.stderr, /unknown revision "[^"]+" in range "[^"]+": a side is HEAD, a local branch \(read as refs\/heads\/<name>, never a tag or another ref of that name\) or a full 40-character sha, each with an optional ~N or \^N; for any other commit pass its full sha \(git rev-parse <name>\)/, range);
  }
  const tip = git(dir, 'rev-parse', 'HEAD');
  for (const [range, printed, files] of [['HEAD~1..HEAD', `${reviewed}..HEAD`, 1], [`${reviewed}^..${reviewed}`, `${first}..${reviewed}`, 1], ['lane~2...lane', `${first}...${tip}`, 1], [`${first}^...HEAD`, `${git(dir, 'rev-parse', 'refs/heads/main')}...HEAD`, 2]]) {
    const result = json(range);
    assert.equal(result.range, printed, range);
    assert.equal(result.files, files, range);
  }
});

test('security N15 (probe p5): a name that starts with refs/ is exit 2 as a base and as a side of a range, also when the branch refs/heads/refs/heads/main exists', () => {
  const { dir, tier, json, first } = securityLaneWithDocsFix();
  const control = seen(json('--landing'));
  git(dir, 'update-ref', 'refs/heads/refs/heads/main', first); // what the fix's writer adds: a branch whose own name starts with refs/heads/
  for (const args of [['refs/heads/main...HEAD'], ['refs/heads/main..HEAD'], ['main...refs/heads/lane'], ['--base', 'refs/heads/main'], ['--base', 'refs/tags/v1']]) {
    const result = tier(...args, '--landing');
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /starts with refs\/: a name is read only as the local branch refs\/heads\/<name>.* Pass the branch name alone \(main, not refs\/heads\/main\) or a full 40-character sha/, args.join(' '));
  }
  assert.deepEqual(seen(json('--landing')), control, 'the branch name alone still reads the real base');
});
