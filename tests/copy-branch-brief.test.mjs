// Tests for home/hooks/lib/copy-branch-brief.mjs (git-root-cause proposal 2): a writer brief that creates `<lane>-2` while `<lane>` exists,
// or says "new branch off <existing>", is advised once; the lane's own name, a brief with no branch and a read-only agent are not.
// The git repos are real temp repos (tests/git-tidy-helpers.mjs). The deadline tests inject time (a fake performance.now()) and the
// scan-speed test measures CPU time, so a busy machine cannot fail them (A-owed X4).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, join } from 'node:path';
import { TOTAL_DEADLINE_MS, branchNames, copyBranchBriefAdvice, copyBranchStem } from '../home/hooks/lib/copy-branch-brief.mjs';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { fastestCpuMs } from './timing.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const NO_FAKE_GIT = process.platform === 'win32' && 'the fake git is a shell script';
const KNOBS = ['COPY_BRANCH_DEADLINE_MS', 'COPY_BRANCH_GIT_TIMEOUT_MS'];

const EMPTY_HOME = makeTempDir('copy-brief-home-');
const ENV = { HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME };
const input = (repo, prompt, type = 'implementer') => ({ cwd: repo, tool_input: { subagent_type: type, prompt } });

function repoWithLane(lane = 'lane/r4-w1') {
  const repo = makeRepo();
  git(repo, 'branch', lane);
  return repo;
}

test('a brief that creates `<lane>-2` while `<lane>` exists is advised, for every creating phrase', () => {
  const repo = repoWithLane();
  for (const phrase of ['git checkout -b lane/r4-w1-2', 'git checkout -B lane/r4-w1-fix', 'git switch -c lane/r4-w1-v2', 'git switch -C lane/r4-w1-redo',
    'git branch lane/r4-w1-3', 'git worktree add ../wt -b lane/r4-w1-fixes', 'Create a new branch lane/r4-w1-2 and continue there', 'make a new branch called `lane/r4-w1-redo`.']) {
    const advice = copyBranchBriefAdvice(input(repo, `Fix the findings.\n${phrase}\nThen test.`), ENV);
    assert.equal(advice.deny, true, phrase);
    assert.match(advice.reason, /same branch/);
    assert.match(advice.reason, /git switch <lane> && git rebase <base>/);
  }
});

test('"new branch off <existing branch>" is advised; a new branch off a branch that does not exist is not', () => {
  const repo = repoWithLane();
  assert.equal(copyBranchBriefAdvice(input(repo, 'Make a new branch off lane/r4-w1 for the fixes.'), ENV).deny, true);
  assert.equal(copyBranchBriefAdvice(input(repo, 'Make a new branch off lane/nothing-here for the fixes.'), ENV).deny, false);
});

test('the lane branch itself, a brief with no branch, a rename and a stem that does not exist pass', () => {
  const repo = repoWithLane();
  for (const prompt of ['git checkout -b lane/r4-w1', 'git switch lane/r4-w1 && git rebase main', 'Fix the bug in a.mjs.', 'git branch -m lane/r4-w1',
    'git branch -d worktree-agent-x', 'git checkout -b lane/other-2', 'git checkout -b feature-3']) {
    assert.equal(copyBranchBriefAdvice(input(repo, prompt), ENV).deny, false, prompt);
  }
});

test('read-only agents and non-repositories pass; odd input never throws', () => {
  const repo = repoWithLane();
  assert.equal(copyBranchBriefAdvice(input(repo, 'git checkout -b lane/r4-w1-2', 'reviewer'), ENV).deny, false);
  assert.equal(copyBranchBriefAdvice(input(makeTempDir('not-a-repo-'), 'git checkout -b lane/r4-w1-2'), ENV).deny, false);
  for (const bad of [undefined, null, 4, {}, { tool_input: { prompt: 5 } }, { cwd: 'relative', tool_input: { subagent_type: 'implementer', prompt: 'git checkout -b a-2' } }]) {
    assert.equal(typeof copyBranchBriefAdvice(bad, ENV).deny, 'boolean');
  }
});

test('copyBranchStem names the existing stem and nothing else; a name that looks like an option is never looked up', () => {
  const repo = repoWithLane('feature');
  for (const suffix of ['-2', '-12', '-fix', '-fixes', '-v3', '-redo']) assert.equal(copyBranchStem(`feature${suffix}`, repo), 'feature', suffix);
  assert.equal(copyBranchStem('feature-final', repo), null);
  assert.equal(copyBranchStem('feature', repo), null);
  assert.equal(copyBranchStem('--help-2', repo), null);
  assert.equal(copyBranchStem('feature-2', 'relative/dir'), null);
});

