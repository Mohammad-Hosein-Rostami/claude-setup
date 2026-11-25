// Tests of lib/pool-ignore.mjs and the claim's use of it (lane-pool.mjs claimLane, lane-cli.mjs runClaim): a claim keeps the lane pool
// `.claude/worktrees/` out of `git status` through the repo's local info/exclude, once, and says so on stderr.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { POOL_EXCLUDE_LINE, ignorePool } from '../home/tools/git-tidy/lib/pool-ignore.mjs';
import { CLI, CLEAN_ENV, addWorktree, commit, git, makeRepo } from './git-tidy-helpers.mjs';
import { adminDir, claim, laneEnv } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'a symlink and a file mode are POSIX' };
const PLAIN_FILE_MODE = 0o644;
const NEGATION_RULE = '!/.claude/worktrees/';
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const excludePath = (repo) => join(repo, '.git', 'info', 'exclude');
const added = (path) => `git-tidy: added ${POOL_EXCLUDE_LINE} to ${path} so lane folders stay out of git status`;
const countLine = (text, line) => text.split('\n').filter((one) => one === line).length;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The env of a claim: a private HOME, TMPDIR and session id (laneEnv), and the checkout fill, which needs no clone. */
function claimEnv() {
  return { ...laneEnv(), TMPDIR: realpathSync(makeTempDir('pool-ignore-tmp-')), GIT_TIDY_LANE_FILL: 'checkout' };
}

