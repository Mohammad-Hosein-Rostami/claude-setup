// Tests for the test gate of home/tools/land/land.mjs (--test, --test-timeout, run-test.mjs): when the base and the lane both
// changed a file, the rebased tip must pass a test before the base moves; a failing, hung or racing test leaves the base unmoved.
// Every repository is a throw-away one in the OS temp folder (git-tidy-helpers.mjs: no user git config, private HOME). Each test
// command is a small node script written next to the repo (outside both checkouts), so it runs the same under sh and cmd.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, addWorktree, commit, git, makeRepo, snapshot } from './git-tidy-helpers.mjs';

const LAND = fileURLToPath(new URL('../home/tools/land/land.mjs', import.meta.url));
const LANE = 'feat/lane';
const SHARED = 'shared.txt';
const BASE_LINES = ['one', 'two', 'three', 'four', 'five'];
// The lane edits the first line and the base the last, so the rebase merges both without a textual conflict.
const LANE_LINES = ['lane one', ...BASE_LINES.slice(1)];
const MOVED_BASE_LINES = [...BASE_LINES.slice(0, -1), 'base five'];
const MERGED_LINES = ['lane one', ...BASE_LINES.slice(1, -1), 'base five'];
// Commands both sh and cmd run as typed.
const PASS = 'exit 0';
const FAIL = 'exit 1';
// npm must not ask the registry whether it is up to date: the tests run without the network.
const NPM_OFFLINE = { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
// run-test.mjs shows this many of the last output lines of a failed test.
const TAIL_LINES = 40;
const PRINTED_LINES = 60;
// describeOverlap lists this many files and counts the rest.
const LISTED_FILES = 20;
// The hung test's deadline, and how long its killed processes may take to be gone.
const HANG_TIMEOUT_SECONDS = 1;
const HANG_EXIT_WITHIN_MS = 8000;
const DEATH_WAIT_MS = 2000;
const POLL_MS = 50;

const land = (args, { cwd, env = {}, timeout } = {}) =>
  spawnSync(process.execPath, [LAND, ...args], { cwd, encoding: 'utf8', env: { ...CLEAN_ENV, ...env }, timeout });
const branchExists = (repo, name) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo, env: CLEAN_ENV }).status === 0;
const text = (lines) => lines.map((line) => `${line}\n`).join('');
const heads = (repo) => [git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', LANE)];
const outputLines = (output) => output.split(/\r?\n/).filter((line) => line !== '');

/** Writes every `{ name: text }` file in `dir` and commits them in one commit; returns the full hash. */
function commitFiles(dir, files, message) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** `names` mapped to the same text, for commitFiles. */
const allWith = (names, content) => Object.fromEntries(names.map((name) => [name, content]));

/**
 * A repo where the base and the lane (own worktree) both changed `files` since the lane branched: the lane edits line 1 of each,
 * then the base edits line 5. `laneFirst` adds lane commits before that (such as a package.json), so the base never touches them.
 */
function overlapRepo({ files = [SHARED], laneFirst = {} } = {}) {
  const repo = makeRepo();
  commitFiles(repo, allWith(files, text(BASE_LINES)), 'add the shared files');
  const worktree = addWorktree(repo, 'lane', LANE);
  if (Object.keys(laneFirst).length > 0) commitFiles(worktree, laneFirst, 'lane setup');
  commitFiles(worktree, allWith(files, text(LANE_LINES)), 'lane edits line 1');
  commitFiles(repo, allWith(files, text(MOVED_BASE_LINES)), 'base edits line 5');
  return { repo, worktree };
}

/** A repo whose lane (own worktree, one commit) is behind a base that moved on by one commit in another file. */
function laneBehindBase() {
  const repo = makeRepo();
  const worktree = addWorktree(repo, 'lane', LANE);
  commit(worktree, 'lane.txt', 'lane');
  commit(repo, 'other.txt', 'other');
  return { repo, worktree };
}

/** Writes `source` as a script next to `repo` and returns the shell command that runs it with this node. */
function scriptCommand(repo, name, source) {
  const path = join(repo, '..', name);
  writeFileSync(path, source);
  return `"${process.execPath}" "${path}"`;
}

/** A test command that writes the sha of HEAD in its working folder to `out`, then exits 0. */
function recordHeadCommand(repo, out) {
  return scriptCommand(repo, 'record-head.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(out)}, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());`,
  ].join('\n'));
}

