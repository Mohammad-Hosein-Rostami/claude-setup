// Purpose: Chromium tests (need UI_CHECK_PROJECT) for `batch --jobs` and `--resume` on a 12-state file of local fixtures: --jobs 4 gives the same
// records as --jobs 1, progress lines go to stderr, and --resume re-runs only the state that failed. Exports: none.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const fixture = (name) => pathToFileURL(path.join(here, 'fixtures', name)).href;
const PAGES = ['ltr.html', 'rtl-ok.html', 'card.html', 'rawkey.html'];
const FAILING_STATE = 's5'; // the only state on rtl.html (a bidi-field finding); the hints of the other pages never fail a state

async function ui(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function writeStates(dir) {
  const states = Array.from({ length: 12 }, (_, i) => ({ surface: `page${i % 3}`, state: `s${i}`, locale: 'en', url: fixture(i === 5 ? 'rtl.html' : PAGES[i % 3]), widths: i % 2 ? [320] : [320, 390] }));
  const file = path.join(dir, 'states.json');
  fs.writeFileSync(file, JSON.stringify({ states }));
  return file;
}

/** Records with the out directory removed from the evidence path, so two runs in different folders compare equal. */
function records(out) {
  const raw = fs.readFileSync(path.join(out, 'results.json'), 'utf8').replaceAll(out, '<out>');
  return JSON.parse(raw);
}

test('batch --jobs 4 gives the same records as --jobs 1, in states-file order, with one progress line per state on stderr', { skip: !project }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-jobs-'));
  const file = writeStates(dir);
  const serial = await ui('batch', '--states', file, '--jobs', '1', '--out', path.join(dir, 'one'));
  const parallel = await ui('batch', '--states', file, '--jobs', '4', '--out', path.join(dir, 'four'));
  assert.equal(serial.code, 1, serial.stdout + serial.stderr);
  assert.equal(parallel.code, 1, parallel.stdout + parallel.stderr);
  const a = records(path.join(dir, 'one'));
  assert.deepEqual(records(path.join(dir, 'four')), a);
  assert.ok(a.every((r) => Number.isInteger(r.hints)), 'every record carries its hint count');
  assert.equal(a.length, 18, '6 states x 2 widths + 6 states x 1 width');
  assert.deepEqual(a.map((r) => r.state).filter((s, i, all) => all.indexOf(s) === i), Array.from({ length: 12 }, (_, i) => `s${i}`));
  assert.deepEqual(a.filter((r) => r.status === 'fail').map((r) => r.state), [FAILING_STATE]);
  const lines = parallel.stderr.split('\n').filter((l) => /^\[\d+\/12\] /.test(l));
  assert.equal(lines.length, 12);
  assert.ok(lines.some((l) => /^\[\d+\/12\] page2 s5 en 320 fail \d+\.\ds$/.test(l)), lines.join('\n'));
  assert.ok(lines.every((l) => /^\[\d+\/12\] page\d s\d+ en [\d,]+ (pass|fail) \d+\.\ds$/.test(l)), lines.join('\n'));
  assert.equal(fs.existsSync(path.join(dir, 'four', 'results.partial.json')), false, 'the checkpoint is removed after a complete run');
});

test('batch --resume keeps the passing states and re-runs only the failing one; without --resume the old files are gone', { skip: !project }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-resume-'));
  const file = writeStates(dir);
  const out = path.join(dir, 'out');
  assert.equal((await ui('batch', '--states', file, '--out', out)).code, 1);
  const before = fs.readFileSync(path.join(out, 'results.json'), 'utf8');
  const resumed = await ui('batch', '--states', file, '--resume', '--out', out);
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /resume: 11 of 12 states already pass and are kept, 1 to run/);
  const lines = resumed.stderr.split('\n').filter((l) => /^\[\d+\/\d+\] /.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[1\/1\] page\d s5 en 320 fail/);
  assert.equal(fs.readFileSync(path.join(out, 'results.json'), 'utf8'), before, 'same records, same order');
  const fresh = await ui('batch', '--states', file, '--only', 'page0', '--out', out);
  assert.equal(fresh.code, 0, 'without --resume the previous results are deleted: only page0 states ran');
  assert.ok(records(out).every((r) => r.surface === 'page0'));
});