test('branchNames reads names out of a brief and ignores prose and options', () => {
  const { created, offOf } = branchNames('Run `git checkout -b a-1`, then git branch b-2. Also: new branch off main, and git branch -d old.');
  assert.deepEqual(created, ['a-1', 'b-2']);
  assert.deepEqual(offOf, ['main']);
});

// The hook has a 5 s timeout and a killed hook skips the later gates, so a long brief (pasted text is untrusted) must scan in linear time.
test('branchNames reads a 260 KB hostile brief in well under a second (quadratic regexes took 7 s)', () => {
  const hostile = ['worktree add '.repeat(20000), `checkout -b ${')'.repeat(120000)}x`, 'git branch '.repeat(20000), 'new branch '.repeat(20000)];
  for (const text of hostile) {
    // CPU time of one run, not wall time: a busy machine that deschedules the test cannot push it over, a quadratic scan still does
    const cpuMs = fastestCpuMs(() => branchNames(text), 1);
    assert.ok(cpuMs < 500, `${text.slice(0, 20)}: ${Math.round(cpuMs)} ms of CPU`);
  }
});

test('branchNames still finds `-b <name>` a few words after `worktree add`, across spaces but not across lines, and only in the first 32 KB', () => {
  assert.deepEqual(branchNames('git worktree add --detach ../wt -b lane/x-2').created, ['lane/x-2']);
  assert.deepEqual(branchNames('git worktree add ../wt\n-b lane/x-2').created, []);
  assert.deepEqual(branchNames(`${'x'.repeat(40 * 1024)}\ngit checkout -b lane/x-2`).created, [], 'text past the scan limit is not read');
  assert.deepEqual(branchNames('git checkout -b (`lane/x-2`),').created, ['lane/x-2']);
});

/**
 * Puts a fake `git` first on PATH: it appends a line to a log when it starts, runs `body`, then exits with `status`.
 * @returns {{ starts: () => number, restore: () => void }} the number of times it started, and the undo of the PATH change
 */
function fakeGit(body, status) {
  const bin = makeTempDir('copy-brief-fake-git-');
  const calls = join(bin, 'calls.log');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho call >> '${calls}'\n${body}\nexit ${status}\n`);
  chmodSync(join(bin, 'git'), 0o755);
  spawnSync(join(bin, 'git')); // the first run of a new script can take long (macOS scans it); keep that out of the measured calls
  writeFileSync(calls, '');
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${savedPath}`;
  return {
    starts: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length,
    restore: () => { process.env.PATH = savedPath; },
  };
}

