// Tests that try to break git-tidy: facts that change between the check and the removal, forged candidates, a repo in the
// middle of an operation, bare and shallow repos, an inherited GIT_DIR, odd histories and many branches.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLeftovers } from '../home/tools/git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../home/tools/git-tidy/lib/prune.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { CLEAN_ENV, addWorktree, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const apply = (dir, ...extra) => tidy(['prune', dir, '--apply', ...extra], { cwd: dir });
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
const actions = (items) => items.map((entry) => `${entry.action} ${entry.kind} ${entry.subject}`);

/** Leaves `dir` in the middle of a merge with a conflict (the merge exits 1 by design). */
function startConflictedMerge(dir) {
  git(dir, 'checkout', '-q', '-b', 'left');
  commit(dir, 'c.txt', 'left');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'c.txt', 'main');
  const merge = spawnSync('git', ['merge', 'left'], { cwd: dir, env: CLEAN_ENV });
  assert.equal(merge.status, 1);
}

test('re-check at apply time: candidates found earlier are not trusted when the repo changed since', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'got-work');
  git(dir, 'branch', 'got-checked-out');
  const dirtied = addWorktree(dir, 'wt-dirtied', 'dirtied');
  const repo = openRepo(dir, null);
  const candidates = findLeftovers(repo);
  assert.deepEqual(candidates.mergedBranches.map((b) => b.name).sort(), ['dirtied', 'got-checked-out', 'got-work']);

  git(dir, 'checkout', '-q', 'got-work');
  commit(dir, 'new-work.txt');
  git(dir, 'checkout', '-q', 'main');
  const holder = addWorktree(dir, 'wt-new-holder', 'got-checked-out', { create: false });
  writeFileSync(join(dirtied, 'late.txt'), 'written after the check');

  const items = pruneRepo(repo, { apply: true, leftovers: candidates });
  assert.deepEqual(branches(dir), ['dirtied', 'got-checked-out', 'got-work', 'main']);
  assert.ok(existsSync(dirtied) && existsSync(holder) && existsSync(join(dirtied, 'late.txt')));
  assert.deepEqual(items.filter((entry) => entry.action === 'deleted' || entry.action === 'removed'), []);
  assert.ok(items.some((entry) => entry.subject === 'got-work' && entry.detail.includes('not on main')), JSON.stringify(items));
  assert.ok(items.some((entry) => entry.subject === 'got-checked-out' && entry.detail.includes('checked out in')), JSON.stringify(items));
});

test('forged candidates: the base, the current branch, a main-worktree path, an unmerged branch and a missing name are all kept', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'wip');
  commit(dir, 'wip.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'current-one');
  git(dir, 'checkout', '-q', 'current-one');
  const wt = addWorktree(dir, 'wt-on-base', 'main', { create: false });
  const repo = openRepo(dir, null);
  const forged = {
    staleWorktrees: [{ path: dir }],
    mergedWorktrees: [{ path: dir, branch: 'current-one' }, { path: wt, branch: 'main' }],
    mergedBranches: ['main', 'current-one', 'wip', 'no-such-branch'].map((name) => ({ name, short: 'abc' })),
  };
  const items = pruneRepo(repo, { apply: true, leftovers: forged });
  assert.deepEqual(items.filter((entry) => ['removed', 'deleted', 'failed'].includes(entry.action)), [], JSON.stringify(items));
  assert.deepEqual(branches(dir), ['current-one', 'main', 'wip']);
  assert.ok(existsSync(dir) && existsSync(wt));
});

test('a linked worktree on the base branch is never removed (main checkout sits on another branch)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'topic');
  const wt = addWorktree(dir, 'wt-base', 'main', { create: false });
  const result = apply(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(existsSync(wt));
  assert.deepEqual(branches(dir), ['main', 'topic']);
});

test('GIT_DIR in the environment never makes prune --apply act on another repository', () => {
  const target = makeRepo();
  const decoy = makeRepo();
  git(target, 'branch', 'merged-in-target');
  git(decoy, 'branch', 'merged-in-decoy');
  const result = tidy(['prune', target, '--apply'], { cwd: target, env: { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy } });
  assert.equal(result.status, 0);
  assert.deepEqual(branches(target), ['main']);
  assert.deepEqual(branches(decoy), ['main', 'merged-in-decoy']);
});

test('a merge in progress: check hints in-progress?, prune --apply refuses with exit 2 and deletes nothing, the plan still works', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  startConflictedMerge(dir);
  const check = tidy(['check', dir], { cwd: dir });
  assert.ok(lines(check).includes(`in-progress? ${dir} merge not finished`), check.stdout);
  const refused = apply(dir);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /merge is not finished/);
  assert.ok(branches(dir).includes('fresh'));
  assert.equal(tidy(['prune', dir], { cwd: dir }).status, 0);
});

