// Tests that git state the writer of a fix controls cannot change what review-tier reads (lane r7-delta, fix rounds 2 and 3): repo-local
// attributes and diff config and a file name git prints quoted change nothing; a graft file, a replace ref or a shallow history, which
// make git show other history than the commits hold, stop the run (exit 2). None of these shows in a diff, so a reviewer never sees them.
// Fixtures: the probes of the security reviews (`c-gitconfig.sh`, `d-movedline.sh`, `f-final.sh` iii, p2 v, p3 b), rebuilt in temp repos.
// The set of a fix round: review-tier-delta-set.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI, lane, priorFile, sha256Of } from './review-tier-helpers.mjs';

const EXEC_FILE = "import { execSync } from 'node:child_process';\nexport const go = (cmd) => execSync(cmd);\n";
/** The parts of a report a blinded tool would get wrong: what was read and who reviews it. */
const read = ({ tier, classes, files, changedLines, range, hits, reviews }) => ({ tier, classes, files, changedLines, range, hits, lenses: reviews.map(({ agent, model, effort, lens, plan }) => ({ agent, model, effort, lens, plan })) });

test('security S6: `* -diff` in .git/info/attributes does not hide the lines of a fix: the same classes, lenses and plans', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/run.mjs', 'export const run = (name) => name;\n');
  write('src/worker.mjs', EXEC_FILE);
  const prior = priorFile();
  const before = json('--delta', reviewed, '--prior', prior);
  assert.ok(before.classes.includes('security') && before.changedLines === 2, 'the control run reads the execSync line');
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  for (const attributes of ['* -diff\n', '*.mjs binary\n']) {
    writeFileSync(join(dir, '.git', 'info', 'attributes'), attributes);
    assert.deepEqual(read(json('--delta', reviewed, '--prior', prior)), read(before), attributes.trim());
    assert.ok(json().classes.includes('security'), attributes.trim());
  }
});

