// Tests of land's pool-lane clean-up and land ledger (home/tools/land/land.mjs, ledger.mjs; boss-integrator design, U13): a lane
// claimed from the pool is kept as a free folder, a lane outside the pool is removed as before, each landing appends one ledger line,
// and a ledger that cannot be written or a nested repository in the lane's folder stops nothing it should not.
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs) and every child gets its own temp HOME, so
// the ledger goes to <HOME>/.claude/state/land/ there and never to the real ~/.claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, lines, makeRepo } from './git-tidy-helpers.mjs';
import { claim, lane, laneEnv, poolPath } from './git-tidy-lane-pool-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'lane/x';
const LEDGER_FIELDS = ['at', 'repo', 'branch', 'from', 'to', 'commits'];
const REPO_KEY_HEX = 16; // the design's <repo-key>: the first 16 hex of the sha256 of the real git common dir
const FULL_SHA = /^[0-9a-f]{40}$/;
const NESTED_FOLDER = 'scratch'; // ignored by the repo's .gitignore, so git status of the worktree stays empty
const POOL_IGNORE = '.claude/'; // the pool folders live in <repo>/.claude/worktrees; a real project ignores them, or the base is dirty

/** Runs land.mjs with `args` from `cwd`, with `home` as HOME and USERPROFILE (where the ledger goes). */
const landWith = (home, args, cwd) =>
  spawnSync(process.execPath, [LAND, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, HOME: home, USERPROFILE: home } });

const makeHome = () => realpathSync(makeTempDir('land-pool-home-'));
const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');
const isDetached = (dir) => spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: dir, env: CLEAN_ENV }).status === 1;
const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;

