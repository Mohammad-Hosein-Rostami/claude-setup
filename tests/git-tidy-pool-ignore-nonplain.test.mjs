// Tests of lib/pool-ignore.mjs when .git/info or .git/info/exclude is not a plain file or folder (a folder or a link): the pool
// ignore is refused with the `failed` outcome, nothing outside the repo or in that path is written, and a claim goes on and says so.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { POOL_EXCLUDE_LINE, ignorePool } from '../home/tools/git-tidy/lib/pool-ignore.mjs';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { claim, laneEnv } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'a symlink and a file mode are POSIX' };
const PLAIN_FILE_MODE = 0o644;
const FAILED_LINE_START = 'git-tidy: lane folders show in git status';
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const infoPath = (repo) => join(repo, '.git', 'info');
const excludePath = (repo) => join(infoPath(repo), 'exclude');
const countLine = (text, line) => text.split('\n').filter((one) => one === line).length;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const outsideFolder = () => realpathSync(makeTempDir('pool-ignore-outside-'));

/** The env of a claim: a private HOME, TMPDIR and session id (laneEnv), and the checkout fill, which needs no clone. */
function claimEnv() {
  return { ...laneEnv(), TMPDIR: realpathSync(makeTempDir('pool-ignore-tmp-')), GIT_TIDY_LANE_FILL: 'checkout' };
}

/** The stderr lines of a claim that name the pool as shown in `git status`. */
const failedLines = (stderr) => stderr.split('\n').filter((line) => line.startsWith(FAILED_LINE_START));

/** Asserts the claim exit 0 and the one line `git-tidy: lane folders show in git status of <repo> (<why>): ...`. */
function assertClaimSaysFailed(result, repo) {
  assert.equal(result.status, 0, `status ${result.status}, signal ${result.signal}, stderr: ${result.stderr}`);
  const lines = failedLines(result.stderr);
  assert.equal(lines.length, 1, `stderr: ${result.stderr}`);
  assert.match(lines[0], new RegExp(`^${escapeRegExp(FAILED_LINE_START)} of ${escapeRegExp(repo)} \\(.+\\): land refuses there until git ignores \\.claude/worktrees/$`));
}

/** Every file and folder name below `folder` with its text, to compare before and after. */
function listing(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => [path, statSync(path).isFile() ? readFileSync(path, 'utf8') : null]);
}

/** A repo whose info/exclude is a folder holding one file. */
function repoWithExcludeFolder() {
  const repo = makeRepo();
  rmSync(excludePath(repo));
  mkdirSync(excludePath(repo));
  writeFileSync(join(excludePath(repo), 'inside.txt'), 'inside the exclude folder\n');
  return repo;
}

test('ignorePool returns failed with a reason and leaves the folder and its file alone when info/exclude is a folder', () => {
  const repo = repoWithExcludeFolder();
  const before = listing(excludePath(repo));
  const result = ignorePool(repo);
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.ok(typeof result.why === 'string' && result.why !== '', JSON.stringify(result));
  assert.equal(lstatSync(excludePath(repo)).isDirectory(), true);
  assert.deepEqual(listing(excludePath(repo)), before);
});

/** A repo whose .git/info is a link to a folder outside it that holds the repo's own info files; returns the repo and that folder. */
function repoWithLinkedInfo() {
  const repo = makeRepo();
  const outside = join(outsideFolder(), 'info');
  renameSync(infoPath(repo), outside);
  writeFileSync(join(outside, 'exclude'), '# outside the repo\n');
  symlinkSync(outside, infoPath(repo));
  return { repo, outside };
}

test('ignorePool returns failed and adds nothing to the outside folder when .git/info links to it', POSIX_ONLY, () => {
  const { repo, outside } = repoWithLinkedInfo();
  const before = listing(outside);
  const result = ignorePool(repo);
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.equal(result.path, excludePath(repo));
  assert.match(result.why, /link/i);
  assert.deepEqual(listing(outside), before);
  assert.equal(readFileSync(join(outside, 'exclude'), 'utf8'), '# outside the repo\n');
  assert.equal(readlinkSync(infoPath(repo)), outside);
});

test('ignorePool returns failed and makes nothing at the target when .git/info is a dangling link', POSIX_ONLY, () => {
  const repo = makeRepo();
  const target = join(outsideFolder(), 'missing-info');
  rmSync(infoPath(repo), { recursive: true });
  symlinkSync(target, infoPath(repo));
  const result = ignorePool(repo);
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.equal(result.path, excludePath(repo));
  assert.equal(existsSync(target), false);
  assert.equal(readlinkSync(infoPath(repo)), target);
});

test('a claim in a repo whose .git/info links outside it succeeds, prints one failed line and leaves the outside folder alone', POSIX_ONLY, () => {
  const { repo, outside } = repoWithLinkedInfo();
  const before = listing(outside);
  assertClaimSaysFailed(claim(repo, 'lane/a', head(repo), claimEnv()), repo);
  assert.deepEqual(listing(outside), before);
});

test('ignorePool makes a missing info/ and a 0644 info/exclude, and a second call leaves the pool line once', POSIX_ONLY, () => {
  const repo = makeRepo();
  rmSync(infoPath(repo), { recursive: true });
  assert.deepEqual(ignorePool(repo), { outcome: 'added', path: excludePath(repo) });
  assert.equal(readFileSync(excludePath(repo), 'utf8'), `${POOL_EXCLUDE_LINE}\n`);
  assert.equal(statSync(excludePath(repo)).mode & 0o777, PLAIN_FILE_MODE & ~process.umask());
  assert.deepEqual(ignorePool(repo), { outcome: 'already', path: null });
  assert.equal(countLine(readFileSync(excludePath(repo), 'utf8'), POOL_EXCLUDE_LINE), 1);
});
