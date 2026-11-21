// Tests that a gap in review-tier's import fails closed (lane r7-delta, fix round 5, K1, K7, K8): an object a read needs and the import
// left out is exit 2 naming it, also where git itself would pass over it in silence (`git grep` skips a blob it cannot read, attributes
// of a missing `.gitattributes` are empty, a file text reads as "no such file"); a file planted in the tool's own temp repository is
// exit 2 (a FIFO in place of `HEAD` too, which must not block the run); and a git call that fails, or that says anything on stderr (for grep: an `error:` or `fatal:` line, since git also warns there
// about the start's attributes), is never read as "no", "no match" or "no file".
// How a gap is made: the recording git (spyGit) prints the listings the import makes on the lane's side with one object's name swapped
// for another's, so that object is in no import list while the lane's history still needs it. POSIX only (the spy is a `#!` script).
import { describe, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { git } from './git-tidy-helpers.mjs';
import { commitEntries, objectsOf, spiedRun } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile, sha256Of } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

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

// Speed (phase 8): every test here runs the review tool many times through spawnSync, and node:test runs synchronous bodies one after
// another even inside a concurrent describe. So on the main thread `test` registers each test and runs its body in a worker thread
// of its own (this file loaded again with the test's name), and the describe below runs those workers side by side. In a worker,
// `test` runs only the body it was started for and `suite` only calls its function: nothing is registered with node:test there.
// The tests share nothing: each builds its own repos in its own temp folders (makeTempDir), which the worker removes when it ends.
const test = isMainThread ? testInWorker : runIfNamed;
const suite = isMainThread ? describe : (name, options, body) => body();

