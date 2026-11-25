// Tests for the test gate of home/tools/land/land.mjs (--test, --test-timeout, run-test.mjs): when the base and the lane both
// changed a file, the rebased tip must pass a test before the base moves; a failing, hung or racing test leaves the base unmoved
// and the lane's branch where it was, so the next land asks for the test again.
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
// What a base commit made during the test writes: the base's file with line 3 edited too.
const BASE_MOVED_AGAIN_LINES = ['one', 'two', 'base three', 'four', 'base five'];
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
// No clock assert: a passing test's leftover process must not make land wait, and land waiting shows as a land that does not exit.
// So the three values are ordered, not measured: a run that works takes about the 2 s output drain of run-test.mjs, so the spawn
// timeout (a hang guard, not a speed bound) is far above that; a land that waits for the leftover process or for the deadline
// outlasts the spawn timeout, since the leftover process lives longer and the --test-timeout is longer still.
const BACKGROUND_EXIT_WITHIN_MS = 30_000;
const BACKGROUND_MS = 60_000;
const BACKGROUND_TIMEOUT_SECONDS = 120;
// The README's longest --test-timeout: 2^31 - 1 ms, the longest a Node timer holds, in whole seconds.
const MAX_TIMEOUT_SECONDS = 2147483;

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


// How a passing test's background process is started: output to nowhere (`cmd >/dev/null 2>&1 &`), holding the test's output
// pipes, or holding them from a process group of its own, which land's kill of the test's group does not reach.
const BACKGROUND_KINDS = {
  quiet: { stdio: 'ignore' },
  'holds-output': { stdio: 'inherit' },
  'own-group': { stdio: 'inherit', detached: true },
};

/** A test command that starts a background node process of `kind` (BACKGROUND_KINDS), writes its pid to `pidFile` and exits 0
 * at once, leaving it running. */
function backgroundThenPassCommand(repo, pidFile, kind) {
  return scriptCommand(repo, `background-${kind}.mjs`, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const background = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${BACKGROUND_MS})'], ${JSON.stringify(BACKGROUND_KINDS[kind])});`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(background.pid));`,
    'background.unref();',
  ].join('\n'));
}

/** The sha land printed in its "testing <sha> in" line. */
function testedSha(stdout) {
  const match = /^testing ([0-9a-f]{40}) in /m.exec(stdout);
  assert.ok(match, `no testing line in: ${stdout}`);
  return match[1];
}

/**
 * Asserts a refusal left the lane as it was, so the next land asks again: the base and the lane's branch at `before` (from
 * heads), the worktree kept, back on the branch and clean.
 */
function assertLaneAsItWas(repo, worktree, before) {
  assert.deepEqual(heads(repo), before, 'neither the base nor the lane branch moved');
  assert.ok(existsSync(worktree), 'the worktree is kept');
  assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), LANE, 'the worktree is back on the branch');
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'the worktree is clean');
}

/** Asserts `tested` is the lane rebased onto the base at `base`: built on it and not the base itself. */
function assertRebasedOnto(repo, tested, base) {
  assert.equal(git(repo, 'merge-base', base, tested), base, 'the tested sha is built on the base');
  assert.notEqual(tested, base);
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
    'left: none',
  ]);
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MERGED_LINES), 'both edits are in the landed file');
  assert.equal(git(repo, 'log', '--merges', '--oneline', 'main'), '', 'no merge commit');
  assert.equal(git(repo, 'rev-list', '--count', 'main'), '4', 'base, shared file, base edit and the rebased lane edit on one line');
  assert.equal(existsSync(worktree), false);
  assert.equal(branchExists(repo, LANE), false);
});

