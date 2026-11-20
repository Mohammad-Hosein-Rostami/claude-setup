// Tests that a gap in review-tier's import fails closed (lane r7-delta, fix round 5, K1, K7, K8): an object a read needs and the import
// left out is exit 2 naming it, also where git itself would pass over it in silence (`git grep` skips a blob it cannot read, attributes
// of a missing `.gitattributes` are empty, a file text reads as "no such file"); a file planted in the tool's own temp repository is
// exit 2; and a git call that fails, or that says anything on stderr, is never read as "no", "no match" or "no file".
// How a gap is made: the recording git (spyGit) prints the listings the import makes on the lane's side with one object's name swapped
// for another's, so that object is in no import list while the lane's history still needs it. POSIX only (the spy is a `#!` script).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git-tidy-helpers.mjs';
import { commitEntries, objectsOf, spiedRun } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile, sha256Of } from './review-tier-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the recording git is a `#!` script' };
const PLAIN = 'export function run(x) {\n  return x;\n}\n';
const GUARDED = 'export function run(x) {\n  if (!x) throw new Error("guard");\n  return x;\n}\n';
const TIMER = "import { writeFileSync } from 'node:fs';\nexport const later = () => setTimeout(() => writeFileSync('x', 'y'), 1);\n";

/**
 * A lane on a base of three commits. The base holds attributes and a caller of `run`; the lane changes `run` and the attributes
 * (`reviewed`), then adds a file whose class needs its whole text (a timer beside a write call). `rounds`: a first review and a fix round.
 */
function importLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  const root = git(made.dir, 'rev-parse', 'HEAD');
  made.write('.gitattributes', '*.py diff=python\n');
  made.write('src/use.mjs', "import { run } from './p.mjs';\nexport const use = () => run(1);\n");
  const start = made.write('src/p.mjs', PLAIN);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  writeFileSync(join(made.dir, '.gitattributes'), '*.py diff=python\n*.md text\n');
  git(made.dir, 'add', '--', '.gitattributes');
  const reviewed = made.write('src/p.mjs', GUARDED);
  writeFileSync(join(made.dir, 'src', 'p.mjs'), GUARDED.replace('"guard"', '"no x"'));
  git(made.dir, 'add', '--', 'src/p.mjs');
  const head = made.write('src/timer.mjs', TIMER);
  const prior = priorFile();
  const rounds = [['--delta', reviewed, '--base', start, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic', '--json'], ['main...HEAD', '--json']];
  const oid = (name) => git(made.dir, 'rev-parse', name);
  return { ...made, root, start, reviewed, head, rounds, oid, spied: (args, more = {}) => spiedRun(made.dir, made.log, args, more) };
}

test('the control: through the recording git both rounds run and read the new file whole, and the fix round names the caller of the changed function', POSIX_ONLY, () => {
  const { spied, rounds } = importLane();
  for (const args of rounds) {
    const { result, trusted } = spied(args);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    if (args[0] === '--delta') assert.ok(report.reviews[0].requiredReading.includes('src/use.mjs:2'), 'the caller in the unchanged file is listed');
    assert.ok(report.classes.includes('concurrency-lite'), 'the timer beside a write call is found in the whole file');
    assert.ok(trusted.some((call) => call.command[0] === 'show'), 'the new file is read whole');
  }
});

test('spec check K8 (a): an object left out of the import list is exit 2 naming it, for each kind of object and each reader that would pass over it in silence', POSIX_ONLY, () => {
  const { spied, rounds, root, head, oid } = importLane();
  const standIn = oid('HEAD:base.txt');
  const gaps = [
    ['a commit only the merge-base walk reaches (below the lane start)', root, oid('main~1'), `object ${root} is needed and was not imported`],
    ['a tree of the tip', oid('HEAD:src'), oid('HEAD^{tree}'), `a tree of commit ${head} is needed and was not imported`],
    ['a caller in a file the lane never touches (only grep reads it)', oid('HEAD:src/use.mjs'), standIn, `object ${oid('HEAD:src/use.mjs')} is needed and was not imported`],
    ['the .gitattributes of the lane start (only the attribute lookup reads it)', oid('main:.gitattributes'), standIn, `object ${oid('main:.gitattributes')} is needed and was not imported`],
    ['a new file of the tip (its whole text is read)', oid('HEAD:src/timer.mjs'), standIn, `object ${oid('HEAD:src/timer.mjs')} is needed and was not imported`],
  ];
  for (const [name, from, to, message] of gaps) {
    for (const args of rounds) {
      const { result, trusted } = spied(args, { SPY_SWAP: JSON.stringify({ from, to }) });
      assert.equal(result.status, 2, `${name}, ${args[0]}: ${result.stderr}`);
      assert.equal(result.stdout, '', name);
      assert.ok(result.stderr.includes(message), `${name}, ${args[0]}: ${result.stderr}`);
      assert.match(result.stderr, /the objects of this repository cannot be trusted: .*Nothing was read from them/, name);
      assert.ok(!trusted.some((call) => ['diff', 'grep', 'show'].includes(call.command[0])), `${name}: nothing was read`);
      assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed');
    }
  }
});

test('an object the lane itself does not hold is exit 2 naming it: a commit below the lane start, a tree, a file of the tip', () => {
  for (const pick of [({ root }) => root, ({ oid }) => oid('HEAD:src'), ({ oid }) => oid('HEAD:src/use.mjs')]) {
    const made = importLane();
    const missing = pick(made);
    rmSync(join(objectsOf(made.dir), missing.slice(0, 2), missing.slice(2)));
    for (const args of made.rounds) {
      const result = made.raw(...args);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /the objects of this repository cannot be trusted/);
    }
  }
});