/** Runs `lane claim` as a child that starts at once; resolves `{ status, stderr }` when it ends. */
function claimAsync(repo, branch, base, env) {
  const child = spawn(process.execPath, [CLI, 'lane', 'claim', '--repo', repo, '--branch', branch, '--base', base], { env: { ...CLEAN_ENV, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('the first claim in a repo that ignores nothing says it added the pool line to info/exclude; later claims say nothing', async () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = claimEnv();
  const first = claim(repo, 'lane/a', base, env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, `${added(excludePath(repo))}\n`);
  const second = claim(repo, 'lane/b', base, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  const together = await Promise.all([claimAsync(repo, 'lane/c', base, env), claimAsync(repo, 'lane/d', base, env)]);
  assert.deepEqual(together.map(({ status, stderr }) => [status, stderr]), [[0, ''], [0, '']]);
  assert.equal(countLine(readFileSync(excludePath(repo), 'utf8'), POOL_EXCLUDE_LINE), 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('two first claims started together add the line once and only one of them says so', async () => {
  const repo = makeRepo();
  const base = head(repo);
  const env = claimEnv();
  const results = await Promise.all([claimAsync(repo, 'lane/a', base, env), claimAsync(repo, 'lane/b', base, env)]);
  assert.deepEqual(results.map(({ status }) => status), [0, 0]);
  const stderr = results.map((result) => result.stderr);
  assert.deepEqual(stderr.filter((text) => text !== '').sort(), [`${added(excludePath(repo))}\n`]);
  assert.equal(countLine(readFileSync(excludePath(repo), 'utf8'), POOL_EXCLUDE_LINE), 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('a committed .gitignore that ignores .claude/ leaves info/exclude as it was, also when it is missing, and the claim says nothing', () => {
  const repo = makeRepo();
  commit(repo, '.gitignore', '.claude/\n');
  const base = head(repo);
  const env = claimEnv();
  const before = readFileSync(excludePath(repo));
  const first = claim(repo, 'lane/a', base, env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.deepEqual(readFileSync(excludePath(repo)), before);
  rmSync(excludePath(repo));
  const second = claim(repo, 'lane/b', base, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(existsSync(excludePath(repo)), false);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('ignorePool on a repo whose .gitignore already ignores the pool returns already with no path', () => {
  const repo = makeRepo();
  commit(repo, '.gitignore', '.claude/\n');
  rmSync(excludePath(repo));
  assert.deepEqual(ignorePool(repo), { outcome: 'already', path: null });
  assert.equal(existsSync(excludePath(repo)), false);
});

test('ignorePool starts a new line when info/exclude does not end with one', () => {
  const repo = makeRepo();
  writeFileSync(excludePath(repo), '# x');
  assert.deepEqual(ignorePool(repo), { outcome: 'added', path: excludePath(repo) });
  assert.equal(readFileSync(excludePath(repo), 'utf8'), `# x\n${POOL_EXCLUDE_LINE}\n`);
});

/** A repo whose info/exclude is a link to a file outside it; returns the repo, the target file and the target's text. */
function repoWithLinkedExclude() {
  const repo = makeRepo();
  const target = join(realpathSync(makeTempDir('pool-ignore-outside-')), 'outside-exclude');
  const text = '# outside the repo\n';
  writeFileSync(target, text);
  rmSync(excludePath(repo));
  symlinkSync(target, excludePath(repo));
  return { repo, target, text };
}

test('ignorePool returns failed and never writes through an info/exclude that links outside the repo', POSIX_ONLY, () => {
  const { repo, target, text } = repoWithLinkedExclude();
  const result = ignorePool(repo);
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.equal(result.path, excludePath(repo));
  assert.match(result.why, /ELOOP|link/i);
  assert.equal(readFileSync(target, 'utf8'), text);
});

test('a claim in a repo whose info/exclude links outside it still succeeds, prints the failed line and leaves the target alone', POSIX_ONLY, () => {
  const { repo, target, text } = repoWithLinkedExclude();
  const result = claim(repo, 'lane/a', head(repo), claimEnv());
  assert.equal(result.status, 0, result.stderr);
  const failedLines = result.stderr.split('\n').filter((line) => line.startsWith('git-tidy: lane folders show in git status'));
  assert.equal(failedLines.length, 1, `stderr: ${result.stderr}`);
  assert.match(failedLines[0], new RegExp(`^git-tidy: lane folders show in git status of ${escapeRegExp(repo)} \\(.+\\): land refuses there until git ignores \\.claude/worktrees/$`));
  assert.equal(readFileSync(target, 'utf8'), text);
});

test('ignorePool returns failed when a .gitignore re-includes the pool, and repeated calls keep the exclude line once', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.gitignore'), `${NEGATION_RULE}\n`);
  const outcomes = [ignorePool(repo), ignorePool(repo), ignorePool(repo)];
  for (const outcome of outcomes) assert.deepEqual(outcome, { outcome: 'failed', path: excludePath(repo), why: '.gitignore re-includes it' });
  assert.equal(countLine(readFileSync(excludePath(repo), 'utf8'), POOL_EXCLUDE_LINE), 1);
});

test('ignorePool writes the common dir\'s info/exclude whether it is given the main worktree or a linked one', () => {
  for (const viaLinked of [false, true]) {
    const repo = makeRepo();
    const linked = addWorktree(repo, 'linked', 'feature');
    const result = ignorePool(viaLinked ? linked : repo);
    assert.deepEqual(result, { outcome: 'added', path: excludePath(repo) }, `via ${viaLinked ? 'the linked worktree' : 'main'}`);
    assert.equal(countLine(readFileSync(excludePath(repo), 'utf8'), POOL_EXCLUDE_LINE), 1);
    assert.equal(existsSync(join(adminDir(linked), 'info', 'exclude')), false);
  }
});

test('ignorePool makes a missing info/ folder and a 0644 info/exclude holding the pool line', POSIX_ONLY, () => {
  const repo = makeRepo();
  rmSync(join(repo, '.git', 'info'), { recursive: true });
  assert.deepEqual(ignorePool(repo), { outcome: 'added', path: excludePath(repo) });
  assert.equal(readFileSync(excludePath(repo), 'utf8'), `${POOL_EXCLUDE_LINE}\n`);
  assert.equal(statSync(excludePath(repo)).mode & 0o777, PLAIN_FILE_MODE & ~process.umask());
});

const infoPath = (repo) => join(repo, '.git', 'info');
const linkedInfoWhy = (repo) => `not added to ${excludePath(repo)}: ${infoPath(repo)} is a link, never followed`;

/** A repo whose .git/info folder is a link to `outside/info-target`; the target holds an exclude file when `withExclude`. */
function repoWithLinkedInfo({ withExclude }) {
  const repo = makeRepo();
  const outside = realpathSync(makeTempDir('pool-ignore-info-outside-'));
  const target = join(outside, 'info-target');
  const bytes = Buffer.from('# outside the repo\r\nkeep-me\n');
  if (withExclude) {
    mkdirSync(target);
    writeFileSync(join(target, 'exclude'), bytes);
  }
  rmSync(infoPath(repo), { recursive: true });
  symlinkSync(target, infoPath(repo));
  return { repo, outside, target, bytes };
}

test('ignorePool returns failed and never writes through a .git/info folder that links to an outside folder', POSIX_ONLY, () => {
  const { repo, target, bytes } = repoWithLinkedInfo({ withExclude: true });
  assert.deepEqual(ignorePool(repo), { outcome: 'failed', path: excludePath(repo), why: linkedInfoWhy(repo) });
  assert.deepEqual(readdirSync(target), ['exclude']);
  assert.deepEqual(readFileSync(join(target, 'exclude')), bytes);
});

test('ignorePool returns failed and creates nothing at the target of a dangling .git/info link', POSIX_ONLY, () => {
  const { repo, outside, target } = repoWithLinkedInfo({ withExclude: false });
  assert.deepEqual(ignorePool(repo), { outcome: 'failed', path: excludePath(repo), why: linkedInfoWhy(repo) });
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(outside), []);
});

test('a claim in a repo whose .git/info links outside it still succeeds, names the link on the failed line and leaves the outside exclude alone', POSIX_ONLY, () => {
  const { repo, target, bytes } = repoWithLinkedInfo({ withExclude: true });
  const result = claim(repo, 'lane/a', head(repo), claimEnv());
  assert.equal(result.status, 0, result.stderr);
  const failedLines = result.stderr.split('\n').filter((line) => line.startsWith('git-tidy: lane folders show in git status'));
  assert.deepEqual(failedLines, [`git-tidy: lane folders show in git status of ${repo} (${linkedInfoWhy(repo)}): land refuses there until git ignores .claude/worktrees/`]);
  assert.deepEqual(readdirSync(target), ['exclude']);
  assert.deepEqual(readFileSync(join(target, 'exclude')), bytes);
});
