// Unit tests of land-lane: the argument check (F3 hostile names, F4 Windows paths), the failing-test reader of the suite step, and the
// base-moved loop with the same-base guard (steps are test doubles; the real tools are in land-lane.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Stop, landLoop } from '../home/tools/land-lane/land-lane.mjs';
import { isAbsolutePath, parseArgs, UsageError } from '../home/tools/land-lane/lib/args.mjs';
import { failuresIn } from '../home/tools/land-lane/lib/suite-step.mjs';
import { LAND_LANE } from './land-lane-helpers.mjs';

const TIP = 'a'.repeat(40);
const GOOD = ['--repo', '/r', '--branch', 'lane/x', '--tip', TIP, '--base', 'main', '--status-file', '/s/STATUS.md', '--close-row', 'close:1'];
const without = (flag) => { const at = GOOD.indexOf(flag); return [...GOOD.slice(0, at), ...GOOD.slice(at + 2)]; };
const replacing = (flag, value) => GOOD.map((word, at) => (GOOD[at - 1] === flag ? value : word));

test('F4 Windows paths: `C:\\x` and `C:/x` are absolute, `\\\\server\\x`, `C:x`, relative paths and control characters are not', () => {
  for (const path of ['/', '/a/b', 'C:\\x', 'c:/x', 'D:\\a b\\c']) assert.equal(isAbsolutePath(path), true, path);
  for (const path of ['\\\\server\\x', '\\x', 'C:x', 'x', './x', '../x', '', '/a\nb', '/a\u0000b', '/a\u007fb', `/${'x'.repeat(5000)}`]) assert.equal(isAbsolutePath(path), false, JSON.stringify(path));
  assert.equal(parseArgs(replacing('--repo', 'C:\\x')).repo, 'C:\\x');
  assert.throws(() => parseArgs(replacing('--repo', '\\\\server\\x')), UsageError);
});

test('arguments: the good line parses; every required flag is needed; a repeat, an unknown flag and a stray word are usage errors', () => {
  const parsed = parseArgs([...GOOD, '--json', '--checks', 'test,review', '--audit-base', 'b'.repeat(40), '--worktree', '/w', '--brief', '/b.md']);
  assert.deepEqual([parsed.json, parsed.checks, parsed.worktree, parsed.brief, parsed.auditBase], [true, ['test', 'review'], '/w', '/b.md', 'b'.repeat(40)]);
  assert.deepEqual([parseArgs(GOOD).worktree, parseArgs(GOOD).checks, parseArgs(GOOD).auditBase], [null, [], null]);
  for (const flag of ['--repo', '--branch', '--tip', '--base', '--status-file', '--close-row']) assert.throws(() => parseArgs(without(flag)), /missing/, flag);
  assert.throws(() => parseArgs([...GOOD, '--branch', 'other']), /given twice/);
  assert.throws(() => parseArgs([...GOOD, '--force']), /unknown argument/);
  assert.throws(() => parseArgs([...GOOD, 'lane/y']), /unknown argument/);
  assert.throws(() => parseArgs([...GOOD.slice(0, -1)]), /needs a value/);
});

test('arguments: a sha is exactly 40 lower-case hex, a row id is what status.mjs takes, --checks is plain names', () => {
  for (const bad of [TIP.slice(1), `${TIP}a`, TIP.toUpperCase(), 'g'.repeat(40), 'main']) assert.throws(() => parseArgs(replacing('--tip', bad)), UsageError, bad);
  assert.throws(() => parseArgs([...GOOD, '--audit-base', 'abc']), UsageError);
  for (const bad of ['-x', 'a b', '', 'x'.repeat(41), 'a;b']) assert.throws(() => parseArgs(replacing('--close-row', bad)), UsageError, JSON.stringify(bad));
  for (const good of ['7', '17a', 'close:5', 'nowf.s1.land-lane']) assert.equal(parseArgs(replacing('--close-row', good)).closeRow, good);
  for (const bad of ['Test', 'test,', ',test', 'test review', 'test;x']) assert.throws(() => parseArgs([...GOOD, '--checks', bad]), UsageError, bad);
});