test('a rebase in progress in a linked worktree refuses --apply run from the main checkout', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  git(dir, 'checkout', '-q', '-b', 'left');
  commit(dir, 'c.txt', 'left');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'c.txt', 'main');
  const wt = addWorktree(dir, 'wt-rebase', 'left', { create: false });
  assert.equal(spawnSync('git', ['rebase', 'main'], { cwd: wt, env: CLEAN_ENV }).status, 1);
  const refused = apply(dir);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /rebase is not finished/);
  assert.ok(branches(dir).includes('fresh') && existsSync(wt));
});

test('a bare repo: check and prune work on its branches, HEAD branch and base stay', () => {
  const source = makeRepo();
  git(source, 'branch', 'fresh');
  const bare = join(source, '..', 'bare.git');
  git(source, 'clone', '-q', '--bare', source, bare);
  const check = tidy(['check', bare], { cwd: bare });
  assert.equal(check.status, 1);
  assert.ok(lines(check).some((line) => line.startsWith('merged-branch fresh ')), check.stdout);
  assert.equal(apply(bare).status, 0);
  assert.deepEqual(branches(bare), ['main']);
});

test('a shallow clone: shows the shallow? hint, and a branch whose history is cut is not deleted', () => {
  const source = makeRepo();
  commit(source, 'two.txt');
  commit(source, 'three.txt');
  git(source, 'checkout', '-q', '-b', 'feat', 'HEAD~2');
  commit(source, 'feat.txt');
  git(source, 'checkout', '-q', 'main');
  const clone = join(source, '..', 'shallow');
  git(source, 'clone', '-q', '--depth', '1', '--no-single-branch', `file://${source}`, clone);
  git(clone, 'branch', 'feat', 'origin/feat');
  const check = tidy(['check', clone], { cwd: clone });
  assert.ok(lines(check).some((line) => line.startsWith('shallow? ')), check.stdout);
  apply(clone);
  assert.ok(branches(clone).includes('feat'), 'a branch with work and an unreachable ancestry must stay');
});

test('an orphan branch with unrelated history is unmerged and kept', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '--orphan', 'unrelated');
  commit(dir, 'other-root.txt');
  git(dir, 'checkout', '-q', 'main');
  assert.equal(apply(dir).status, 0);
  assert.ok(branches(dir).includes('unrelated'));
});

test('submodules are ignored: a repo with one checks clean and prune leaves it alone', () => {
  const sub = makeRepo();
  const dir = makeRepo();
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(dir, 'commit', '-q', '-m', 'add submodule');
  assert.equal(tidy(['check', dir], { cwd: dir }).status, 0);
  assert.equal(apply(dir).status, 0);
  assert.ok(existsSync(join(dir, 'vendor', 'sub', 'base.txt')));
});

test('a repo with no commit has no base: exit 2 naming --base', () => {
  const dir = join(realpathSync(makeRepo()), '..', 'empty');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const result = tidy(['check', dir], { cwd: dir });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--base/);
});

test('300 branches: check and the prune plan each finish in a few seconds and sort every branch right', () => {
  const dir = makeRepo();
  const ancestorTip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'landed');
  const landedTip = commit(dir, 'landed.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'open');
  const openTip = commit(dir, 'open.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'landed');
  git(dir, 'branch', '-D', 'landed', 'open');
  const refs = [];
  for (let i = 0; i < 100; i++) refs.push(`${ancestorTip} refs/heads/anc/${i}`, `${landedTip} refs/heads/landed/${i}`, `${openTip} refs/heads/open/${i}`);
  writeFileSync(join(dir, '.git', 'packed-refs'), `${refs.join('\n')}\n`);
  const started = Date.now();
  const check = tidy(['check', dir], { cwd: dir });
  const plan = tidy(['prune', dir], { cwd: dir });
  const seconds = (Date.now() - started) / 1000;
  const merged = lines(check).filter((line) => line.startsWith('merged-branch ')).length;
  const unmerged = lines(check).filter((line) => line.startsWith('unmerged-branch? ')).length;
  assert.deepEqual([check.status, merged, unmerged], [1, 200, 100]);
  assert.match(lines(plan).at(-1), /^git-tidy prune: 200 to remove, 0 kept/);
  assert.ok(seconds < 8, `took ${seconds}s`);
  assert.deepEqual(actions(JSON.parse(tidy(['prune', dir, '--json'], { cwd: dir }).stdout).items).filter((a) => a.startsWith('keep')), []);
  const appliedAt = Date.now();
  assert.equal(apply(dir).status, 0);
  assert.ok((Date.now() - appliedAt) / 1000 < 20, 'apply re-reads every branch before deleting it');
  assert.equal(branches(dir).length, 101, 'main and the 100 branches with their own commit remain');
});
