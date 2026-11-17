// Tests for `git-tidy check` end to end: findings, hints, base detection, output formats and exit codes.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addWorktree, CLEAN_ENV, commit, git, lines as allLines, makeRepo, tidy, withOrigin } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

// The first output line is the base line (tested on its own); the other tests read the lines after it.
const lines = (result) => allLines(result).slice(1);
const check = (dir, ...extra) => tidy(['check', dir, ...extra], { cwd: dir });
const SUMMARY = (findings, hints, oneLine = findings === 0, base = 'main') => `git-tidy: ${findings} findings, ${hints} hints (base ${base}), all local refs on one line: ${oneLine ? 'yes' : 'no'}`;

/** Merges a new branch `side` into main with a real merge commit; returns the short hash of the merge. */
function mergeSide(dir) {
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'side.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

/** feat has one commit that main gets as a cherry-pick with another hash (a rebase that landed). */
function landRebased(dir, branch = 'feat') {
  git(dir, 'checkout', '-q', '-b', branch);
  commit(dir, `${branch}.txt`);
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', branch);
}

test('a linear repo is clean: exit 0 and only the summary line', () => {
  const dir = makeRepo();
  commit(dir, 'second.txt');
  const result = check(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(lines(result), [SUMMARY(0, 0)]);
});

test('a merge commit ahead of the upstream is a finding; the same merge already on the upstream is only a hint', () => {
  const dir = makeRepo();
  withOrigin(dir);
  const short = mergeSide(dir);
  git(dir, 'branch', '-D', 'side');
  const ahead = check(dir);
  assert.equal(ahead.status, 1);
  assert.deepEqual(lines(ahead), [`merge-commit ${short} Merge side`, SUMMARY(1, 0)]);

  git(dir, 'push', '-q', 'origin', 'main');
  const published = check(dir);
  assert.equal(published.status, 0);
  assert.deepEqual(lines(published), ['published-merge? origin/main 1 merge commits already published', SUMMARY(0, 1)]);
});

test('without an upstream every merge commit on the base and on base..HEAD is reported', () => {
  const dir = makeRepo();
  const onBase = mergeSide(dir);
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'topic.txt');
  git(dir, 'checkout', '-q', '-b', 'inner');
  commit(dir, 'inner.txt');
  git(dir, 'checkout', '-q', 'topic');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  const onHead = git(dir, 'rev-parse', '--short', 'HEAD');
  const result = check(dir);
  assert.equal(result.status, 1);
  const merges = lines(result).filter((line) => line.startsWith('merge-commit '));
  assert.deepEqual(merges.sort(), [`merge-commit ${onBase} Merge side`, `merge-commit ${onHead} Merge inner`].sort());
});

test('a branch that is an ancestor of the base is merged-branch ancestor, also a fresh branch with no work', () => {
  const dir = makeRepo();
  const tip = git(dir, 'rev-parse', '--short', 'HEAD');
  git(dir, 'branch', 'fresh');
  commit(dir, 'second.txt');
  const result = check(dir);
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result), [`merged-branch fresh ${tip} ancestor`, SUMMARY(1, 0)]);
});

test('a branch rebased onto the base and landed with other hashes is merged-branch patch-equal', () => {
  const dir = makeRepo();
  landRebased(dir);
  const tip = git(dir, 'rev-parse', '--short', 'feat');
  assert.notEqual(git(dir, 'rev-parse', 'feat'), git(dir, 'rev-parse', 'main'));
  assert.deepEqual(lines(check(dir)), [`merged-branch feat ${tip} patch-equal`, SUMMARY(1, 0)]);
});

test('a branch with one extra commit is the hint unmerged-branch? with the count and the last commit date', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'wip');
  commit(dir, 'wip.txt');
  git(dir, 'checkout', '-q', 'main');
  const date = git(dir, 'log', '-1', '--format=%cs', 'wip');
  const result = check(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(lines(result), [`unmerged-branch? wip ahead 1, last commit ${date}`, SUMMARY(0, 1)]);
});

test('a branch with two commits of which one landed is unmerged, counting only the new one', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'half');
  commit(dir, 'one.txt');
  commit(dir, 'two.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'half~1');
  const result = check(dir);
  assert.equal(result.status, 0);
  assert.match(lines(result)[0], /^unmerged-branch\? half ahead 1, last commit \d{4}-\d\d-\d\d$/);
});

