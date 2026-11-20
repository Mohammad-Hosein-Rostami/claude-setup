// Tests of the verified import (lane r7-delta, fix round 5): forged objects in the lane's store that fix round 4's "re-hash, then read
// the lane's store again" let through. B12 / R5-1: a tree of the old start rewritten in place in a round whose start moved (loose, and
// as a second copy in a pack). B13: one name with two copies, the honest one checked and the forged one read (a second pack, and a pack
// in a folder named by `objects/info/alternates`). R5-2: a rewritten blob on the reviewed side, on the base side, in a nested file the
// lane never touches, and a rewritten nested tree.
// Fixtures: the probes p20 and p26 of the security review and `gap5.mjs`, `v4probe.mjs` of the correctness review, rebuilt in temp repos.
// Each forgery must end as exit 2 naming the object, or as the answer of the honest control: never as a lighter review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { forgePackedCopy, objectsOf, packOf, rewriteLooseObject } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const GATE_RUNS = "import { execSync } from 'node:child_process';\nexport function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  execSync(cmd);\n  return 'allow';\n}\n";
const PLAIN = 'export function run(x) {\n  return x;\n}\n';
const GUARDED = 'export function run(x) {\n  if (!x) throw new Error("guard");\n  return x;\n}\n';
/** The parts of a report a blinded tool would get wrong. */
const view = ({ tier, classes, files, changedLines, range, fileClasses, reviews }) => ({ tier, classes, files, changedLines, range, fileClasses, reading: reviews[0].requiredReading, lenses: reviews.map(({ agent, model, effort, lens, plan }) => ({ agent, model, effort, lens, plan })) });
const stored = (dir, text) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();

const assertRefused = (result, oid, name) => {
  assert.equal(result.status, 2, `${name}: ${result.stderr}`);
  assert.equal(result.stdout, '', name);
  assert.ok(result.stderr.includes(`object ${oid} does not hash to its name`), `${name}: ${result.stderr}`);
};
/** A forged store ends as exit 2 or as the control's answer. */
const assertNotLighter = (result, control, name) => {
  if (result.status === 2) return assert.match(result.stderr, /the objects of this repository cannot be trusted: object [0-9a-f]{40} does not hash to its name/, name);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return assert.deepEqual(view(JSON.parse(result.stdout)), control, name);
};

/**
 * Probe p20: the lane adds a guard and docs (`reviewed`); another lane lands `onto` on main; the fix rebuilds the lane on `onto`
 * without the guard commit. The paths of the reviewed lane come from `<onto>...<reviewed>`, which git reads from the old start.
 */
function rebuiltLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('src/other.mjs', 'export const o = 1;\n');
  const start = made.write('src/gate.mjs', GATE_OPEN);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  made.write('src/gate.mjs', GATE_GUARDED);
  const reviewed = made.write('README.md', '# r\nusage\n');
  git(made.dir, 'checkout', '-q', 'main');
  const onto = made.write('src/other.mjs', 'export const o = 2;\n');
  git(made.dir, 'checkout', '-q', '-B', 'lane', onto);
  made.write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', reviewed, '--base', start, '--rebased-onto', onto, '--prior', priorFile(), '--lane-classes', 'logic,docs', '--json'];
  const control = made.tier(...fixRound);
  assert.equal(control.status, 0, control.stderr);
  assert.ok(Object.keys(JSON.parse(control.stdout).fileClasses).includes('src/gate.mjs'), 'the control round reads the file that lost its guard');
  return { ...made, start, reviewed, onto, fixRound, control: view(JSON.parse(control.stdout)) };
}

