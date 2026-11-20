// Tests that state in the lane's git dir cannot make review-tier read less than what lands (lane r7-delta, fix round 4): a forged
// commit-graph (B8), a submodule pointer hidden by config or .gitmodules (B9), a file name stored NFD (B10), an object rewritten in place,
// loose or packed (B11), a path that is not UTF-8 (F12) and a lane file named like a pathspec (R4-4).
// Fixtures: the probes p9, p9b, p11, p12, p13 (C) of the security review and p2 of the spec check, rebuilt in temp repos.
// Config, attributes and the environment: review-tier-outside-state.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { commitEntries, forgeCommitGraph, forgePackedBlob, looseObjectFile, rewriteLooseObject } from './review-tier-forgery-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";
const EXEC_FILE = 'import { execSync } from "node:child_process";\nexport function run(name) {\n  return execSync(`ls ${name}`);\n}\n';
const NFD_GATE = 'src/gäte.mjs'; // "gäte" with the dots as a combining mark: what a macOS file dialog or a copied name produces
/** The parts of a report a blinded tool would get wrong. */
const view = ({ tier, classes, files, changedLines, range, fileClasses, reviews }) => ({ tier, classes, files, changedLines, range, fileClasses, reading: reviews[0].requiredReading, lenses: reviews.map(({ agent, model, effort, lens, plan }) => ({ agent, model, effort, lens, plan })) });

/** A lane on a base of two commits (`start`, then `base` on main): the open gate is on the base, the lane adds the guard, then docs (`reviewed`). */
function guardLane() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  const start = made.write('src/gate.mjs', GATE_OPEN);
  const base = made.write('NOTES.md', 'x\n');
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  const guard = made.write('src/gate.mjs', GATE_GUARDED);
  const reviewed = made.write('README.md', '# r\nusage\n');
  return { ...made, start, base, guard, reviewed, prior: priorFile() };
}

test('security B8 (probe p9): a forged commit-graph does not hide the guard a rebuilt lane dropped: the fix round still reads the guard file', () => {
  const { dir, write, json, start, base, guard, reviewed, prior } = guardLane();
  git(dir, 'tag', 'kept', reviewed); // the graph is written for what refs reach
  git(dir, 'reset', '-q', '--hard', base);
  git(dir, 'cherry-pick', reviewed);
  const picked = git(dir, 'rev-parse', 'HEAD');
  const fix = write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', reviewed, '--base', base, '--prior', prior, '--lane-classes', 'logic,docs'];
  const control = view(json(...fixRound));
  assert.ok(Object.keys(control.fileClasses).includes('src/gate.mjs') && control.files === 2, 'the control round reads the file that lost its guard');
  forgeCommitGraph(dir, [[start, guard, 2], [guard, null, 1], [base, start, 3], [reviewed, guard, 2], [picked, base, 4], [fix, picked, 5]]);
  assert.equal(git(dir, 'diff', '--name-only', `${base}...${reviewed}`), 'README.md', 'git itself now takes the guard commit for a base commit');
  assert.deepEqual(view(json(...fixRound)), control);
});

test('security B8 (probe p9b b): under a forged commit-graph a plain fix that deletes the guard is still read as the delta since the reviewed commit', () => {
  const { dir, write, json, start, base, guard, reviewed, prior } = guardLane();
  const dropsGuard = write('src/gate.mjs', GATE_OPEN);
  const docsFix = write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', reviewed, '--base', base, '--prior', prior, '--lane-classes', 'logic,docs'];
  const control = view(json(...fixRound));
  assert.equal(control.range, `${reviewed}..HEAD`);
  assert.ok(control.reading.includes('src/gate.mjs:1'), 'the control round names the line where the guard was');
  forgeCommitGraph(dir, [[guard, null, 1], [start, guard, 2], [base, start, 3], [reviewed, guard, 2], [dropsGuard, base, 4], [docsFix, dropsGuard, 5]]);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', reviewed, 'HEAD'], { cwd: dir, env: CLEAN_ENV }).status, 1, 'git itself now says the reviewed commit is no ancestor of HEAD');
  assert.deepEqual(view(json(...fixRound)), control);
});

