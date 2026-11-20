// Tests that git state the writer of a fix controls cannot change what review-tier reads (lane r7-delta, fix round 2): repo-local
// attributes and diff config, a replace ref and a file name git prints quoted. None of these shows in a diff, so a reviewer never sees them.
// Fixtures: the probes of the security review (`c-gitconfig.sh`, `d-movedline.sh`, `f-final.sh` iii), rebuilt in temp repos.
// The set of a fix round: review-tier-delta-set.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git-tidy-helpers.mjs';
import { lane, priorFile } from './review-tier-helpers.mjs';

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

test('security S6: `diff.context 0` in the repo config does not make a moved line an already reviewed patch', () => {
  const { dir, write, json } = lane();
  const before = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  const reviewed = write('src/gate.mjs', 'const checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nallowAll();\nconst verdict = decide();\n');
  git(dir, 'reset', '-q', '--hard', before);
  write('src/gate.mjs', 'allowAll();\nconst checks = [];\nchecks.push(isTrusted);\nrunChecks(checks);\nconst verdict = decide();\n');
  write('NOTES.md', 'fix: note\n');
  const prior = priorFile();
  const plain = json('--delta', reviewed, '--prior', prior);
  assert.equal(plain.files, 2, 'the moved line and the note are both read');
  for (const [key, value] of [['diff.context', '0'], ['diff.interHunkContext', '9'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) {
    git(dir, 'config', key, value);
    assert.deepEqual(read(json('--delta', reviewed, '--prior', prior)), read(plain), `${key}=${value}`);
    git(dir, 'config', '--unset', key);
  }
});

test('a replace ref cannot swap the fix commit for a harmless one', () => {
  const { dir, write, json } = lane();
  const reviewed = write('src/run.mjs', 'export const run = (name) => name;\n');
  git(dir, 'checkout', '-q', '-b', 'harmless');
  const docsOnly = write('README.md', '# usage\n');
  git(dir, 'checkout', '-q', 'lane');
  const fix = write('src/worker.mjs', EXEC_FILE);
  const prior = priorFile();
  const before = json('--delta', reviewed, '--prior', prior);
  git(dir, 'replace', fix, docsOnly);
  assert.equal(git(dir, 'diff', '--name-only', `${reviewed}..HEAD`), 'README.md', 'plain git now shows the harmless commit');
  assert.deepEqual(read(json('--delta', reviewed, '--prior', prior)), read(before));
  assert.ok(json().classes.includes('security'), 'a first review reads the real commit too');
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