/** The bytes of a tree like `<commit>:<folder>` with one entry pointing at another object, written as a new tree; returns its oid. */
function treeWith(dir, tree, name, oid) {
  const rows = git(dir, 'ls-tree', tree).split('\n').map((row) => (row.endsWith(`\t${name}`) ? row.replace(/[0-9a-f]{40}/, oid) : row));
  return spawnSync('git', ['mktree'], { cwd: dir, input: `${rows.join('\n')}\n`, encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();
}
const bytesOf = (dir, type, oid) => spawnSync('git', ['cat-file', type, oid], { cwd: dir, env: CLEAN_ENV }).stdout;

test('security B12 (probe p20): in a round whose start moved, the old start\'s root tree rewritten in place is exit 2 naming the tree, not a round that skips the dropped guard', () => {
  const { dir, tier, start, reviewed, onto, fixRound } = rebuiltLane();
  const root = git(dir, 'rev-parse', `${start}^{tree}`);
  rewriteLooseObject(dir, root, 'tree', bytesOf(dir, 'tree', treeWith(dir, root, 'src', git(dir, 'rev-parse', `${reviewed}:src`))));
  assert.equal(git(dir, 'diff', '--name-only', `${onto}...${reviewed}`), 'README.md', 'git itself no longer lists the gate among the reviewed lane\'s files');
  assertRefused(tier(...fixRound), root, 'the old start\'s root tree');
});

test('review R5-1 (gap5): the same with a nested tree of the old start (its `src` folder names the reviewed gate)', () => {
  const { dir, tier, start, reviewed, fixRound } = rebuiltLane();
  const folder = git(dir, 'rev-parse', `${start}:src`);
  rewriteLooseObject(dir, folder, 'tree', bytesOf(dir, 'tree', treeWith(dir, folder, 'gate.mjs', git(dir, 'rev-parse', `${reviewed}:src/gate.mjs`))));
  assertRefused(tier(...fixRound), folder, 'the old start\'s src tree');
});

test('security B12, packed: the old start\'s root tree with a second, forged copy in a pack is exit 2 or the control\'s answer', () => {
  const { dir, tier, start, reviewed, onto, fixRound, control } = rebuiltLane();
  const root = git(dir, 'rev-parse', `${start}^{tree}`);
  forgePackedCopy(dir, root, treeWith(dir, root, 'src', git(dir, 'rev-parse', `${reviewed}:src`)));
  assert.equal(git(dir, 'diff', '--name-only', `${onto}...${reviewed}`), 'README.md', 'git itself is served the forged copy');
  assertNotLighter(tier(...fixRound), control, 'a forged pack copy of the old start\'s root tree');
});

/**
 * Probe p26: the fix adds an execSync call to the gate. The honest objects go into one pack, without the lure blobs; a second, older
 * pack holds the lures and, under the name of the head's gate blob, the reviewed gate plus a comment. Git serves a name from the pack
 * it used last, so a read that meets a lure first is served the forged gate.
 */
function fixThatRunsTheCommand() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('a.txt', 'a0\n');
  made.write('src/run.mjs', "import { decide } from './gate.mjs';\nexport const run = (c) => decide(c);\n");
  const start = made.write('src/gate.mjs', GATE_OPEN);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  made.write('a.txt', 'a1\n');
  const reviewed = made.write('src/gate.mjs', GATE_GUARDED);
  writeFileSync(join(made.dir, 'a.txt'), 'a2\n');
  writeFileSync(join(made.dir, 'src', 'gate.mjs'), GATE_RUNS);
  git(made.dir, 'commit', '-q', '-a', '-m', 'fix: run the command');
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'logic,docs', '--json'];
  const control = JSON.parse(made.tier(...fixRound).stdout);
  assert.deepEqual([control.tier, control.classes.includes('security')], [2, true], 'the control round sees the execSync call');
  return { ...made, start, reviewed, fixRound, control: view(control) };
}

/** Packs the honest store without `lures` into `folder`, then adds the forged copy of the head's gate blob (with the lures) beside it. */
function forgeGateCopy({ dir, start, reviewed }, folder) {
  const blob = (rev, path) => git(dir, 'rev-parse', `${rev}:${path}`);
  const lures = [blob(start, 'a.txt'), blob(reviewed, 'a.txt')];
  const honest = git(dir, 'rev-list', '--objects', '--all').split('\n').map((row) => row.slice(0, 40)).filter((oid) => !lures.includes(oid));
  packOf(dir, honest, folder);
  const standIn = stored(dir, `${GATE_GUARDED}// x\n`);
  forgePackedCopy(dir, blob('HEAD', 'src/gate.mjs'), standIn, { lures: [...lures, blob('HEAD', 'a.txt'), blob(start, 'src/gate.mjs'), blob(reviewed, 'src/gate.mjs')], folder, old: true });
}

test('security B13 (probe p26): a second pack that names the head\'s gate blob with other bytes never makes the round lighter: exit 2, or the control\'s tier 2 with the security class', () => {
  const made = fixThatRunsTheCommand();
  forgeGateCopy(made, join(objectsOf(made.dir), 'pack'));
  git(made.dir, 'prune-packed');
  assert.doesNotMatch(git(made.dir, 'diff', '-U0', made.reviewed, 'HEAD'), /execSync/, 'git itself now shows a fix without the execSync call');
  for (const args of [made.fixRound, ['main...HEAD', '--landing', '--json']]) {
    const result = made.tier(...args);
    if (args[0] === '--delta') assertNotLighter(result, made.control, 'the fix round');
    else assert.ok(result.status === 2 || JSON.parse(result.stdout).classes.includes('security'), `a first review: ${result.stderr}`);
  }
});