/** feat = one commit + a merge of `inner` (one commit); main gets both commits as cherry-picks. `evil` adds a file to the merge only. */
function landBranchWithMerge(dir, { evil }) {
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'feat.txt');
  git(dir, 'checkout', '-q', '-b', 'inner');
  commit(dir, 'inner.txt');
  git(dir, 'checkout', '-q', 'feat');
  git(dir, 'merge', '-q', '--no-ff', '--no-commit', 'inner');
  if (evil) writeFileSync(join(dir, 'only-in-the-merge.txt'), 'hand-made change');
  if (evil) git(dir, 'add', 'only-in-the-merge.txt');
  git(dir, 'commit', '-q', '-m', 'Merge inner');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'feat~1', 'inner');
}

test('a branch holding a merge commit is patch-equal when merging it changes nothing, and unmerged when the merge carries its own change', () => {
  const plain = makeRepo();
  landBranchWithMerge(plain, { evil: false });
  assert.ok(lines(check(plain)).some((line) => line.startsWith('merged-branch feat ') && line.endsWith(' patch-equal')), 'no hand-made change in the merge');
  const evil = makeRepo();
  landBranchWithMerge(evil, { evil: true });
  const out = lines(check(evil));
  assert.ok(!out.some((line) => line.startsWith('merged-branch feat ')), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('unmerged-branch? feat ')), out.join('\n'));
});

test('the base and the branch checked out in the main worktree are never merged-branch', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'other');
  git(dir, 'checkout', '-q', 'other');
  commit(dir, 'x.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'other');
  git(dir, 'checkout', '-q', 'other');
  const names = lines(check(dir)).filter((line) => line.startsWith('merged-branch'));
  assert.deepEqual(names, []);
});

test('a linked worktree of a merged branch is merged-worktree; one whose folder is gone is stale-worktree', () => {
  const dir = makeRepo();
  const merged = addWorktree(dir, 'wt-merged', 'done');
  const gone = addWorktree(dir, 'wt-gone', 'gone-branch');
  rmSync(gone, { recursive: true, force: true });
  const result = check(dir);
  assert.equal(result.status, 1);
  const out = lines(result);
  assert.ok(out.includes(`merged-worktree ${merged} branch done`), out.join('\n'));
  assert.ok(out.includes(`stale-worktree ${gone} folder missing`), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('merged-branch done ')), out.join('\n'));
});

test('hints: merged remote branch, behind base, dirty linked worktree', () => {
  const dir = makeRepo();
  withOrigin(dir);
  git(dir, 'push', '-q', 'origin', 'main:old-feature');
  git(dir, 'branch', 'behind');
  const wt = addWorktree(dir, 'wt-wip', 'wip');
  commit(wt, 'wip.txt');
  writeFileSync(join(wt, 'scratch.txt'), 'untracked');
  git(dir, 'checkout', '-q', '-b', 'older');
  commit(dir, 'moves-base.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'older');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-q', 'behind');
  const out = lines(check(dir));
  assert.ok(out.some((line) => /^merged-remote-branch\? origin\/old-feature [0-9a-f]{7,}$/.test(line)), out.join('\n'));
  assert.ok(out.includes('behind-base? behind behind main by 1'), out.join('\n'));
  assert.ok(out.includes(`dirty-worktree? ${wt} changed 1`), out.join('\n'));
  assert.ok(!out.some((line) => line.startsWith('merged-remote-branch? origin/main')), 'the upstream itself is not a leftover');
});

test('--json prints { base, findings, hints } with kind, subject and detail', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  git(dir, 'checkout', '-q', '-b', 'wip');
  commit(dir, 'wip.txt');
  git(dir, 'checkout', '-q', 'main');
  const parsed = JSON.parse(check(dir, '--json').stdout);
  assert.deepEqual(Object.keys(parsed), ['base', 'findings', 'hints']);
  assert.equal(parsed.base, 'main');
  assert.deepEqual(parsed.findings.map((f) => [f.kind, f.subject]), [['merged-branch', 'fresh']]);
  assert.match(parsed.findings[0].detail, /^[0-9a-f]{7,} ancestor$/);
  assert.deepEqual(parsed.hints.map((h) => [h.kind, h.subject]), [['unmerged-branch?', 'wip']]);
});