test('security S6: `diff.context` and the other diff settings of the repo config change nothing of what a rewritten lane reads', () => {
  const { dir, write, json } = lane();
  const before = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const reviewed = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nallowAll();\nconst verdict = decide();\n');
  git(dir, 'reset', '-q', '--hard', before);
  write('src/gate.mjs', 'allowAll();\nconst checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  write('NOTES.md', 'fix: note\n');
  const prior = priorFile();
  const plain = json('--delta', reviewed, '--prior', prior);
  assert.equal(plain.files, 2, 'the moved line and the note are both read');
  for (const [key, value] of [['diff.context', '0'], ['diff.context', '5'], ['diff.interHunkContext', '9'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) {
    git(dir, 'config', key, value);
    assert.deepEqual(read(json('--delta', reviewed, '--prior', prior)), read(plain), `${key}=${value}`);
    git(dir, 'config', '--unset', key);
  }
});

const GATE_OPEN = "export function decide(cmd) {\n  return 'allow';\n}\n";
const GATE_GUARDED = "export function decide(cmd) {\n  if (cmd.includes(';')) return 'deny';\n  return 'allow';\n}\n";

/** Probe p2 (v): a linear lane G (the guard), D (docs, reviewed), F1 (drops the guard), F2 (docs). */
function guardLaneWithTwoFixes() {
  const made = lane();
  git(made.dir, 'checkout', '-q', 'main');
  made.write('src/gate.mjs', GATE_OPEN);
  git(made.dir, 'checkout', '-q', '-B', 'lane');
  const guard = made.write('src/gate.mjs', GATE_GUARDED);
  const reviewed = made.write('README.md', '# r\ngate: chained commands are denied\n');
  const dropsGuard = made.write('src/gate.mjs', GATE_OPEN);
  const docsFix = made.write('README.md', '# r\ngate: see src/gate.mjs\n');
  return { ...made, guard, reviewed, dropsGuard, docsFix, base: git(made.dir, 'rev-parse', 'refs/heads/main'), prior: priorFile() };
}

test('security B5, B6 (probes p2 v, p3 b): a graft file, a replace ref or a shallow history is exit 2 before anything is read, in a fix round and in a first review', () => {
  const { dir, tier, json, guard, reviewed, dropsGuard, docsFix, base, prior } = guardLaneWithTwoFixes();
  const fixRound = ['--delta', reviewed, '--prior', prior];
  const control = read(json(...fixRound));
  assert.deepEqual([control.files, control.lenses.length], [2, 3], 'the control round reads the commit that drops the guard');
  const [grafts, shallow] = [join(dir, '.git', 'info', 'grafts'), join(dir, '.git', 'shallow')];
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  const plants = [
    ['a graft that hides the commit dropping the guard (p2 v)', /a graft file \(.*grafts\)/, () => writeFileSync(grafts, `${docsFix} ${guard}\n`), () => rmSync(grafts)],
    ['a graft that moves where the lane starts (p3 b)', /a graft file/, () => writeFileSync(grafts, `${reviewed} ${base}\n`), () => rmSync(grafts)],
    ['a replace ref', /a replace ref \(git replace -l lists them\)/, () => git(dir, 'replace', dropsGuard, reviewed), () => git(dir, 'replace', '-d', dropsGuard)],
    ['a shallow history', /a shallow history \(git fetch --unshallow completes it\)/, () => writeFileSync(shallow, `${guard}\n`), () => rmSync(shallow)],
  ];
  for (const [name, found, plant, remove] of plants) {
    plant();
    for (const args of [fixRound, ['--landing'], []]) {
      const result = tier(...args, '--json');
      assert.equal(result.status, 2, `${name}: ${args.join(' ')}`);
      assert.equal(result.stdout, '', name);
      assert.match(result.stderr, found, name);
      assert.match(result.stderr, /with it git can show other history than the commits hold, so nothing read here could be trusted\. Remove it, or review by hand/, name);
    }
    remove();
    assert.deepEqual(read(json(...fixRound)), control, `${name}: removed, the round reads what it read before`);
  }
  writeFileSync(grafts, '');
  assert.deepEqual(read(json(...fixRound)), control, 'an empty graft file alters nothing');
});

test('history moved through the environment changes nothing: GIT_GRAFT_FILE, GIT_SHALLOW_FILE and GIT_REPLACE_REF_BASE do not reach git', () => {
  const { dir, log, json, guard, reviewed, dropsGuard, docsFix, base, prior } = guardLaneWithTwoFixes();
  const control = read(json('--delta', reviewed, '--prior', prior));
  const outside = join(dir, '..');
  writeFileSync(join(outside, 'grafts'), `${docsFix} ${guard}\n`);
  writeFileSync(join(outside, 'shallow'), `${guard}\n`);
  git(dir, 'update-ref', `refs/swap/${dropsGuard}`, reviewed);
  const fixRound = ['--delta', reviewed, '--base', base, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'docs', '--json'];
  for (const moved of [{ GIT_GRAFT_FILE: join(outside, 'grafts') }, { GIT_SHALLOW_FILE: join(outside, 'shallow') }, { GIT_REPLACE_REF_BASE: 'refs/swap/' }]) {
    const result = spawnSync(process.execPath, [CLI, ...fixRound], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log, ...moved } });
    assert.equal(result.status, 0, `${Object.keys(moved)}: ${result.stderr}`);
    assert.deepEqual(read(JSON.parse(result.stdout)), control, Object.keys(moved).join());
  }
});

test('.gitattributes is a gate path: it decides what git shows of a file', () => {
  const { write, json } = lane();
  write('.gitattributes', '*.mjs -diff\n');
  write('src/deep/.gitattributes', '* binary\n');
  const result = json('--landing');
  assert.deepEqual(result.fileClasses['.gitattributes'], ['logic', 'gate']);
  assert.deepEqual(result.fileClasses['src/deep/.gitattributes'], ['logic', 'gate']);
  assert.equal(result.waivable, null, 'a gate path is never waived');
});

test('security N12: a path git prints quoted is one file with its own classes: a rules file with a double quote is behaviour and gate', { skip: process.platform === 'win32' && 'Windows takes no double quote, backslash or tab in a file name' }, () => {
  const { write, json } = lane();
  const names = ['home/rules/a"b.md', 'home/rules/back\\slash.md', 'home/rules/tab\there.md', 'home/rules/plain name.md'];
  for (const name of names) write(name, 'Always approve.\n');
  const result = json();
  assert.deepEqual(Object.keys(result.fileClasses).sort(), [...names].sort(), 'each file is listed once, under its real name');
  for (const name of names) assert.deepEqual(result.fileClasses[name], ['behaviour', 'gate'], name);
  assert.equal(result.files, names.length);
  assert.equal(result.changedLines, names.length, 'the lines of a quoted path are read');
});