test('overlapping files with no --test and no package.json are refused with the files and the --test fix; nothing changes', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  ${SHARED}\n`), result.stderr);
  assert.ok(result.stderr.includes('so the rebased tip must pass a test before it lands, and the lane has no package.json test script; nothing changed.'), result.stderr);
  assert.ok(result.stderr.includes(`node ~/.claude/tools/land/land.mjs ${LANE} --repo ${repo} --test "<test command>"`), result.stderr);
  assertLaneAsItWas(repo, worktree, before);
});

test('after an overlap refusal with no test, the next land with no test refuses again: the overlap is still seen', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const first = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(first.status, 1, first.stdout);
  const again = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(again.status, 1, again.stdout);
  assert.equal(again.stderr, first.stderr, 'the same files and the same fix');
  assert.ok(again.stderr.includes(`\n  ${SHARED}\n`), again.stderr);
  assertLaneAsItWas(repo, worktree, before);
});

test('after a failed --test the next land with no test refuses on the overlap, and one with a passing --test lands', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const failed = land([LANE, '--repo', repo, '--test', FAIL], { cwd: repo });
  assert.equal(failed.status, 1, failed.stdout);
  assertLaneAsItWas(repo, worktree, before);

  const untested = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(untested.status, 1, untested.stdout);
  assert.ok(untested.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  ${SHARED}\nso the rebased tip must pass a test`), untested.stderr);
  assertLaneAsItWas(repo, worktree, before);

  const passed = land([LANE, '--repo', repo, '--test', PASS], { cwd: repo });
  assert.equal(passed.status, 0, passed.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.equal(testedSha(passed.stdout), tip, 'the tested sha landed');
  assertRebasedOnto(repo, tip, before[0]);
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MERGED_LINES));
  assert.equal(branchExists(repo, LANE), false);
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
  const before = heads(failing.repo);
  const refused = land([LANE, '--repo', failing.repo], { cwd: failing.repo, env: NPM_OFFLINE });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /^land: the test of [0-9a-f]{40} failed \(exit 1\): npm test\. Nothing landed/);
  assertRebasedOnto(failing.repo, testedSha(refused.stdout), before[0]);
  assertLaneAsItWas(failing.repo, failing.worktree, before);
});

test('a package.json with no test script, an empty one or invalid JSON does not count as a test: refused, nothing changes', () => {
  const fixLine = `--test "<test command>"`;
  for (const [label, manifest] of [
    ['no test script', JSON.stringify({ scripts: { build: PASS } })],
    ['an empty test script', JSON.stringify({ scripts: { test: '  ' } })],
  ]) {
    const { repo, worktree } = overlapRepo({ laneFirst: { 'package.json': manifest } });
    const before = heads(repo);
    const result = land([LANE, '--repo', repo], { cwd: repo, env: NPM_OFFLINE });
    assert.equal(result.status, 1, label);
    assert.ok(result.stderr.includes('the lane has no package.json test script; nothing changed') && result.stderr.includes(fixLine), `${label}: ${result.stderr}`);
    assertLaneAsItWas(repo, worktree, before);
  }
  const { repo, worktree } = overlapRepo({ laneFirst: { 'package.json': '{ "scripts": ' } });
  const before = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo, env: NPM_OFFLINE });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith(`land: cannot read ${join(worktree, 'package.json')} (`), result.stderr);
  assert.ok(result.stderr.includes('; nothing changed. Name the test with --test "<command>"'), result.stderr);
  assertLaneAsItWas(repo, worktree, before);
});

test('a failing --test is refused with its exit code and only its last 40 output lines, after the overlap list', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const command = printThenFailCommand(repo);
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tip = testedSha(result.stdout);
  assertRebasedOnto(repo, tip, before[0]);
  assert.ok(result.stderr.startsWith(`land: the test of ${tip} failed (exit 1): ${command}. Nothing landed: main did not move and ${LANE} is as it was. To see the failure, rebase it (git rebase main in ${worktree}), fix it, then land again with --test`), result.stderr);
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
  assertLaneAsItWas(repo, worktree, before);
});

test('with no overlap, no --test lands without testing, a passing --test lands and a failing one is refused', () => {
  const plain = laneBehindBase();
  const untested = land([LANE, '--repo', plain.repo], { cwd: plain.repo });
  assert.equal(untested.status, 0, untested.stderr);
  const plainTip = git(plain.repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(untested.stdout), [`landed ${LANE} on main at ${plainTip} (1 commit(s))`, `removed worktree ${plain.worktree}`, `deleted branch ${LANE}`, 'left: none']);

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
    'left: none',
  ]);

  const failing = laneBehindBase();
  const before = heads(failing.repo);
  const refused = land([LANE, '--repo', failing.repo, '--test', FAIL], { cwd: failing.repo });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /^land: the test of [0-9a-f]{40} failed \(exit 1\): exit 1\. Nothing landed/);
  assert.match(refused.stderr, /the test printed nothing/);
  assertRebasedOnto(failing.repo, testedSha(refused.stdout), before[0]);
  assertLaneAsItWas(failing.repo, failing.worktree, before);
});

