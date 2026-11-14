// Purpose: Chromium tests (need UI_CHECK_PROJECT) for the v2 responsive findings (raw-i18n-key, focus-indicator, rtl-physical-align, tap-target)
// and the step diagnostics (focus on a div, click on a covered input), each on a local fixture. Exports: none.
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-rendered-'));

async function ui(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Run `responsive` at 320 on a fixture and return the exit code, the failing findings and the hints (report.json). */
async function audit(name, extra = []) {
  const out = tmp();
  const result = await ui('responsive', '--url', fixture(name), '--widths', '320', '--out', out, ...extra);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  return { code: result.code, findings: report.findings, hints: report.hints, md: fs.readFileSync(path.join(out, 'report.md'), 'utf8'), stderr: result.stderr };
}
const of = (list, check) => list.filter((f) => f.check === check).map((f) => f.element);

test('raw-i18n-key hint: a text that is a dictionary key is listed, normal copy, a key inside a sentence and a hidden key are not; the run still passes', { skip: !project }, async () => {
  const { code, findings, hints, md } = await audit('rawkey.html');
  assert.equal(code, 0, 'a hint never fails the run');
  assert.deepEqual(findings, []);
  assert.deepEqual(of(hints, 'raw-i18n-key'), ['p#missing']);
  assert.match(md, /## Hints[\s\S]*raw-i18n-key/);
});

test('focus-indicator hint: outline:none with no other style is listed; default, custom-ring and styled hidden-checkbox controls are not; exit stays 0', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('focus.html');
  assert.equal(code, 0);
  assert.deepEqual(findings, []);
  assert.deepEqual(of(hints, 'focus-indicator').sort(), ['button#bare', 'input#remember.hid'].sort());
});

test('rtl-physical-align hint: text-align:left in an rtl page is listed; start, the default and an ltr island are not; an ltr page is clean', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('rtl-align.html');
  assert.equal(code, 0);
  assert.deepEqual(findings, []);
  assert.deepEqual(of(hints, 'rtl-physical-align'), ['p#physical']);
  assert.deepEqual(of((await audit('ltr.html')).hints, 'rtl-physical-align'), []);
});

test('target size: a standalone inline link row is a target-size? hint only (the failing tap-target check is unchanged), a link in a sentence is neither', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('links.html');
  assert.equal(code, 0);
  assert.deepEqual(of(findings, 'tap-target'), []);
  assert.deepEqual(of(hints, 'target-size?'), ['a', 'a'], 'EN and FA only, not the sentence link');
});

const noIndicator = async (name) => of((await audit(name)).hints, 'focus-indicator');

test('focus-indicator precision (reviewer focus1.html): wrappers (focus-within, :has), pseudo-elements, sibling underline, transitions, child ring, gradient, transform, one colour step and a skip link count; only colour-only and a bare summary are reported', { skip: !project }, async () => {
  assert.deepEqual((await noIndicator('review-focus1.html')).sort(), ['a#col.col', 'summary#sum']);
});

test('focus-indicator precision (reviewer focus2.html): a far sibling of a hidden toggle, a delayed transition, a shadow host, delegatesFocus and a scroll region count; the walk continues past an iframe and shadow hosts', { skip: !project }, async () => {
  assert.deepEqual(await noIndicator('review-focus2.html'), ['a#afterbare']);
});

test('focus-indicator walk continues past an iframe (focus3.html) and past a shadow host with inner buttons (focus4.html)', { skip: !project }, async () => {
  assert.deepEqual((await noIndicator('review-focus3.html')).sort(), ['button#afterframe', 'button#first']);
  assert.deepEqual((await noIndicator('review-focus4.html')).sort(), ['button#aftershadow', 'button#first']);
});

test('target size (reviewer tap.html): nav, breadcrumb, pagination, footer and language links hint; links in a sentence, also inside strong/em or an inline wrapper, do not; an inline-block stays a failing tap-target', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('review-tap.html');
  assert.equal(code, 1);
  // Chromium computes `display: inline-block` for a <button> written display:inline, so main's rule reports it too.
  assert.deepEqual(of(findings, 'tap-target'), ['a#i2', 'button#ib']);
  assert.deepEqual(of(hints, 'target-size?').sort(), ['a#n1', 'a#n2', 'a#n3', 'a#n4', 'a#n5', 'a#b1', 'a#b2', 'a#p1', 'a#p2', 'a#p3', 'a#f1', 'a#f2', 'a#i1', 'a#l1', 'a#l2'].sort());
});

test('focus on a div without tabindex fails the step, naming the step', { skip: !project }, async () => {
  const dir = tmp();
  const steps = path.join(dir, 'steps.json');
  fs.writeFileSync(steps, JSON.stringify([{ action: 'focus', selector: '#role' }]));
  const result = await ui('responsive', '--url', fixture('covered.html'), '--widths', '320', '--steps', steps, '--out', path.join(dir, 'o'));
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /step 1 \(focus\).*did not take focus/);
});

test('click on a covered input names the covering element and hints at the label', { skip: !project }, async () => {
  const dir = tmp();
  const steps = path.join(dir, 'steps.json');
  fs.writeFileSync(steps, JSON.stringify([{ action: 'click', selector: '#terms' }]));
  const result = await ui('responsive', '--url', fixture('covered.html'), '--widths', '320', '--steps', steps, '--out', path.join(dir, 'o'));
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /step 1 \(click\)/);
  assert.match(result.stderr, /covered at its centre by <label id="veil" class="ds-check big">/);
  assert.match(result.stderr, /click its label instead/);
});