/** A test command that prints PRINTED_LINES numbered lines (out-01 ...) and exits 1. */
function printThenFailCommand(repo) {
  return scriptCommand(repo, 'print-then-fail.mjs', [
    `for (let i = 1; i <= ${PRINTED_LINES}; i += 1) console.log(\`out-\${String(i).padStart(2, '0')}\`);`,
    // exitCode, not exit(): stdout to a pipe is written asynchronously, so exit() could cut the lines short.
    'process.exitCode = 1;',
  ].join('\n'));
}

const printedLine = (i) => `out-${String(i).padStart(2, '0')}`;

/** True while a process with `pid` exists. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Waits up to DEATH_WAIT_MS for every pid to be gone (a killed orphan is reaped by init shortly after); returns the living. */
function waitForDeath(pids) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + DEATH_WAIT_MS;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    Atomics.wait(pause, 0, 0, POLL_MS);
    alive = alive.filter(isAlive);
  }
  return alive;
}

/** Asserts the lane was rebased onto the unmoved base and nothing landed: base at `base`, lane built on it, all kept. */
function assertRebasedNotLanded(repo, worktree, base) {
  assert.equal(git(repo, 'rev-parse', 'main'), base, 'the base did not move');
  assert.equal(git(repo, 'merge-base', 'main', LANE), base, 'the lane is rebased onto the base');
  assert.notEqual(git(repo, 'rev-parse', LANE), base, 'the lane still has its own commits');
  assert.ok(existsSync(worktree), 'the worktree is kept');
  assert.ok(branchExists(repo, LANE), 'the branch is kept');
}

test('overlapping files with a passing --test land the sha the test saw, after listing the files', () => {
  const { repo, worktree } = overlapRepo();
  const seen = join(repo, '..', 'seen-head.txt');
  const command = recordHeadCommand(repo, seen);
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.equal(readFileSync(seen, 'utf8'), tip, 'the test ran on the sha that landed');
  assert.deepEqual(outputLines(result.stdout), [
    `main and ${LANE} both changed 1 file(s) since ${LANE} branched:`,
    `  ${SHARED}`,
    `testing ${tip} in ${worktree}: ${command}`,
    `test passed on ${tip}`,
    `landed ${LANE} on main at ${tip} (1 commit(s))`,
    `removed worktree ${worktree}`,
    `deleted branch ${LANE}`,
  ]);
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MERGED_LINES), 'both edits are in the landed file');
  assert.equal(git(repo, 'log', '--merges', '--oneline', 'main'), '', 'no merge commit');
  assert.equal(git(repo, 'rev-list', '--count', 'main'), '4', 'base, shared file, base edit and the rebased lane edit on one line');
  assert.equal(existsSync(worktree), false);
  assert.equal(branchExists(repo, LANE), false);
});