test('F3 hostile names: options, shell text, a bad ref and a long name are usage errors for --branch and --base, with no process started', () => {
  for (const name of ['--help', '-x', 'a;rm -rf x', '$(id)', '`id`', 'a b', 'a|b', '..', 'a..b', 'a.lock/', 'a@{b', '/lead', 'x'.repeat(101), '']) {
    assert.throws(() => parseArgs(replacing('--branch', name)), UsageError, `branch ${JSON.stringify(name)}`);
    assert.throws(() => parseArgs(replacing('--base', name)), UsageError, `base ${JSON.stringify(name)}`);
  }
  for (const name of ['main', 'lane/x', 'feature/a-b_c.d', 'x'.repeat(100)]) assert.equal(parseArgs(replacing('--branch', name)).branch, name);
  const run = spawnSync(process.execPath, [LAND_LANE, ...replacing('--branch', '--help')], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stdout.split('\n')[0], /^land: usage$/);
});

const SPEC_LOG = `✔ good (0.3ms)
✖ parses (0.4ms)
ℹ tests 2
✖ failing tests:

test at tests/a.test.mjs:2:25
✖ parses (0.44ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  3 !== 2

test at tests/b.test.mjs:9:1
✖ other (1.5ms)
  Error: boom
`;

test('failing tests: each one is `<file>: <name>: <first error line>` from the spec reporter; the dot reporter has no file; no list is []', () => {
  assert.deepEqual(failuresIn(SPEC_LOG), [
    'tests/a.test.mjs: parses: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    'tests/b.test.mjs: other: Error: boom',
  ]);
  assert.deepEqual(failuresIn('.X.\n\nFailed tests:\n\n✖ parses (0.4ms)\n  Error: no file\n'), ['a test: parses: Error: no file']);
  assert.deepEqual(failuresIn('1 failing\n'), []);
});

// the loop ------------------------------------------------------------------------------------------------------------------------------

const OPTIONS = { tip: TIP, base: 'main' };
const landedOnce = { moved: false, to: 'd'.repeat(40), from: 'e'.repeat(40), findings: [], notes: ['landed note'] };

/** Steps whose land answers come from `answers` in order; `bases` is what the base reads as, in order. */
function doubles(answers, bases) {
  const calls = { rebase: [], land: [] };
  const steps = {
    rebase: (_options, expected) => { calls.rebase.push(expected); return `rebased-${calls.rebase.length}`; },
    suite: () => ['suite note'],
    land: (_options, rebased) => { calls.land.push(rebased); return answers.shift(); },
    baseTip: () => bases.shift(),
  };
  return { steps, calls };
}

test('loop: a landing on the first try returns what landed, with the suite note first', () => {
  const { steps, calls } = doubles([landedOnce], []);
  assert.deepEqual(landLoop(OPTIONS, steps).notes, ['suite note', 'landed note']);
  assert.deepEqual(calls.rebase, [TIP]);
});

test('loop: a base that moved goes back to the rebase check with the lane\'s own rebased tip as the reviewed one; a real second move lands', () => {
  const moved = (tip) => ({ moved: true, tip });
  const { steps, calls } = doubles([moved('t1'), moved('t2'), landedOnce], ['b1', 'b2']);
  assert.equal(landLoop(OPTIONS, steps).to, landedOnce.to);
  assert.deepEqual(calls.rebase, [TIP, 't1', 't2'], 'each rebase names the tip the lane was left at, never the original again');
});

test('loop: the base reported moved twice while it did not change is exit 5, not a loop', () => {
  const { steps, calls } = doubles([{ moved: true, tip: 't1' }, { moved: true, tip: 't2' }, landedOnce], ['b1', 'b1']);
  assert.throws(() => landLoop(OPTIONS, steps), (error) => error instanceof Stop && error.code === 5 && /moved twice but main is still at b1/.test(error.message));
  assert.equal(calls.rebase.length, 2);
});

test('loop: a refusal of any step ends the loop and nothing after it runs', () => {
  const { steps, calls } = doubles([], []);
  steps.suite = () => { throw new Stop(4, 'red', ['red']); };
  assert.throws(() => landLoop(OPTIONS, steps), (error) => error instanceof Stop && error.code === 4);
  assert.equal(calls.land.length, 0, 'git-tidy land never ran on a red suite');
});