test('security B13: the same two packs in a folder the lane\'s objects/info/alternates names never make the round lighter', () => {
  const made = fixThatRunsTheCommand();
  const elsewhere = realpathSync(makeTempDir('review-tier-alternate-'));
  forgeGateCopy(made, join(elsewhere, 'pack'));
  mkdirSync(join(objectsOf(made.dir), 'info'), { recursive: true });
  writeFileSync(join(objectsOf(made.dir), 'info', 'alternates'), `${elsewhere}\n`);
  for (const folder of readdirSync(objectsOf(made.dir)).filter((name) => /^[0-9a-f]{2}$/.test(name))) rmSync(join(objectsOf(made.dir), folder), { recursive: true }); // the lane keeps no object of its own
  assert.doesNotMatch(git(made.dir, 'diff', '-U0', made.reviewed, 'HEAD'), /execSync/, 'git itself now shows a fix without the execSync call');
  assertNotLighter(made.tier(...made.fixRound), made.control, 'the fix round');
});

test('review R5-2 (A): in a fix round the reviewed-side blob of a changed file, rewritten in place with the fix\'s text, is exit 2 naming it', () => {
  const { dir, write, tier } = lane();
  const start = write('src/p.mjs', PLAIN);
  const reviewed = write('src/p.mjs', GUARDED);
  writeFileSync(join(dir, 'src', 'p.mjs'), PLAIN);
  git(dir, 'add', '--', 'src/p.mjs');
  write('docs/fix.md', '# fix\n');
  const fixRound = ['--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'logic', '--json'];
  assert.equal(JSON.parse(tier(...fixRound).stdout).changedLines, 2, 'the control round reads the removed guard and the docs line');
  const guarded = git(dir, 'rev-parse', `${reviewed}:src/p.mjs`);
  rewriteLooseObject(dir, guarded, 'blob', PLAIN);
  assertRefused(tier(...fixRound), guarded, 'the reviewed blob');
});

test('review R5-2 (B): in a first review the base-side blob of a changed file, rewritten in place with the lane\'s text, is exit 2 naming it', () => {
  const { dir, write, tier } = lane();
  git(dir, 'checkout', '-q', 'main');
  write('src/auth.mjs', GUARDED);
  git(dir, 'checkout', '-q', '-B', 'lane');
  write('src/auth.mjs', PLAIN);
  write('docs/x.md', '# x\n');
  assert.equal(JSON.parse(tier('--base', 'main', '--json').stdout).changedLines, 2, 'the control review reads the removed check and the docs line');
  const guarded = git(dir, 'rev-parse', 'main:src/auth.mjs');
  rewriteLooseObject(dir, guarded, 'blob', PLAIN);
  for (const args of [['--base', 'main', '--json'], ['main..HEAD', '--json']]) assertRefused(tier(...args), guarded, args[0]);
});

test('review R5-2 (C): a nested file the lane never touches (a caller in src/deep/) and a nested tree, rewritten in place, are exit 2 naming them', () => {
  const build = () => {
    const made = lane();
    git(made.dir, 'checkout', '-q', 'main');
    made.write('src/deep/x.mjs', "import { run } from '../p.mjs';\nexport const x = () => run(1);\n");
    const start = made.write('src/p.mjs', PLAIN);
    git(made.dir, 'checkout', '-q', '-B', 'lane');
    const reviewed = made.write('src/p.mjs', GUARDED);
    made.write('src/p.mjs', GUARDED.replace('"guard"', '"no x"'));
    return { ...made, rounds: [['--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'logic', '--json'], ['main...HEAD', '--json']] };
  };
  const caller = build();
  assert.ok(JSON.parse(caller.tier(...caller.rounds[0]).stdout).reviews[0].requiredReading.includes('src/deep/x.mjs:2'), 'the control round names the caller');
  const blob = git(caller.dir, 'rev-parse', 'HEAD:src/deep/x.mjs');
  rewriteLooseObject(caller.dir, blob, 'blob', 'export const x = 1;\n');
  for (const args of caller.rounds) assertRefused(caller.tier(...args), blob, `the caller's blob, ${args[0]}`);
  const nested = build();
  const tree = git(nested.dir, 'rev-parse', 'HEAD:src/deep');
  rewriteLooseObject(nested.dir, tree, 'tree', bytesOf(nested.dir, 'tree', treeWith(nested.dir, tree, 'x.mjs', stored(nested.dir, 'export const x = 1;\n'))));
  for (const args of nested.rounds) assertRefused(nested.tier(...args), tree, `the nested tree, ${args[0]}`);
});

test('review N6-1 (L10): a fallback base branch whose commit is rewritten in place is exit 2 naming the commit, before the base is chosen', () => {
  const { dir, raw, write } = lane();
  write('src/run.mjs', PLAIN);
  git(dir, 'checkout', '-q', '-b', 'develop', 'main');
  const develop = write('develop.txt', 'develop\n');
  git(dir, 'checkout', '-q', 'lane');
  rewriteLooseObject(dir, develop, 'commit', git(dir, 'cat-file', 'commit', develop).replace('edit develop.txt', 'edit something else'));
  const result = raw('--json');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(`object ${develop} does not hash to its name`), result.stderr);
});
