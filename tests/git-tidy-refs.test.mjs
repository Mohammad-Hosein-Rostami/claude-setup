// Tests for the whole-graph part of `git-tidy check`: tangled-ref (branches and tags that still reach an unpublished merge
// commit), merged-tag, unmerged-tag?, the "all local refs on one line" summary, and `prune` never deleting tags.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { commit, git, lines, makeRepo, tidy, withOrigin } from './git-tidy-helpers.mjs';

const check = (dir, ...extra) => tidy(['check', dir, ...extra], { cwd: dir });
const body = (result) => lines(result).slice(1, -1);
const summary = (result) => lines(result).at(-1);

/** Old tangled history behind the tag `backup-old`: a merge commit whose work was later rebased onto main; only the tag is left. */
function backupTagBehindMerge(dir) {
  git(dir, 'checkout', '-q', '-b', 'old');
  commit(dir, 'old.txt');
  git(dir, 'checkout', '-q', '-b', 'side', 'main');
  commit(dir, 'side.txt');
  git(dir, 'checkout', '-q', 'old');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  git(dir, 'tag', 'backup-old');
  const mergeShort = git(dir, 'rev-parse', '--short', 'old');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'old~1', 'side');
  git(dir, 'branch', '-D', 'old', 'side');
  return mergeShort;
}

test('a backup tag on a merged old tip with a merge commit behind it is both tangled-ref and merged-tag', () => {
  const dir = makeRepo();
  const mergeShort = backupTagBehindMerge(dir);
  const tip = git(dir, 'rev-parse', '--short', 'backup-old');
  const result = check(dir);
  assert.equal(result.status, 1);
  assert.deepEqual(body(result), [
    `tangled-ref refs/tags/backup-old 1 merge commits not on any remote, newest ${mergeShort}`,
    `merged-tag backup-old ${tip} patch-equal`,
  ]);
  assert.match(summary(result), /all local refs on one line: no$/);
});

test('a release tag on the base line is never reported, and the summary says one line: yes', () => {
  const dir = makeRepo();
  git(dir, 'tag', 'light-1');
  git(dir, 'tag', '-a', '-m', 'release', 'v1');
  commit(dir, 'second.txt');
  const result = check(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(body(result), []);
  assert.match(summary(result), /all local refs on one line: yes$/);
});

test('a tag on unmerged work is the hint unmerged-tag?, never a finding', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'work');
  commit(dir, 'work.txt');
  git(dir, 'tag', '-a', '-m', 'wip', 'wip-tag');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-D', 'work');
  const date = git(dir, 'log', '-1', '--format=%cs', 'wip-tag');
  const result = check(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(body(result), [`unmerged-tag? wip-tag ahead 1, last commit ${date}`]);
});

test('a merge commit already on the remote is not tangled; the same merge only local is, and the current branch keeps merge-commit', () => {
  const dir = makeRepo();
  withOrigin(dir);
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 'topic.txt');
  git(dir, 'checkout', '-q', '-b', 'inner');
  commit(dir, 'inner.txt');
  git(dir, 'checkout', '-q', 'topic');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  git(dir, 'checkout', '-q', 'main');
  const local = body(check(dir));
  assert.ok(local.some((line) => line.startsWith('tangled-ref refs/heads/topic 1 merge commits')), local.join('\n'));
  git(dir, 'push', '-q', 'origin', 'topic');
  const published = body(check(dir));
  assert.ok(!published.some((line) => line.startsWith('tangled-ref')), published.join('\n'));

  const noRemote = makeRepo();
  git(noRemote, 'checkout', '-q', '-b', 'topic');
  commit(noRemote, 'topic.txt');
  git(noRemote, 'checkout', '-q', '-b', 'inner');
  commit(noRemote, 'inner.txt');
  git(noRemote, 'checkout', '-q', 'topic');
  git(noRemote, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  const current = body(check(noRemote));
  assert.ok(current.some((line) => line.startsWith('merge-commit ')), current.join('\n'));
  assert.ok(!current.some((line) => line.startsWith('tangled-ref refs/heads/topic ')), 'the current branch is reported once, as merge-commit');
});

test('prune lists merged tags and --apply leaves every tag in place', () => {
  const dir = makeRepo();
  backupTagBehindMerge(dir);
  git(dir, 'tag', 'v1');
  git(dir, 'branch', 'fresh');
  const before = git(dir, 'tag', '--list');
  const plan = tidy(['prune', dir, '--include-recent'], { cwd: dir });
  assert.ok(lines(plan).includes('tags (not removed by this tool: delete by hand after verifying your bundle backup): backup-old'), plan.stdout);
  const applied = tidy(['prune', dir, '--apply', '--include-recent'], { cwd: dir });
  assert.equal(applied.status, 0);
  assert.equal(git(dir, 'tag', '--list'), before);
  assert.ok(!git(dir, 'for-each-ref', 'refs/heads').includes('fresh'), 'the merged branch itself still goes');
});
