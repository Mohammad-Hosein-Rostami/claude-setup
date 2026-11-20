// Tests of where review-tier takes git attributes from (lane r7-delta, fix round 5, S8, K5, A1): from the tree of the lane's start,
// never from the lane's own tree and never from a file on the machine. The diff driver an attribute names picks the hunk heads, and
// those name the changed function: without the start's `*.py diff=python` a changed Python method loses its definition and its callers
// from the reading list (probe p24 of the security review). A lane cannot take that away, or hide a file, with an attribute of its own.
// A start line git only warns about changes nothing (review R6-1), and the caller's character locale picks the hunk heads (fix 6, K1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { CLI, lane, priorFile, sha256Of } from './review-tier-helpers.mjs';

const STORE = 'class Store:\n    def __init__(self):\n        self.items = []\n\n    def save(self, item):\n        if item is None:\n            raise ValueError("no item")\n        self.items.append(item)\n        return True\n';
const USE_STORE = 'from app import Store\n\n\ndef run():\n    return Store().save(1)\n';
const GATE = "export function decide(cmd) {\n  return 'allow';\n}\n";
const USE_GATE = "import { decide } from './gate.mjs';\nexport function run(c) {\n  return decide(c);\n}\n";
const METHOD = 'src/app.py:5';
const METHOD_CALLER = 'src/use.py:5';
const GATE_CALLERS = ['src/run.mjs:1', 'src/run.mjs:3'];

/**
 * A lane whose fix changes one line inside a Python method and one inside a JavaScript function, both called from files the lane
 * never touches.
 * @param {Object<string, string>} startFiles attribute files the start holds (path to text)
 * @param {string} [laneAttributes] the text the lane's first commit gives the root `.gitattributes`
 * @returns {{first: string[], fix: string[]}} the reading lists of the first review and of the fix round
 */
function readingOf(startFiles, laneAttributes) {
  const { dir, write, json } = lane();
  git(dir, 'checkout', '-q', 'main');
  for (const [path, text] of Object.entries(startFiles)) write(path, text);
  for (const [path, text] of [['src/use.py', USE_STORE], ['src/gate.mjs', GATE], ['src/run.mjs', USE_GATE]]) write(path, text);
  const start = write('src/app.py', STORE);
  git(dir, 'checkout', '-q', '-B', 'lane');
  if (laneAttributes !== undefined) {
    writeFileSync(join(dir, '.gitattributes'), laneAttributes);
    git(dir, 'add', '--', '.gitattributes');
  }
  const reviewed = write('src/app.py', STORE.replace('"no item"', '"none"'));
  writeFileSync(join(dir, 'src', 'gate.mjs'), GATE.replace("'allow'", "'allowed'"));
  git(dir, 'add', '--', 'src/gate.mjs');
  write('src/app.py', STORE.replace('"no item"', '"nothing"'));
  const reading = (report) => [...new Set(report.reviews.flatMap((review) => review.requiredReading ?? []))].sort();
  return { first: reading(json('main...HEAD')), fix: reading(json('--delta', reviewed, '--base', start, '--prior', priorFile(), '--lane-classes', 'logic')) };
}

test('security S8 (probe p24): a diff driver the lane start sets for *.py names the changed method, so its definition and its caller are in the reading list of a fix round', () => {
  for (const startFiles of [{ '.gitattributes': '*.py diff=python\n' }, { 'src/.gitattributes': '*.py diff=python\n' }]) {
    const { fix } = readingOf(startFiles);
    const name = Object.keys(startFiles)[0];
    assert.ok(fix.includes(METHOD) && fix.includes(METHOD_CALLER), `${name}: ${fix}`);
    assert.ok(GATE_CALLERS.every((place) => fix.includes(place)), `${name}: ${fix}`);
  }
  const { fix: plain } = readingOf({});
  assert.ok(!plain.includes(METHOD_CALLER), `with no driver git names the class, not the method: ${plain}`);
});

test('spec check K8 (c): an attribute the lane adds itself changes nothing: *.mjs binary, *.mjs diff=tex, and the start\'s line replaced by "no diff at all" leave both reading lists as they were', () => {
  const start = { '.gitattributes': '*.py diff=python\n' };
  const control = readingOf(start);
  assert.ok(GATE_CALLERS.every((place) => control.fix.includes(place)), `${control.fix}`);
  for (const laneAttributes of ['*.py diff=python\n*.mjs binary\n', '*.py diff=python\n*.mjs diff=tex\n', '* -text -diff\n*.py diff=tex\n']) {
    assert.deepEqual(readingOf(start, laneAttributes), control, laneAttributes);
  }
});

test('review R6-1: a line of the start\'s attributes git only warns about (a negative pattern, a macro in a sub-folder, an invalid name) changes nothing: both rounds run and read what they read without it', () => {
  const start = { '.gitattributes': '*.py diff=python\n' };
  const control = readingOf(start);
  for (const [path, line] of [['.gitattributes', '!*.txt diff\n'], ['src/.gitattributes', '[attr]bin -diff -merge -text\n'], ['.gitattributes', '*.md @odd\n']]) {
    assert.deepEqual(readingOf({ ...start, [path]: `${start[path] ?? ''}${line}` }), control, `${path}: ${line}`);
  }
});

test('spec check K1 (fix 6): the trusted calls keep the caller\'s character locale, so a Python function line that is not UTF-8 gives the hunk head git gives the caller', () => {
  const { dir, log, write } = lane();
  git(dir, 'checkout', '-q', 'main');
  write('.gitattributes', '*.py diff=python\n');
  write('src/use.py', 'from lat import helper_x\n\n\ndef run():\n    return helper_x()\n');
  const body = (last) => Buffer.from(`def helper_x():  # caf\xe9\n${['a', 'b', 'c', 'd', 'e', 'f'].map((name, at) => `    ${name} = ${at}\n`).join('')}    return ${last}\n`, 'latin1');
  const start = write('src/lat.py', body('1'));
  git(dir, 'checkout', '-q', '-B', 'lane');
  const reviewed = write('src/lat.py', body('2'));
  const head = write('src/lat.py', body('3'));
  const parentLocale = { ...Object.fromEntries(Object.entries(CLEAN_ENV).filter(([name]) => !/^(LC_|LANGUAGE$)/.test(name))), LANG: 'en_US.UTF-8' };
  const heads = spawnSync('git', [`--attr-source=${start}`, 'diff', '-U0', '--no-color', reviewed, head], { cwd: dir, env: parentLocale }).stdout.toString('latin1');
  const prior = priorFile();
  const args = ['--delta', reviewed, '--base', start, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic', '--json'];
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...parentLocale, REVIEW_TIER_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  const reading = JSON.parse(result.stdout).reviews[0].requiredReading;
  assert.equal(reading.includes('src/use.py:5'), heads.includes('def helper_x'), `git in the caller's locale: ${heads}; the tool read: ${reading}`);
});

test('spec check A1: an attribute pattern matches a path by its exact letters on every OS: *.PY does not set the driver of app.py', () => {
  const { fix } = readingOf({ '.gitattributes': '*.PY diff=python\n' });
  assert.ok(!fix.includes(METHOD_CALLER), `${fix}`);
  assert.deepEqual(fix, readingOf({}).fix, 'the same list as with no attributes at all');
});