test('security B8 (probe p9b c): a first review keeps its tier, its lenses and its lane start under a forged commit-graph', () => {
  const { dir, write, json } = lane();
  git(dir, 'checkout', '-q', 'main');
  const start = write('src/base.mjs', 'export const x = 1;\n');
  const base = write('NOTES.md', 'x\n');
  git(dir, 'checkout', '-q', '-B', 'lane');
  const risky = write('src/run.mjs', EXEC_FILE);
  const docs = write('README.md', '# r\nusage\n');
  const control = json('main...HEAD', '--landing');
  assert.deepEqual([control.tier, control.classes.includes('security'), control.base], [2, true, base]);
  forgeCommitGraph(dir, [[risky, null, 1], [start, risky, 2], [base, start, 3], [docs, risky, 2]]);
  assert.equal(git(dir, 'merge-base', 'refs/heads/main', 'HEAD'), risky, 'git itself now puts the lane start at the risky commit');
  for (const args of [['main...HEAD', '--landing'], ['--landing'], ['main...HEAD']]) {
    const forged = json(...args);
    assert.deepEqual([forged.tier, forged.classes.includes('security'), forged.files, forged.base], [2, true, 2, base], args.join(' '));
  }
  assert.deepEqual(view(json('main...HEAD', '--landing')), view(control));
});

test('security B9 (probe p11): a moved submodule pointer is read under both spellings that hide it: diff.ignoreSubmodules in the repo config and ignore = all in the working tree\'s .gitmodules', () => {
  const { dir, json, write } = lane();
  const gitmodules = '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib\n';
  write('.gitmodules', gitmodules);
  const reviewed = commitEntries(dir, [{ mode: '160000', oid: '1'.repeat(40), path: 'vendor/lib' }], 'feat: vendor lib');
  commitEntries(dir, [{ mode: '160000', oid: '2'.repeat(40), path: 'vendor/lib' }, { text: '# r\nlib v2\n', path: 'README.md' }], 'fix: bump lib, docs');
  const fixRound = ['--delta', reviewed, '--prior', priorFile(), '--lane-classes', 'logic,docs'];
  const control = view(json(...fixRound));
  assert.deepEqual(Object.keys(control.fileClasses).sort(), ['.gitmodules', 'README.md', 'vendor/lib']);
  assert.equal(control.files, 2, 'the pointer and the README');
  git(dir, 'config', 'diff.ignoreSubmodules', 'all');
  assert.deepEqual(view(json(...fixRound)), control, 'diff.ignoreSubmodules all');
  git(dir, 'config', '--unset', 'diff.ignoreSubmodules');
  writeFileSync(join(dir, '.gitmodules'), `${gitmodules}\tignore = all\n`);
  assert.equal(git(dir, 'diff', '--name-only', reviewed, 'HEAD'), 'README.md', 'git itself now hides the pointer');
  assert.deepEqual(view(json(...fixRound)), control, '.gitmodules ignore = all');
});

test('security B10 (probe p12): a guard file stored under its NFD name is read when a rebuilt lane drops it, whatever core.precomposeUnicode says', () => {
  const { dir, write, json } = lane();
  const base = git(dir, 'rev-parse', 'refs/heads/main');
  commitEntries(dir, [{ text: GATE_GUARDED, path: NFD_GATE }], 'feat: guard');
  const reviewed = write('README.md', '# r\nusage\n');
  git(dir, 'reset', '-q', '--hard', base);
  git(dir, 'cherry-pick', reviewed);
  write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', reviewed, '--base', base, '--prior', priorFile(), '--lane-classes', 'logic,docs'];
  for (const precompose of ['true', 'false']) {
    git(dir, 'config', 'core.precomposeUnicode', precompose);
    const report = json(...fixRound);
    assert.deepEqual(Object.keys(report.fileClasses).sort(), ['README.md', NFD_GATE].sort(), `core.precomposeUnicode ${precompose}`);
    assert.equal(report.files, 2, `core.precomposeUnicode ${precompose}: the dropped guard file is read`);
    assert.ok(report.reviews.some((review) => review.plan.mutation?.maxMutants > 0), 'the code file keeps the mutation plan');
  }
});

test('spec check F12: two paths that differ only in bytes that are not UTF-8 are never read as one: such a path is exit 2 naming its bytes', () => {
  const { dir, tier } = lane();
  const [first, second] = [0xff, 0xfe].map((byte) => Buffer.concat([Buffer.from('src/g'), Buffer.from([byte]), Buffer.from('te.mjs')]));
  commitEntries(dir, [{ text: GATE_GUARDED, path: first }, { text: EXEC_FILE, path: second }], 'feat: two names');
  const result = tier('--json');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /a changed path is not UTF-8 \(.*bytes 7372632f67f[ef]74652e6d6a73\)/);
});