/** Runs `run` with the two COPY_BRANCH knobs set to `values` (a knob not named is unset), then puts them back. */
function withKnobs(values, run) {
  const saved = Object.fromEntries(KNOBS.map((name) => [name, process.env[name]]));
  for (const name of KNOBS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try {
    return run();
  } finally {
    for (const name of KNOBS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function sixteenNames() {
  const names = Array.from({ length: 8 }, (_, index) => `lane/slow-${index}`);
  return [...names.map((name) => `new branch off ${name}`), ...names.map((name) => `git checkout -b ${name}-2`)].join('\n');
}

const HOOK_TIMEOUT_MS = JSON.parse(readFileSync(new URL('../settings/base.json', import.meta.url), 'utf8'))
  .hooks.PreToolUse.flatMap((entry) => entry.hooks).find((hook) => hook.command.includes('agent-model-guard.mjs')).timeout * 1000;

test('the total deadline is well under the hook timeout in settings/base.json, so the later gates and the model pin still run', () => {
  assert.ok(Number.isInteger(HOOK_TIMEOUT_MS) && HOOK_TIMEOUT_MS > 0, `hook timeout ${HOOK_TIMEOUT_MS}`);
  assert.ok(TOTAL_DEADLINE_MS * 2 <= HOOK_TIMEOUT_MS, `${TOTAL_DEADLINE_MS} ms is not well under the ${HOOK_TIMEOUT_MS} ms hook timeout`);
});

// Round 6 review (L2): 16 candidate names x 1 s per git call ran past the hook's 5 s timeout, and a killed hook skips the later gates and the model pin.
// Injected time (A-owed X4): the gate reads its clock through performance.now(), so a fake clock that moves on by SLOW_GIT_MS at each git
// start makes every lookup take that long, whatever the machine's load (a real `sleep 0.5` git took longer on a busy machine).
const SLOW_GIT_MS = 500;
const FAKE_CLOCK_START_MS = 5000;

test('with no knob set, a slow git cannot hold the gate past the production deadline: later names are not looked up and the brief passes (fail open)', { skip: NO_FAKE_GIT }, () => {
  const repo = repoWithLane();
  const fake = fakeGit('', 1);
  const clock = mock.method(performance, 'now', () => FAKE_CLOCK_START_MS + SLOW_GIT_MS * fake.starts());
  try {
    const started = performance.now();
    const advice = withKnobs({}, () => copyBranchBriefAdvice(input(repo, sixteenNames()), ENV));
    const elapsed = performance.now() - started;
    assert.deepEqual(advice, { deny: false });
    assert.equal(fake.starts(), TOTAL_DEADLINE_MS / SLOW_GIT_MS, `git started ${fake.starts()} times for 16 names; 2 s of 0.5 s calls allows 4`);
    assert.ok(elapsed < HOOK_TIMEOUT_MS, `${Math.round(elapsed)} ms is past the hook timeout`);
  } finally {
    clock.mock.restore();
    fake.restore();
  }
});

test('the last lookup is clipped to the time left: a git that hangs ends at the deadline, not after its own 1 s timeout', { skip: NO_FAKE_GIT }, () => {
  const repo = repoWithLane();
  const fake = fakeGit('exec sleep 5', 0);
  // Injected time (A-owed X4): a fixed clock leaves exactly 200 ms, and the spy reads the timeout git is given, so no wall time is measured.
  const clock = mock.method(performance, 'now', () => FAKE_CLOCK_START_MS);
  const spawns = mock.method(childProcess, 'spawnSync'); // calls the real spawnSync, so the hanging git is really stopped
  syncBuiltinESMExports(); // the gate's own `import { spawnSync }` now sees the spy
  try {
    const stem = withKnobs({}, () => copyBranchStem('lane/hang-2', repo, FAKE_CLOCK_START_MS + 200));
    const lookups = spawns.mock.calls.filter((call) => call.arguments[0] === 'git').map((call) => call.arguments[2].timeout);
    assert.equal(stem, null);
    assert.equal(fake.starts(), 1);
    assert.deepEqual(lookups, [200], 'the lookup ran with the 200 ms left as its timeout, not the per-call timeout of 1000 ms');
  } finally {
    spawns.mock.restore();
    syncBuiltinESMExports();
    clock.mock.restore();
    fake.restore();
  }
});

test('git never starts when no time is left: at exactly 0 ms or past the deadline the stem is not looked up', { skip: NO_FAKE_GIT }, () => {
  const fake = fakeGit('', 0); // exits 0: every branch "exists", so only the deadline can make the answer null
  const clock = mock.method(performance, 'now', () => 5000);
  try {
    assert.equal(copyBranchStem('lane/x-2', repoWithLane(), 5000), null, 'exactly 0 ms left');
    assert.equal(copyBranchStem('lane/x-2', repoWithLane(), 4999), null, '1 ms past');
    assert.equal(fake.starts(), 0);
    assert.equal(copyBranchStem('lane/x-2', repoWithLane(), 5500), 'lane/x', '500 ms left starts git (control)');
    assert.equal(fake.starts(), 1);
  } finally {
    clock.mock.restore();
    fake.restore();
  }
});

test('COPY_BRANCH_DEADLINE_MS takes only a positive whole number; -1, 0, 1.5, text and an empty value fall back to the default', { skip: NO_FAKE_GIT }, () => {
  const repo = repoWithLane();
  const prompt = 'git checkout -b lane/r4-w1-2';
  const fake = fakeGit('', 0);
  try {
    for (const bad of ['-1', '0', '1.5', 'abc', '', 'Infinity']) {
      const advice = withKnobs({ COPY_BRANCH_DEADLINE_MS: bad }, () => copyBranchBriefAdvice(input(repo, prompt), ENV));
      assert.equal(advice.deny, true, `${JSON.stringify(bad)} must not switch the gate off`);
    }
    assert.equal(fake.starts(), 6, 'git ran once per bad value');
  } finally {
    fake.restore();
  }
  const tiny = withKnobs({ COPY_BRANCH_DEADLINE_MS: '1' }, () => {
    const wasted = performance.now() + 5;
    while (performance.now() < wasted); // a 1 ms deadline is gone before the first lookup
    return copyBranchBriefAdvice(input(repo, prompt), ENV);
  });
  assert.equal(tiny.deny, false, 'a positive value is honoured (control)');
});