test('a test that hangs past --test-timeout is killed with the processes it started, and nothing lands', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
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
    assertLaneAsItWas(repo, worktree, before);
  } finally {
    // Never leave a hung process behind when an assertion above failed.
    for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
  }
});

test('a passing test leaves no background process behind, and one holding the output open does not make it time out', () => {
  for (const kind of ['quiet', 'holds-output']) {
    const { pids, result, repo } = landWithBackground(kind);
    try {
      assertPassedWithoutWaiting(kind, { result, repo });
      assert.equal(pids.length, 1, `${kind}: the test wrote the background pid`);
      assert.deepEqual(waitForDeath(pids), [], `${kind}: the background process did not outlive the test`);
    } finally {
      for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
    }
  }
});

test('a passing test whose background process holds the output from its own process group still passes without waiting for the deadline', () => {
  const { pids, result, repo } = landWithBackground('own-group');
  try {
    assertPassedWithoutWaiting('own-group', { result, repo });
    assert.equal(pids.length, 1, 'the test wrote the background pid');
  } finally {
    // Outside the test's group land does not kill it (README: the group is killed), so the test removes it.
    for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
  }
});

/** Lands a no-overlap lane with a --test that leaves a background process of `kind` and exits 0; returns what a test checks. */
function landWithBackground(kind) {
  const { repo } = laneBehindBase();
  const pidFile = join(repo, '..', `background-${kind}.pid`);
  const command = backgroundThenPassCommand(repo, pidFile, kind);
  const result = land([LANE, '--repo', repo, '--test', command, '--test-timeout', String(BACKGROUND_TIMEOUT_SECONDS)], { cwd: repo, timeout: BACKGROUND_EXIT_WITHIN_MS });
  const pids = existsSync(pidFile) ? [Number(readFileSync(pidFile, 'utf8'))] : [];
  return { pids, result, repo };
}

/** Asserts land exited (it did not wait for the background process or the deadline), passed the test and landed. */
function assertPassedWithoutWaiting(kind, { result, repo }) {
  assert.equal(result.error, undefined, `${kind}: land did not exit within ${BACKGROUND_EXIT_WITHIN_MS} ms`);
  assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
  assert.ok(result.stdout.includes(`test passed on ${git(repo, 'rev-parse', 'main')}\n`), `${kind}: ${result.stdout}`);
}

test('a commit made in the lane worktree during the test is refused: the worktree moved, and the lane is as it was', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const command = scriptCommand(repo, 'move-worktree.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('moved.txt', 'moved\\n');",
    "execFileSync('git', ['add', 'moved.txt']);",
    "execFileSync('git', ['commit', '-q', '-m', 'commit during the test']);",
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tested = testedSha(result.stdout);
  const match = new RegExp(`^land: the worktree of ${LANE} moved during the test \\(from ${tested} to ([0-9a-f]{40})\\), so the tested sha is not what would land; nothing landed, land again`).exec(result.stderr);
  assert.ok(match, result.stderr);
  assert.equal(git(repo, 'rev-parse', `${match[1]}^`), tested, 'the new commit is the one the test made on the tested sha');
  assertRebasedOnto(repo, tested, before[0]);
  assertLaneAsItWas(repo, worktree, before);
});

test('a lane branch moved by someone else during the test is refused, and the move is kept', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const movedTo = join(repo, '..', 'moved-to.txt');
  // An empty commit on the lane's own tip, as another worktree or tool would make it, while the test runs.
  const command = scriptCommand(repo, 'move-branch.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();",
    `const lane = git('rev-parse', 'refs/heads/${LANE}');`,
    "const moved = git('commit-tree', `${lane}^{tree}`, '-p', lane, '-m', 'moved during the test');",
    `git('update-ref', 'refs/heads/${LANE}', moved);`,
    `writeFileSync(${JSON.stringify(movedTo)}, moved);`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const moved = readFileSync(movedTo, 'utf8');
  assert.ok(result.stderr.startsWith(`land: ${LANE} moved during the test (from ${before[1]} to ${moved}); nothing landed, land again`), result.stderr);
  assertLaneAsItWas(repo, worktree, [before[0], moved]);
});