test('spec check K7, security N27: a file planted in the tool\'s own temp repository (alternates, a graft file, a shallow file, packed refs, a loose object) is exit 2 before anything is read', POSIX_ONLY, () => {
  const { dir, spied, rounds } = importLane();
  const planted = [['objects/info/alternates', `${objectsOf(dir)}\n`], ['info/grafts', 'x\n'], ['shallow', 'x\n'], ['packed-refs', '# pack-refs\n'], ['objects/ab/cdef', 'x'], ['refs/replace/x', 'x\n'], ['info/attributes', '*.mjs binary\n']];
  for (const [file, text] of planted) {
    const { result, trusted, laneSide } = spied(rounds[0], { SPY_AFTER_INIT: JSON.stringify({ file, text }) });
    assert.equal(result.status, 2, `${file}: ${result.stderr}`);
    assert.equal(result.stdout, '', file);
    assert.match(result.stderr, /the tool's own temp repository holds .*which this run did not put there/, file);
    assert.deepEqual([...trusted, ...laneSide].map((call) => call.command[0]), ['--version', 'init'], `${file}: nothing ran after init`);
    assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed');
  }
});

test('review N3 (T8), spec check K1: a git call that fails or writes to stderr is exit 1, never an answer: an ancestor test, a grep, a file text', POSIX_ONLY, () => {
  const { spied, rounds } = importLane();
  const failures = [
    [{ word: '--is-ancestor', status: 128, stderr: 'fatal: boom' }, /git failed: git merge-base --is-ancestor failed: fatal: boom/],
    [{ word: '--is-ancestor', status: 1, stderr: 'error: Could not read 1234' }, /git failed: git merge-base --is-ancestor failed: error: Could not read 1234/],
    [{ word: 'grep', stderr: "error: 'x:src/use.mjs': unable to read 1234" }, /git failed: git grep failed: error: 'x:src\/use\.mjs': unable to read 1234/],
    [{ word: 'show', status: 128, stderr: 'fatal: bad object x:src/timer.mjs' }, /git failed: git show failed: fatal: bad object/],
    [{ word: 'show', stderr: 'error: unable to read 1234' }, /git failed: git show failed: error: unable to read 1234/],
  ];
  for (const [fail, said] of failures) {
    const { result } = spied(rounds[0], { SPY_FAIL: JSON.stringify(fail) });
    assert.equal(result.status, 1, `${JSON.stringify(fail)}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, said);
  }
});

test('"no file" comes from the trees, never from a failed read: a deleted file and a file that became a submodule pointer read as gone, and the round runs', () => {
  const { dir, write, json } = lane();
  write('src/timer.mjs', TIMER);
  const reviewed = write('src/old.mjs', TIMER);
  git(dir, 'rm', '-q', '--', 'src/old.mjs', 'src/timer.mjs');
  commitEntries(dir, [{ mode: '160000', oid: '1'.repeat(40), path: 'src/timer.mjs' }], 'fix: the timer becomes a submodule');
  const report = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', 'logic');
  assert.deepEqual(Object.keys(report.fileClasses).sort(), ['src/old.mjs', 'src/timer.mjs']);
  assert.ok(!report.classes.includes('concurrency-lite'), 'neither path has a text at the tip, so no rule that needs the whole file fires');
});