/** Probe p13 (C): the lane adds the guard, then docs (reviewed); the fix edits only the README. Returns the guard blob's oid as HEAD has it. */
function docsFixOnGuardLane() {
  const made = guardLane();
  made.write('README.md', '# r\nusage!\n');
  const fixRound = ['--delta', made.reviewed, '--base', made.base, '--prior', made.prior, '--lane-classes', 'logic,docs', '--json'];
  return { ...made, fixRound, guardBlob: git(made.dir, 'rev-parse', 'HEAD:src/gate.mjs') };
}

const assertRefused = (result, oid, name) => {
  assert.equal(result.status, 2, `${name}: ${result.stderr}`);
  assert.equal(result.stdout, '', name);
  assert.ok(result.stderr.includes(`object ${oid} does not hash to its name`), `${name}: ${result.stderr}`);
  assert.match(result.stderr, /the objects of this repository cannot be trusted: .*Nothing was read from them/, name);
};

test('security B11 (probe p13 C): a blob rewritten in place, loose or behind a forged pack index, is exit 2 naming the object, in a fix round and in a first review', () => {
  for (const [name, forge] of [['loose', (dir, oid) => rewriteLooseObject(dir, oid, 'blob', GATE_OPEN)], ['packed', (dir, oid) => forgePackedBlob(dir, oid, GATE_OPEN)]]) {
    const { dir, tier, fixRound, guardBlob } = docsFixOnGuardLane();
    assert.equal(tier(...fixRound).status, 0, `${name}: the control round`);
    forge(dir, guardBlob);
    assert.equal(git(dir, 'cat-file', '-p', 'HEAD:src/gate.mjs'), GATE_OPEN.trim(), `${name}: git itself now reads the gate without its guard`);
    assert.equal(git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD'), 'README.md', `${name}: and shows a docs-only fix`);
    for (const args of [fixRound, ['main...HEAD', '--landing', '--json'], ['--json']]) assertRefused(tier(...args), guardBlob, `${name}: ${args[0]}`);
  }
});

test('security B11: a commit rewritten in place (another parent under the same name) is exit 2 naming the commit, before any ancestry is read', () => {
  const { dir, tier, fixRound, reviewed, guard, base } = docsFixOnGuardLane();
  const body = git(dir, 'cat-file', 'commit', reviewed).replace(`parent ${guard}`, `parent ${base}`);
  rewriteLooseObject(dir, reviewed, 'commit', `${body}\n`);
  assert.equal(git(dir, 'rev-parse', `${reviewed}^`), base, 'git itself now takes the base for the reviewed commit\'s parent');
  for (const args of [fixRound, ['main...HEAD', '--json']]) assertRefused(tier(...args), reviewed, args[0]);
});

test('security B11: a file the lane never touches is checked too: its blob rewritten in place, or missing, is exit 2 naming it', () => {
  const rewritten = docsFixOnGuardLane();
  const notes = git(rewritten.dir, 'rev-parse', 'HEAD:NOTES.md');
  rewriteLooseObject(rewritten.dir, notes, 'blob', 'y\n');
  assertRefused(rewritten.tier(...rewritten.fixRound), notes, 'an unchanged file, rewritten');
  const missing = docsFixOnGuardLane();
  rmSync(looseObjectFile(missing.dir, notes));
  const result = missing.tier(...missing.fixRound);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes(`object ${notes} is missing`), result.stderr);
});

test('review R4-4: a lane file named like a pathspec (`:(exclude)src/guard.mjs`) takes nothing out of what a rewritten lane reads', { skip: process.platform === 'win32' && 'Windows takes no colon in a file name' }, () => {
  const guard = "export function guard(x) {\n  if (!x) throw new Error('no');\n  return x;\n}\n";
  const { dir, write, json } = lane();
  write('src/guard.mjs', guard);
  const reviewed = write(':(exclude)src/guard.mjs', 'not a pattern\n');
  writeFileSync(join(dir, 'src', 'guard.mjs'), guard.replace("  if (!x) throw new Error('no');\n", ''));
  git(dir, 'commit', '-q', '-a', '--amend', '-m', 'lane rewritten');
  const report = json('--delta', reviewed, '--prior', priorFile(), '--lane-classes', 'logic');
  assert.match(report.range, /rewritten lane/);
  assert.deepEqual(Object.keys(report.fileClasses).sort(), [':(exclude)src/guard.mjs', 'src/guard.mjs']);
  assert.equal(report.changedLines, 5, 'the three lines of the lane now, the pattern-named file, and the reviewed line the rewrite removed');
});