test('an empty --test, a missing value and a --test-timeout that is not a whole number from 1 to 2147483 are usage errors that change nothing', () => {
  const { repo, worktree } = overlapRepo();
  const before = snapshot(repo, worktree);
  const usage = /usage: node ~\/\.claude\/tools\/land\/land\.mjs <branch> \[--repo <path>\] \[--test <command>\] \[--test-timeout <seconds>\]/;
  const lane = [LANE, '--repo', repo];
  const cases = [
    [[...lane, '--test', ''], /^--test needs a command\n/],
    [[...lane, '--test', '   '], /^--test needs a command\n/],
    [[...lane, '--test'], /^--test needs a command\n/],
    [[...lane, '--test', PASS, '--test-timeout'], /^--test-timeout needs a number of seconds\n/],
    [[...lane, '--test', PASS, '--test-timeout', String(MAX_TIMEOUT_SECONDS + 1)],
      new RegExp(`^--test-timeout can be at most ${MAX_TIMEOUT_SECONDS} seconds \\(about 24 days\\), not ${MAX_TIMEOUT_SECONDS + 1}\\n`)],
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

test('the longest --test-timeout a timer holds (2147483 s) is accepted, and the test still runs and passes', () => {
  const { repo, worktree } = laneBehindBase();
  const result = land([LANE, '--repo', repo, '--test', PASS, '--test-timeout', String(MAX_TIMEOUT_SECONDS)], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const tip = git(repo, 'rev-parse', 'main');
  assert.deepEqual(outputLines(result.stdout).slice(0, 3), [`testing ${tip} in ${worktree}: ${PASS}`, `test passed on ${tip}`, `landed ${LANE} on main at ${tip} (1 commit(s))`]);
});

test('overlapping files on a branch with no worktree are refused before anything changes; without overlap it still lands', () => {
  const { repo, worktree } = overlapRepo();
  git(repo, 'worktree', 'remove', worktree);
  const before = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes(`a test must run on the rebased tip, in the lane's worktree, and ${LANE} has none; nothing changed`), result.stderr);
  assert.ok(result.stderr.includes(`git worktree add <folder> ${LANE}`), result.stderr);
  assert.deepEqual(heads(repo), before, 'neither the base nor the lane moved');
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the base checkout is on the base');
  assert.equal(git(repo, 'status', '--porcelain'), '');

  // Regression guard: the same shape with no overlap and no --test lands as before.
  const plain = laneBehindBase();
  git(plain.repo, 'worktree', 'remove', plain.worktree);
  const landed = land([LANE, '--repo', plain.repo], { cwd: plain.repo });
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /^landed feat\/lane on main at [0-9a-f]{40} \(1 commit\(s\)\)\ndeleted branch feat\/lane\nleft: none\n$/);
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
  const before = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  old.txt\nso the rebased tip`), result.stderr);
  assertLaneAsItWas(repo, worktree, before);
});

test('a file the lane renamed while the base edited it counts as overlap', () => {
  const repo = makeRepo();
  commitFiles(repo, { 'old.txt': text(BASE_LINES) }, 'add old.txt');
  const worktree = addWorktree(repo, 'lane', LANE);
  git(worktree, 'mv', 'old.txt', 'new.txt');
  git(worktree, 'commit', '-q', '-m', 'lane renames old.txt');
  commitFiles(repo, { 'old.txt': text(MOVED_BASE_LINES) }, 'base edits old.txt');
  const before = heads(repo);
  const result = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  old.txt\nso the rebased tip`), result.stderr);
  assertLaneAsItWas(repo, worktree, before);
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

test('a test that edits a tracked file in the lane worktree is refused: nothing lands, the lane branch and the edit stay', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const edited = 'edited by the test\n';
  const command = scriptCommand(repo, 'edit-tracked.mjs', [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(SHARED)}, ${JSON.stringify(edited)});`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tip = testedSha(result.stdout);
  assertRebasedOnto(repo, tip, before[0]);
  assert.ok(result.stdout.includes(`test passed on ${tip}\n`), result.stdout);
  assert.equal(result.stdout.includes('landed '), false);
  const refusal = `land: the test changed tracked files in the worktree of ${LANE} (${worktree}), so what it tested is not the commit that would land; nothing landed. Undo the changes (git status there), make the test leave them alone, then land again`;
  // Recorded as land does it now; README step 4 says every refusal puts the worktree back on the branch, but the edited file
  // differs between the lane and the tested sha, so git switch refuses and the worktree is left detached at the tested sha.
  const leftDetached = `the worktree ${worktree} could not switch back to ${LANE} and is left detached at ${tip}; clean it, then run git switch ${LANE} there`;
  assert.deepEqual(outputLines(result.stderr), [refusal, leftDetached]);
  assert.deepEqual(heads(repo), before, 'neither the base nor the lane branch moved');
  assert.ok(existsSync(worktree), 'the worktree is kept');
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), tip);
  assert.equal(readFileSync(join(worktree, SHARED), 'utf8'), edited, 'the edit is left for the owner to undo');
  assert.equal(git(worktree, 'diff', '--name-only'), SHARED, 'only the edited file differs, and it is not staged');
  assert.equal(git(worktree, 'diff', '--cached', '--name-only'), '');
  assert.equal(readFileSync(join(repo, SHARED), 'utf8'), text(MOVED_BASE_LINES), 'the base checkout is untouched');
});

test('a test that edits the base checkout is refused after the test: nothing lands and the lane is as it was', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const command = scriptCommand(repo, 'dirty-base.mjs', [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(join(repo, 'stray.txt'))}, 'written during the test');`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tip = testedSha(result.stdout);
  assert.ok(result.stdout.includes(`test passed on ${tip}\n`), result.stdout);
  assert.ok(result.stderr.startsWith(`land: the base checkout (${repo}) has 1 changed or untracked file(s); commit or move them first`), result.stderr);
  assert.equal(result.stdout.includes('landed '), false);
  assertLaneAsItWas(repo, worktree, before);
});

test('a test that switches the base checkout to another branch is refused: the base does not move and the lane is as it was', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  const command = scriptCommand(repo, 'switch-base.mjs', [
    "import { execFileSync } from 'node:child_process';",
    `execFileSync('git', ['switch', '-q', '-c', 'elsewhere'], { cwd: ${JSON.stringify(repo)} });`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stdout.includes(`test passed on ${testedSha(result.stdout)}\n`), result.stdout);
  assert.ok(result.stderr.startsWith(`land: the base checkout (${repo}) left main during the test (HEAD is now refs/heads/elsewhere); nothing landed: check out main there, then land again`), result.stderr);
  assert.equal(git(repo, 'rev-parse', 'elsewhere'), before[0], 'nothing was merged into the branch the test switched to');
  assertLaneAsItWas(repo, worktree, before);
});

test('a base that moves after land read the overlap is refused at the fast-forward, and the next land asks for the test again', () => {
  const { repo, worktree } = overlapRepo();
  const before = heads(repo);
  // A commit on the base in the base checkout while the test runs, as a parallel land would make it; it edits the shared file too.
  const command = scriptCommand(repo, 'move-base.mjs', [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const cwd = ${JSON.stringify(repo)};`,
    `writeFileSync(${JSON.stringify(join(repo, SHARED))}, ${JSON.stringify(text(BASE_MOVED_AGAIN_LINES))});`,
    `execFileSync('git', ['commit', '-q', '-m', 'base moves during the test', '--', ${JSON.stringify(SHARED)}], { cwd });`,
  ].join('\n'));
  const result = land([LANE, '--repo', repo, '--test', command], { cwd: repo });
  assert.equal(result.status, 1, result.stdout);
  const tested = testedSha(result.stdout);
  const movedBase = git(repo, 'rev-parse', 'main');
  assert.equal(git(repo, 'rev-parse', `${movedBase}^`), before[0], 'main holds only the commit the test made');
  assert.ok(result.stderr.startsWith(`land: main moved while landing (from ${before[0]} to ${movedBase}); nothing landed, land again`), result.stderr);
  assert.equal(result.stdout.includes('landed '), false);
  // Recorded, not promised by the README's "a refusal leaves the lane as it was": the test passed, so the branch was already
  // moved to the tested sha before the fast-forward found the base moved.
  assert.equal(git(repo, 'rev-parse', LANE), tested);
  assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), LANE);
  assert.equal(git(worktree, 'status', '--porcelain'), '');

  const again = land([LANE, '--repo', repo], { cwd: repo });
  assert.equal(again.status, 1, again.stdout);
  assert.ok(again.stderr.startsWith(`land: main and ${LANE} both changed 1 file(s) since ${LANE} branched:\n  ${SHARED}\n`), again.stderr);
  assert.equal(git(repo, 'rev-parse', 'main'), movedBase);
});