test('overlapping files with no --test and no package.json are refused with the files and the --test fix; the lane is left rebased', () => {
  const { repo, worktree } = overlapRepo();
  const [base] = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  ${SHARED}\n`), result.stderr);
  assert.ok(result.stderr.includes(`the lane has no package.json test script; nothing landed: main did not move and ${LANE} is rebased onto it`), result.stderr);
  assert.ok(result.stderr.includes(`node ~/.claude/tools/land/land.mjs ${LANE} --repo ${repo} --test "<test command>"`), result.stderr);
  assertRebasedNotLanded(repo, worktree, base);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
});

test('overlapping files with no --test run the lane package.json test script: exit 0 lands, exit 1 refuses', () => {
  const passing = overlapRepo({ laneFirst: { 'package.json': JSON.stringify({ scripts: { test: PASS } }) } });
  const landed = land([LANE, '--repo', passing.repo], { cwd: passing.repo, env: NPM_OFFLINE });
  assert.equal(landed.status, 0, landed.stderr);
  const tip = git(passing.repo, 'rev-parse', 'main');
  assert.ok(landed.stdout.includes(`testing ${tip} in ${passing.worktree}: npm test\n`), landed.stdout);
  assert.ok(landed.stdout.includes(`test passed on ${tip}\nlanded ${LANE} on main at ${tip}`), landed.stdout);
  assert.equal(branchExists(passing.repo, LANE), false);

  const failing = overlapRepo({ laneFirst: { 'package.json': JSON.stringify({ scripts: { test: FAIL } }) } });
  const [base] = heads(failing.repo);
  const refused = land([LANE, '--repo', failing.repo], { cwd: failing.repo, env: NPM_OFFLINE });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /^land: the test of [0-9a-f]{40} failed \(exit 1\): npm test\. Nothing landed/);
  assertRebasedNotLanded(failing.repo, failing.worktree, base);
});

test('a package.json with no test script, an empty one or invalid JSON does not count as a test: refused, base unmoved', () => {
  const fixLine = `--test "<test command>"`;
  for (const [label, manifest] of [
    ['no test script', JSON.stringify({ scripts: { build: PASS } })],
    ['an empty test script', JSON.stringify({ scripts: { test: '  ' } })],
  ]) {
    const { repo, worktree } = overlapRepo({ laneFirst: { 'package.json': manifest } });
    const [base] = heads(repo);
    const result = land([LANE, '--repo', repo], { cwd: repo, env: NPM_OFFLINE });
    assert.equal(result.status, 1, label);
    assert.ok(result.stderr.includes('the lane has no package.json test script') && result.stderr.includes(fixLine), `${label}: ${result.stderr}`);
    assertRebasedNotLanded(repo, worktree, base);
  }
  const { repo, worktree } = overlapRepo({ laneFirst: { 'package.json': '{ "scripts": ' } });
  const [base] = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo, env: NPM_OFFLINE });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith(`land: cannot read ${join(worktree, 'package.json')} (`), result.stderr);
  assert.ok(result.stderr.includes(`name the test with ${fixLine.replace('<test command>', '<command>')}`), result.stderr);
  assertRebasedNotLanded(repo, worktree, base);
});

test('a failing --test is refused with its exit code and only its last 40 output lines, after the overlap list', () => {
  const { repo, worktree } = overlapRepo();
  const [base] = heads(repo);
  const command = printThenFailCommand(repo);
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tip = git(repo, 'rev-parse', LANE);
  assert.ok(result.stderr.startsWith(`land: the test of ${tip} failed (exit 1): ${command}. Nothing landed: main did not move and ${LANE} is left rebased in ${worktree}`), result.stderr);
  const shown = outputLines(result.stderr);
  const tailStart = shown.indexOf(`last ${TAIL_LINES} line(s) of the test output:`);
  assert.notEqual(tailStart, -1, result.stderr);
  const expected = Array.from({ length: TAIL_LINES }, (_, i) => printedLine(PRINTED_LINES - TAIL_LINES + 1 + i));
  assert.deepEqual(shown.slice(tailStart + 1), expected, 'exactly the last 40 lines, in order');
  assert.equal(shown.includes(printedLine(PRINTED_LINES - TAIL_LINES)), false, 'the line before the last 40 is not shown');
  assert.equal(shown.includes(printedLine(1)), false);
  // The overlap list is printed even though the test then failed.
  assert.deepEqual(outputLines(result.stdout), [
    `main and ${LANE} both changed 1 file(s) since ${LANE} branched:`,
    `  ${SHARED}`,
    `testing ${tip} in ${worktree}: ${command}`,
  ]);
  assertRebasedNotLanded(repo, worktree, base);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
});

test('with no overlap, no --test lands without testing, a passing --test lands and a failing one is refused', () => {
  const plain = laneBehindBase();
  const untested = land([LANE, '--repo', plain.repo], { cwd: plain.repo });
  assert.equal(untested.status, 0, untested.stderr);
  const plainTip = git(plain.repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(untested.stdout), [`landed ${LANE} on main at ${plainTip} (1 commit(s))`, `removed worktree ${plain.worktree}`, `deleted branch ${LANE}`]);

  const passing = laneBehindBase();
  const tested = land([LANE, '--repo', passing.repo, '--test', PASS], { cwd: passing.repo });
  assert.equal(tested.status, 0, tested.stderr);
  const tip = git(passing.repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(tested.stdout), [
    `testing ${tip} in ${passing.worktree}: ${PASS}`,
    `test passed on ${tip}`,
    `landed ${LANE} on main at ${tip} (1 commit(s))`,
    `removed worktree ${passing.worktree}`,
    `deleted branch ${LANE}`,
  ]);

  const failing = laneBehindBase();
  const [base] = heads(failing.repo);
  const refused = land([LANE, '--repo', failing.repo, '--test', FAIL], { cwd: failing.repo });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /^land: the test of [0-9a-f]{40} failed \(exit 1\): exit 1\. Nothing landed/);
  assert.match(refused.stderr, /the test printed nothing/);
  assertRebasedNotLanded(failing.repo, failing.worktree, base);
});

test('a test that hangs past --test-timeout is killed with the processes it started, and nothing lands', () => {
  const { repo, worktree } = overlapRepo();
  const [base] = heads(repo);
  const pidFile = join(repo, '..', 'hang-pids.json');
  // The grandchild inherits the pipes, so it would keep them open after its parent is gone if it were not killed too.
  const command = scriptCommand(repo, 'hang.mjs', [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, grandchild.pid]));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const started = Date.now();
  const result = land([LANE, '--repo', repo, '--test', command, '--test-timeout', String(HANG_TIMEOUT_SECONDS)], { cwd: repo, timeout: HANG_EXIT_WITHIN_MS });
  const elapsed = Date.now() - started;
  const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : [];
  try {
    assert.equal(result.error, undefined, `land did not exit within ${HANG_EXIT_WITHIN_MS} ms`);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(elapsed < HANG_EXIT_WITHIN_MS, `land took ${elapsed} ms`);
    assert.match(result.stderr, new RegExp(`^land: the test of [0-9a-f]{40} failed \\(did not finish within ${HANG_TIMEOUT_SECONDS} s; its processes were killed\\)`));
    assert.equal(pids.length, 2, 'the hung test wrote its own pid and its grandchild pid');
    assert.deepEqual(waitForDeath(pids), [], 'the test and its grandchild are gone');
    assertRebasedNotLanded(repo, worktree, base);
  } finally {
    // Never leave a hung process behind when an assertion above failed.
    for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
  }
});

test('a lane that moves during the test is refused: the base does not move and nothing is removed', () => {
  const { repo, worktree } = overlapRepo();
  const [base] = heads(repo);
  const command = scriptCommand(repo, 'move-lane.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('moved.txt', 'moved\\n');",
    "execFileSync('git', ['add', 'moved.txt']);",
    "execFileSync('git', ['commit', '-q', '-m', 'commit during the test']);",
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const moved = git(repo, 'rev-parse', LANE);
  const tested = git(repo, 'rev-parse', `${LANE}^`);
  assert.ok(result.stderr.startsWith(`land: ${LANE} moved during the test (from ${tested} to ${moved}), so the tested sha is not its tip; nothing landed`), result.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), base, 'the base did not move');
  assert.equal(git(repo, 'rev-parse', `${tested}^`), base, 'the tested sha was the rebased tip');
  assert.ok(existsSync(worktree));
  assert.ok(branchExists(repo, LANE));
});

test('an empty --test, a missing value and a --test-timeout that is not a whole number above 0 are usage errors that change nothing', () => {
  const { repo, worktree } = overlapRepo();
  const before = snapshot(repo, worktree);
  const usage = /usage: node ~\/\.claude\/tools\/land\/land\.mjs <branch> \[--repo <path>\] \[--test <command>\] \[--test-timeout <seconds>\]/;
  const lane = [LANE, '--repo', repo];
  const cases = [
    [[...lane, '--test', ''], /^--test needs a command\n/],
    [[...lane, '--test', '   '], /^--test needs a command\n/],
    [[...lane, '--test'], /^--test needs a command\n/],
    [[...lane, '--test', PASS, '--test-timeout'], /^--test-timeout needs a number of seconds\n/],
  ];
  for (const value of ['0', '-1', 'abc', '1.5', '1e3', '']) {
    cases.push([[...lane, '--test', PASS, '--test-timeout', value], new RegExp(`^--test-timeout needs a whole number of seconds above 0, not "${value.replace('.', '\\.')}"\\n`)]);
  }
  for (const [args, message] of cases) {
    const result = land(args, { cwd: repo });
    const label = JSON.stringify(args.slice(lane.length));
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, message, label);
    assert.match(result.stderr, usage, label);
    assert.equal(result.stdout, '', label);
    assert.equal(snapshot(repo, worktree), before, `${label} changed nothing`);
  }
});

test('overlapping files on a branch with no worktree are refused, since the test needs one; without overlap it still lands', () => {
  const { repo, worktree } = overlapRepo();
  git(repo, 'worktree', 'remove', worktree);
  const [base] = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`a test must run on the rebased tip, in the lane's worktree, and ${LANE} has none`), result.stderr);
  assert.ok(result.stderr.includes(`git worktree add <folder> ${LANE}`), result.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), base, 'the base did not move');
  assert.ok(branchExists(repo, LANE));
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the base checkout is back on the base');
  assert.equal(git(repo, 'status', '--porcelain'), '');

  // Regression guard: the same shape with no overlap and no --test lands as before.
  const plain = laneBehindBase();
  git(plain.repo, 'worktree', 'remove', plain.worktree);
  const landed = land([LANE, '--repo', plain.repo], { cwd: plain.repo });
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /^landed feat\/lane on main at [0-9a-f]{40} \(1 commit\(s\)\)\ndeleted branch feat\/lane\n$/);
});