test('base: --base wins, then origin/HEAD, then main, master, develop; none is exit 2 naming --base', () => {
  const dir = makeRepo();
  git(dir, 'branch', '-m', 'main', 'develop');
  assert.match(lines(check(dir)).at(-1), /\(base develop\)/);
  git(dir, 'branch', 'master');
  assert.match(lines(check(dir)).at(-1), /\(base master\)/);
  git(dir, 'branch', 'main');
  assert.match(lines(check(dir)).at(-1), /\(base main\)/);
  assert.match(lines(check(dir, '--base', 'develop')).at(-1), /\(base develop\)/);

  withOrigin(dir);
  git(dir, 'branch', 'trunk');
  git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'trunk');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.match(lines(check(dir)).at(-1), /\(base trunk\)/);
  git(dir, 'branch', '-D', 'trunk');
  assert.match(lines(check(dir)).at(-1), /\(base main\)/, 'origin/HEAD naming a missing local branch falls through');

  const none = makeRepo();
  git(none, 'branch', '-m', 'main', 'trunk');
  const result = check(none);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--base/);
  const missing = check(none, '--base', 'nope');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /nope/);
});

test('exit 2: not a repo, missing folder, unknown command or flag, two folders, --base without a value', () => {
  const plain = realpathSync(makeTempDir('git-tidy-plain-'));
  const dir = makeRepo();
  const runs = [['check', plain], ['check', join(plain, 'missing')], [], ['list', dir], ['check', dir, '--wat'], ['check', dir, dir], ['check', dir, '--base']];
  for (const args of runs) {
    const result = tidy(args, { cwd: plain });
    assert.equal(result.status, 2, args.join(' '));
    assert.notEqual(result.stderr, '', args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('the folder defaults to the current one and may be a subfolder or a linked worktree', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  mkdirSync(join(dir, 'sub'));
  const wt = addWorktree(dir, 'wt', 'wt-branch');
  for (const cwd of [dir, join(dir, 'sub'), wt]) {
    const result = tidy(['check'], { cwd });
    assert.equal(result.status, 1, cwd);
    assert.ok(lines(result).some((line) => line.startsWith('merged-branch fresh ')), cwd);
  }
});

test('GIT_DIR from the environment does not redirect the tool away from the folder it was given', () => {
  const dir = makeRepo();
  const decoy = makeRepo();
  git(decoy, 'branch', 'decoy-branch');
  const result = tidy(['check', dir], { cwd: dir, env: { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy } });
  assert.equal(result.status, 0);
  assert.deepEqual(lines(result), [SUMMARY(0, 0)]);
});

test('the first line names the base and how it was chosen; the JSON keeps its shape', () => {
  const dir = makeRepo();
  assert.equal(allLines(check(dir))[0], 'base: main (fallback)');
  assert.equal(allLines(check(dir, '--base', 'main'))[0], 'base: main (from --base)');
  withOrigin(dir);
  assert.equal(allLines(check(dir))[0], 'base: main (from origin/HEAD)');
});

test('check never runs a textconv program of the repository config (the staged-changes test uses plumbing)', () => {
  const dir = makeRepo();
  const marker = join(makeTempDir('git-tidy-textconv-'), 'ran');
  const program = join(makeTempDir('git-tidy-textconv-program-'), 'textconv.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`);
  chmodSync(program, 0o755);
  commit(dir, 'data.bin', 'one\n');
  writeFileSync(join(dir, '.gitattributes'), '*.bin diff=sneaky\n');
  git(dir, 'config', 'diff.sneaky.textconv', program);
  writeFileSync(join(dir, 'data.bin'), 'two\n');
  git(dir, 'add', 'data.bin');
  spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD'], { cwd: dir, env: CLEAN_ENV });
  assert.ok(existsSync(marker), 'sanity: porcelain git diff runs the textconv program');
  rmSync(marker);
  assert.ok([0, 1].includes(check(dir).status));
  assert.ok(!existsSync(marker), 'check did not run it');
});
