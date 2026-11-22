// Unit tests of land-lane: the argument check (F3 hostile names, F4 Windows paths), and the
// base-moved loop with the same-base guard (steps are test doubles; the real tools are in land-lane.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Stop, landLoop } from '../home/tools/land-lane/land-lane.mjs';
import { isAbsolutePath, parseArgs, UsageError } from '../home/tools/land-lane/lib/args.mjs';
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
  const parsed = parseArgs([...GOOD, '--json', '--worktree', '/w', '--brief', '/b.md']);
  assert.deepEqual([parsed.json, parsed.worktree, parsed.brief], [true, '/w', '/b.md']);
  assert.deepEqual([parseArgs(GOOD).worktree, parseArgs(GOOD).brief], [null, null]);
  for (const flag of ['--repo', '--branch', '--tip', '--base', '--status-file', '--close-row']) assert.throws(() => parseArgs(without(flag)), /missing/, flag);
  assert.throws(() => parseArgs([...GOOD, '--branch', 'other']), /given twice/);
  assert.throws(() => parseArgs([...GOOD, '--force']), /unknown argument/);
  assert.throws(() => parseArgs([...GOOD, 'lane/y']), /unknown argument/);
  assert.throws(() => parseArgs([...GOOD.slice(0, -1)]), /needs a value/);
});

test('arguments: a sha is exactly 40 lower-case hex, a row id is what status.mjs takes, the removed flags are refused', () => {
  for (const bad of [TIP.slice(1), `${TIP}a`, TIP.toUpperCase(), 'g'.repeat(40), 'main']) assert.throws(() => parseArgs(replacing('--tip', bad)), UsageError, bad);
  assert.throws(() => parseArgs([...GOOD, '--audit-base', 'abc']), UsageError);
  for (const bad of ['-x', 'a b', '', 'x'.repeat(41), 'a;b']) assert.throws(() => parseArgs(replacing('--close-row', bad)), UsageError, JSON.stringify(bad));
  for (const good of ['7', '17a', 'close:5', 'nowf.s1.land-lane']) assert.equal(parseArgs(replacing('--close-row', good)).closeRow, good);
  for (const flag of ['--checks', '--audit-base']) assert.throws(() => parseArgs([...GOOD, flag, 'test']), UsageError, flag);
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

// the loop ------------------------------------------------------------------------------------------------------------------------------

const OPTIONS = { tip: TIP, base: 'main' };
const landedOnce = { moved: false, to: 'd'.repeat(40), from: 'e'.repeat(40), findings: [], notes: ['landed note'] };

/** Steps whose land answers come from `answers` in order; `bases` is what the base reads as, in order. */
function doubles(answers, bases) {
  const calls = { rebase: [], land: [] };
  const steps = {
    rebase: (_options, expected) => { calls.rebase.push(expected); return `rebased-${calls.rebase.length}`; },
    land: (_options, rebased) => { calls.land.push(rebased); return answers.shift(); },
    baseTip: () => bases.shift(),
  };
  return { steps, calls };
}

test('loop: a landing on the first try returns what landed', () => {
  const { steps, calls } = doubles([landedOnce], []);
  assert.deepEqual(landLoop(OPTIONS, steps).notes, ['landed note']);
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

test('loop: a refusal of the rebase check ends the loop and nothing after it runs', () => {
  const { steps, calls } = doubles([], []);
  steps.rebase = () => { throw new Stop(3, 'conflict', ['conflict']); };
  assert.throws(() => landLoop(OPTIONS, steps), (error) => error instanceof Stop && error.code === 3);
  assert.equal(calls.land.length, 0, 'git-tidy land never ran after a refused rebase');
});