test('a lane with no commit in common with the base is refused before anything changes', () => {
  const repo = makeRepo();
  const worktree = addWorktree(repo, 'lane', LANE);
  writeFileSync(join(worktree, 'orphan.txt'), 'orphan');
  git(worktree, 'add', '--', 'orphan.txt');
  const root = git(worktree, 'commit-tree', git(worktree, 'write-tree'), '-m', 'a root commit of its own');
  git(worktree, 'reset', '-q', '--hard', root);
  commit(repo, 'other.txt');
  const before = heads(repo);
  const result = land([LANE, '--repo', repo, '--test', PASS], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: ${LANE} has no commit in common with main, so land cannot tell which files both changed`), result.stderr);
  assert.deepEqual(heads(repo), before, 'neither the base nor the lane moved');
  assert.ok(existsSync(worktree));
});

test('a file the base renamed while the lane edited it counts as overlap', () => {
  const repo = makeRepo();
  commitFiles(repo, { 'old.txt': text(BASE_LINES) }, 'add old.txt');
  const worktree = addWorktree(repo, 'lane', LANE);
  commitFiles(worktree, { 'old.txt': text(LANE_LINES) }, 'lane edits old.txt');
  git(repo, 'mv', 'old.txt', 'new.txt');
  git(repo, 'commit', '-q', '-m', 'base renames old.txt');
  const [base] = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  old.txt\nso the rebased tip`), result.stderr);
  assertRebasedNotLanded(repo, worktree, base);
});