/** The ledger file the design names for `repo`: <home>/.claude/state/land/<first 16 hex of sha256(real git common dir)>.jsonl. */
function ledgerFile(home, repo) {
  const commonDir = realpathSync.native(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const key = createHash('sha256').update(commonDir).digest('hex').slice(0, REPO_KEY_HEX);
  return join(home, '.claude', 'state', 'land', `${key}.jsonl`);
}

/** The non-empty lines of the ledger, as written; [] when there is no file. */
function ledgerLines(home, repo) {
  const file = ledgerFile(home, repo);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
}

/** A repo that ignores the pool folders (and `extraIgnored`), as a project that uses lane folders does. */
function poolRepo(...extraIgnored) {
  const repo = makeRepo();
  commit(repo, '.gitignore', [POOL_IGNORE, ...extraIgnored].join('\n') + '\n');
  return repo;
}

/** A repo whose lane/x is claimed from the pool (own env, own HOME) and holds one commit, while main moved on by one commit. */
function poolLaneBehindMain() {
  const repo = poolRepo();
  const env = laneEnv();
  const baseBefore = headOf(repo);
  assert.equal(claim(repo, LANE, baseBefore, env).status, 0);
  const folder = poolPath(repo, 1);
  commit(folder, 'lane.txt');
  commit(repo, 'other.txt');
  return { repo, env, folder, laneBase: baseBefore, mainBefore: headOf(repo) };
}

/** A repo whose lane/x is a plain `git worktree add` folder (outside the pool) with one commit; main has not moved. */
function plainLane() {
  const repo = makeRepo();
  const folder = addWorktree(repo, 'plain-lane', LANE);
  commit(folder, 'lane.txt');
  return { repo, folder, mainBefore: headOf(repo) };
}

test('a landed pool lane is kept: main fast-forwarded, branch gone, folder detached at main, clean, and listed free', () => {
  const { repo, env, folder, mainBefore } = poolLaneBehindMain();
  const result = landWith(env.HOME, [LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  const mainNow = headOf(repo);
  assert.notEqual(mainNow, mainBefore, 'main moved');
  assert.equal(git(repo, 'merge-base', mainBefore, mainNow), mainBefore, 'main only moved forward from where it was');
  assert.equal(git(repo, 'log', '--merges', '--oneline', 'main'), '', 'no merge commit');
  assert.equal(branchExists(repo, LANE), false, 'the lane branch is deleted');
  assert.ok(existsSync(folder), 'the pool folder is kept');
  assert.equal(isDetached(folder), true, 'the folder is detached');
  assert.equal(headOf(folder), mainNow, "the folder is at main's new sha");
  assert.equal(git(folder, 'status', '--porcelain'), '');
  assert.ok(lines(result).includes(`lane folder ${folder} detached at ${mainNow} (kept for the next lane)`), result.stdout);
  assert.match(lines(lane(['list', '--repo', repo], env))[0], /^lane-1 free detached at /);
});

test('a landed pool lane adds exactly one valid ledger line: its fields, `from` the old main, `to` the new main', () => {
  const { repo, env, mainBefore } = poolLaneBehindMain();
  const before = Date.now();
  assert.equal(landWith(env.HOME, [LANE, '--repo', repo], repo).status, 0);
  const after = Date.now();
  const written = ledgerLines(env.HOME, repo);
  assert.equal(written.length, 1, written.join('\n'));
  const entry = JSON.parse(written[0]);
  assert.deepEqual(Object.keys(entry), LEDGER_FIELDS);
  assert.equal(entry.repo, realpathSync(repo));
  assert.equal(entry.branch, LANE);
  assert.equal(entry.from, mainBefore);
  assert.equal(entry.to, headOf(repo), "`to` is main's sha");
  assert.match(entry.to, FULL_SHA);
  assert.equal(entry.commits, 1);
  const writtenAt = Date.parse(entry.at);
  assert.ok(writtenAt >= before - 1000 && writtenAt <= after + 1000, `at ${entry.at} is the time of the landing`);
});

test('a second landing appends a second ledger line and keeps the first as it was', () => {
  const { repo, env } = poolLaneBehindMain();
  assert.equal(landWith(env.HOME, [LANE, '--repo', repo], repo).status, 0);
  const [first] = ledgerLines(env.HOME, repo);
  assert.equal(claim(repo, 'lane/y', headOf(repo), env).status, 0);
  commit(poolPath(repo, 1), 'second.txt');
  assert.equal(landWith(env.HOME, ['lane/y', '--repo', repo], repo).status, 0);
  const written = ledgerLines(env.HOME, repo);
  assert.equal(written.length, 2, written.join('\n'));
  assert.equal(written[0], first);
  assert.equal(JSON.parse(written[1]).branch, 'lane/y');
  assert.equal(JSON.parse(written[1]).to, headOf(repo));
});

test('a land that is refused before the fast-forward writes no ledger line', () => {
  const repo = poolRepo();
  const env = laneEnv();
  assert.equal(claim(repo, LANE, headOf(repo), env).status, 0);
  commit(poolPath(repo, 1), 'base.txt', 'lane side');
  commit(repo, 'base.txt', 'main side');
  const mainBefore = headOf(repo);
  const result = landWith(env.HOME, [LANE, '--repo', repo], repo);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /the rebase of lane\/x onto main stopped/);
  assert.equal(headOf(repo), mainBefore);
  assert.deepEqual(ledgerLines(env.HOME, repo), []);
});

test('a lane outside the pool is still removed with its branch after landing', () => {
  const { repo, folder, mainBefore } = plainLane();
  const home = makeHome();
  const result = landWith(home, [LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(headOf(repo), mainBefore, 'main moved');
  assert.equal(existsSync(folder), false, 'the worktree folder is removed');
  assert.equal(branchExists(repo, LANE), false);
  assert.ok(lines(result).includes(`removed worktree ${folder}`), result.stdout);
  assert.equal(ledgerLines(home, repo).length, 1, 'a lane outside the pool is in the ledger too');
});

test('a ledger that cannot be written is one warning line: the landing stands and exits 0', () => {
  const { repo, folder, mainBefore } = plainLane();
  const home = makeHome();
  writeFileSync(join(home, '.claude'), 'a file where the ledger folder should be');
  const result = landWith(home, [LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  const warnings = lines({ stdout: result.stderr });
  assert.equal(warnings.length, 1, result.stderr);
  assert.match(warnings[0], /^land: the ledger line of lane\/x was not written \(/);
  assert.notEqual(headOf(repo), mainBefore, 'main moved');
  assert.equal(headOf(repo), git(repo, 'rev-parse', 'main'));
  assert.equal(existsSync(folder), false, 'the clean-up went on');
  assert.equal(branchExists(repo, LANE), false);
  assert.match(result.stdout, /^landed lane\/x on main at [0-9a-f]{40} \(1 commit\(s\)\)$/m);
});

/** Makes a git repository with one commit at <folder>/scratch; returns `{ nested, nestedCommit }`. */
function addNestedRepo(folder) {
  const nested = join(folder, NESTED_FOLDER);
  mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  const nestedCommit = commit(nested, 'patch.txt', 'my patch to the dependency\n');
  assert.equal(git(folder, 'status', '--porcelain'), '', 'precondition: the nested repository is invisible to the lane');
  return { nested, nestedCommit };
}

test('a plain lane folder holding a nested repository with its own commit is refused at the clean-up: the repository and its commit stay', () => {
  const repo = makeRepo();
  commit(repo, '.gitignore', `${NESTED_FOLDER}/\n`);
  const folder = addWorktree(repo, 'plain-lane', LANE);
  const laneTip = commit(folder, 'lane.txt');
  const { nested, nestedCommit } = addNestedRepo(folder);
  const result = landWith(makeHome(), [LANE, '--repo', repo], repo);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`${NESTED_FOLDER}.+may hold the only copy of its commits`), result.stderr);
  assert.equal(headOf(nested), nestedCommit, 'the nested commit is still readable');
  assert.ok(existsSync(join(nested, '.git')), 'the nested repository is still there');
  assert.ok(existsSync(folder), 'the lane worktree is kept');
  assert.equal(git(repo, 'rev-parse', `refs/heads/${LANE}`), laneTip, 'the lane branch is kept');
});

test('a pool lane folder holding a nested repository is detached and kept, with the repository and its commit untouched', () => {
  const repo = poolRepo(`${NESTED_FOLDER}/`);
  const env = laneEnv();
  assert.equal(claim(repo, LANE, headOf(repo), env).status, 0);
  const folder = poolPath(repo, 1);
  commit(folder, 'lane.txt');
  const { nested, nestedCommit } = addNestedRepo(folder);
  const result = landWith(env.HOME, [LANE, '--repo', repo], repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(headOf(nested), nestedCommit, 'the nested commit is still readable');
  assert.ok(existsSync(join(nested, '.git')), 'the nested repository is still there');
  assert.equal(headOf(folder), headOf(repo), 'the folder is detached at the landed main');
  assert.equal(isDetached(folder), true);
});