/** Main thread: registers the test `name` with node:test; its body runs in a worker thread that loads this file (see above). */
function testInWorker(name, ...optionsAndBody) {
  const options = optionsAndBody.length > 1 ? optionsAndBody[0] : {};
  nodeTest(name, options, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { testName: name } });
    worker.once('error', reject); // a failed assert in the body arrives here with its message and stack
    worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the worker of "${name}" exited with code ${code}`))));
  }));
}

/** Worker thread: runs the body of the one test this worker was started for. */
function runIfNamed(name, ...optionsAndBody) {
  if (name === workerData.testName) optionsAndBody.at(-1)();
}

suite('review-tier: the import fails closed', { concurrency: true }, () => {
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

  test('spec check K8 (a): an object left out of the import list is exit 2 naming it, for each kind of object and each reader that would pass over it in silence or fail without naming it', POSIX_ONLY, () => {
    const { spied, rounds, root, head, oid } = importLane();
    const standIn = oid('HEAD:base.txt');
    const gaps = [
      ['a commit only the merge-base walk reaches (below the lane start)', root, oid('main~1'), `object ${root} is needed and was not imported`],
      ['a tree of the tip', oid('HEAD:src'), oid('HEAD^{tree}'), `a tree of commit ${head} is needed and was not imported`],
      ['a caller in a file the lane never touches (only grep reads it)', oid('HEAD:src/use.mjs'), standIn, `object ${oid('HEAD:src/use.mjs')} is needed and was not imported`],
      ['the .gitattributes of the lane start (only the attribute lookup reads it)', oid('main:.gitattributes'), standIn, `object ${oid('main:.gitattributes')} is needed and was not imported`],
      ['a new file of the tip (its whole text is read)', oid('HEAD:src/timer.mjs'), standIn, `object ${oid('HEAD:src/timer.mjs')} is needed and was not imported`],
      ['the start\'s side of a changed file (only a diff reads it)', oid('main:src/p.mjs'), standIn, `object ${oid('main:src/p.mjs')} is needed and was not imported`],
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

  test('fix 7 K5, security N37: a FIFO put in place of HEAD right after git init is exit 2 at the first read of the folder, not a run that blocks', POSIX_ONLY, () => {
    const { spied, rounds } = importLane();
    const temp = realpathSync(makeTempDir('review-tier-tmpdir-')); // a run killed by the time limit leaves its folder here, not in the real temp folder
    const { result, trusted } = spied(rounds[0], { TMPDIR: temp, SPY_AFTER_INIT: JSON.stringify({ file: 'HEAD', fifo: true }) });
    assert.equal(result.error?.code, undefined, `the run ended by itself: ${result.error?.message}`);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /the tool's own temp repository changed during the run: .*HEAD is not a regular file/);
    assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed, the FIFO with it');
  });

  test('fix 7 K5: a FIFO put in place of the import pack while the tool writes it is exit 2 when the tool opens it for git index-pack, not a run that blocks', POSIX_ONLY, () => {
    const { spied, rounds } = importLane();
    // the import's last read of the lane's objects before the first `git index-pack`: the tool is writing the pack then
    const control = spied(rounds[0]);
    const firstIndex = control.trusted.find((call) => call.command[0] === 'index-pack').at;
    const nth = control.laneSide.filter((call) => call.command.includes('--batch') && call.at < firstIndex).length;
    const temp = realpathSync(makeTempDir('review-tier-tmpdir-'));
    const { result, trusted } = spied(rounds[0], { TMPDIR: temp, SPY_AFTER_BATCH: JSON.stringify({ nth, file: 'import.pack', fifo: true }) });
    assert.equal(result.error?.code, undefined, `the run ended by itself: ${result.error?.message}`);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /the tool's own temp repository changed during the run: .*import\.pack is not a regular file/);
    assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed, the FIFO with it');
  });

  test('fix 7 K4: what stops the removal of the run\'s own folder (a read-only folder planted in it) is one line on stderr, and the run\'s own refusal still shows', POSIX_ONLY, () => {
    const { spied, rounds } = importLane();
    const temp = realpathSync(makeTempDir('review-tier-tmpdir-'));
    const { result, trusted } = spied(rounds[0], { TMPDIR: temp, SPY_AFTER_INIT: JSON.stringify({ file: 'locked/x', text: 'x', lock: true }) });
    const left = trusted[0].env.GIT_DIR;
    chmodSync(join(left, 'locked'), 0o700); // so the test's own clean-up can remove it
    assert.equal(result.status, 2, result.stderr);
    const lines = result.stderr.trim().split('\n');
    // close() runs while the refusal propagates, so its line comes first
    assert.match(lines[0], new RegExp(`^review-tier: the temp folder ${left} was not removed in full, the rest is left there: EACCES`));
    assert.match(lines[1], /^review-tier: .*the tool's own temp repository holds locked, which this run did not put there/);
    assert.equal(lines.length, 2, result.stderr);
  });

  test('spec check K7: a file planted in the temp repository after an import (alternates, a loose object, a replace ref, a changed config) is exit 2 before the next git call', POSIX_ONLY, () => {
    const { dir, spied, rounds } = importLane();
    const planted = [['objects/info/alternates', `${objectsOf(dir)}\n`], ['objects/ab/cdef', 'x'], ['refs/replace/x', `${'1'.repeat(40)}\n`], ['config', '[core]\n\tbare = true\n[extensions]\n\tpartialClone = x\n'], ['info/grafts', 'x\n']];
    // Each file once after the commits' import and once after the import of trees and files, in a fix round and in a first review.
    const cases = planted.flatMap(([file, text], index) => [1, 2].map((nth) => ({ file, text, nth, args: rounds[(index + nth) % rounds.length] })));
    for (const { file, text, nth, args } of cases) {
      const { result, trusted, laneSide } = spied(args, { SPY_AFTER_IMPORT: JSON.stringify({ nth, file, text }) });
      const label = `${file} after import ${nth}, ${args[0]}`;
      assert.equal(result.status, 2, `${label}: ${result.stderr}`);
      assert.equal(result.stdout, '', label);
      assert.match(result.stderr, file === 'config' ? /config of the tool's own temp repository changed during the run/ : /the tool's own temp repository holds .*which this run did not put there/, label);
      const calls = [...trusted, ...laneSide].sort((a, b) => a.at - b.at);
      const imports = calls.filter((call) => call.command[0] === 'index-pack');
      assert.equal(imports.length, nth, `${label}: the run stopped at that import`);
      assert.equal(calls.at(-1).at, imports.at(-1).at, `${label}: no git call came after it, so nothing was read`);
      assert.ok(!existsSync(trusted[0].env.GIT_DIR), 'the temp repository is removed');
    }
  });

  test('review N3 (T8), spec check K1: a git call that fails or writes to stderr is exit 1, never an answer: an ancestor test, a grep, a file text, the question whether a file is there', POSIX_ONLY, () => {
    const { spied, rounds } = importLane();
    const failures = [
      [{ word: '--is-ancestor', status: 128, stderr: 'fatal: boom' }, /git failed: git merge-base --is-ancestor failed: fatal: boom/],
      [{ word: '--is-ancestor', status: 1, stderr: 'error: Could not read 1234' }, /git failed: git merge-base --is-ancestor failed: error: Could not read 1234/],
      [{ word: 'grep', stderr: "error: 'x:src/use.mjs': unable to read 1234" }, /git failed: git grep failed: error: 'x:src\/use\.mjs': unable to read 1234/],
      [{ word: 'show', status: 128, stderr: 'fatal: bad object x:src/timer.mjs' }, /git failed: git show failed: fatal: bad object/],
      [{ word: 'show', stderr: 'error: unable to read 1234' }, /git failed: git show failed: error: unable to read 1234/],
      [{ word: '--verify', status: 128, stderr: 'fatal: boom' }, /git failed: git rev-parse failed: fatal: boom/],
      [{ word: '--verify', status: 1, stderr: 'error: Could not read 1234' }, /git failed: git rev-parse failed: error: Could not read 1234/],
      // review N6-7 (X29): the merge bases of the start and the reviewed commit, which say what else is imported
      [{ word: '--all', stderr: 'error: Could not read 1234' }, /git failed: git merge-base failed: error: Could not read 1234/],
    ];
    for (const [fail, said] of failures) {
      const { result } = spied(rounds[0], { SPY_FAIL: JSON.stringify(fail) });
      assert.equal(result.status, 1, `${JSON.stringify(fail)}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, said);
    }
  });

  test('review R6-1, spec check K2 (fix 6): grep fails on a line of its stderr that starts with error: or fatal:, quoting that line, and on no other line; a file text still fails on any stderr', POSIX_ONLY, () => {
    const { spied, rounds } = importLane();
    const warnings = "warning: Negative patterns are ignored in git attributes\nUse '\\!' for literal leading exclamation.\n@odd is not a valid attribute name: .gitattributes:2";
    const { result: warned } = spied(rounds[0], { SPY_FAIL: JSON.stringify({ word: 'grep', stderr: warnings }) });
    assert.equal(warned.status, 0, warned.stderr);
    assert.ok(JSON.parse(warned.stdout).reviews[0].requiredReading.includes('src/use.mjs:2'), 'grep still ran and found the caller');
    const failures = [
      [{ word: 'grep', stderr: "warning: Negative patterns are ignored in git attributes\nerror: 'x:src/use.mjs': unable to read 1234" }, /git failed: git grep failed: error: 'x:src\/use\.mjs': unable to read 1234/],
      [{ word: 'grep', status: 0, stderr: 'fatal: x' }, /git failed: git grep failed: fatal: x\n/],
      [{ word: 'show', stderr: 'warning: x' }, /git failed: git show failed: warning: x/],
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
});