test('a file the lane renamed while the base edited it counts as overlap', () => {
  const repo = makeRepo();
  commitFiles(repo, { 'old.txt': text(BASE_LINES) }, 'add old.txt');
  const worktree = addWorktree(repo, 'lane', LANE);
  git(worktree, 'mv', 'old.txt', 'new.txt');
  git(worktree, 'commit', '-q', '-m', 'lane renames old.txt');
  commitFiles(repo, { 'old.txt': text(MOVED_BASE_LINES) }, 'base edits old.txt');
  const [base] = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  old.txt\nso the rebased tip`), result.stderr);
  assertRebasedNotLanded(repo, worktree, base);
});

test('an overlapping path with spaces is listed as it is', () => {
  const spaced = 'my file.txt';
  const { repo } = overlapRepo({ files: [spaced] });
  const result = land([LANE, '--repo', repo, '--test', PASS], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outputLines(result.stdout).slice(0, 2), [`main and ${LANE} both changed 1 file(s) since ${LANE} branched:`, `  ${spaced}`]);
});

test('more than 20 overlapping files list the first 20, sorted, and count the rest', () => {
  const extra = 3;
  const names = Array.from({ length: LISTED_FILES + extra }, (_, i) => `f${String(i + 1).padStart(2, '0')}.txt`);
  const { repo } = overlapRepo({ files: [...names].reverse() });
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const shown = outputLines(result.stderr);
  assert.deepEqual(shown.slice(0, LISTED_FILES + 2), [
    `land: main and ${LANE} both changed ${names.length} file(s) since ${LANE} branched:`,
    ...names.slice(0, LISTED_FILES).map((name) => `  ${name}`),
    `  ... and ${extra} more`,
  ]);
  assert.equal(shown.includes(`  ${names[LISTED_FILES]}`), false, 'the 21st file is counted, not listed');
});

test('a test that leaves an untracked file in the lane worktree: the tested sha lands, and the clean-up stops at that worktree', () => {
  const { repo, worktree } = overlapRepo();
  const tested = join(repo, '..', 'dirty-lane-head.txt');
  const command = scriptCommand(repo, 'dirty-lane.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(tested)}, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());`,
    "writeFileSync('test-artifact.txt', 'left by the test');",
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  const tip = git(repo, 'rev-parse', 'main');
  assert.equal(readFileSync(tested, 'utf8'), tip, 'what landed is the tested sha');
  assert.ok(result.stdout.includes(`test passed on ${tip}\nlanded ${LANE} on main at ${tip} (1 commit(s))\n`), result.stdout);
  // README: exit 1 also covers "a clean-up step that failed after landing"; git worktree remove keeps a folder with an untracked file.
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.startsWith(`land: ${LANE} landed on main at ${tip}, but the clean-up stopped:`), result.stderr);
  assert.ok(existsSync(join(worktree, 'test-artifact.txt')), 'the untracked file is not deleted');
});

test('a test that edits the base checkout is refused after the test: the base does not move', () => {
  const { repo, worktree } = overlapRepo();
  const [base] = heads(repo);
  const command = scriptCommand(repo, 'dirty-base.mjs', [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(join(repo, 'stray.txt'))}, 'written during the test');`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tip = git(repo, 'rev-parse', LANE);
  assert.ok(result.stdout.includes(`test passed on ${tip}\n`), result.stdout);
  assert.ok(result.stderr.startsWith(`land: the base checkout (${repo}) has 1 changed or untracked file(s); commit or move them first`), result.stderr);
  assert.equal(result.stdout.includes('landed '), false);
  assertRebasedNotLanded(repo, worktree, base);
});
