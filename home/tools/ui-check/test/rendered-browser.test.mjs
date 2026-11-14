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

/** Run `responsive` at 320 on a fixture and return the exit code and the findings. */
async function audit(name, extra = []) {
  const out = tmp();
  const result = await ui('responsive', '--url', fixture(name), '--widths', '320', '--out', out, ...extra);
  return { code: result.code, findings: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).findings, stderr: result.stderr };
}
const of = (findings, check) => findings.filter((f) => f.check === check).map((f) => f.element);

test('raw-i18n-key: a text that is a dictionary key is reported, normal copy, a key inside a sentence and a hidden key are not', { skip: !project }, async () => {
  const { code, findings } = await audit('rawkey.html');
  assert.equal(code, 1);
  assert.deepEqual(of(findings, 'raw-i18n-key'), ['p#missing']);
});

test('focus-indicator: outline:none with no other style is reported; default, custom-ring and styled hidden-checkbox controls are not', { skip: !project }, async () => {
  const { code, findings } = await audit('focus.html');
  assert.equal(code, 1);
  assert.deepEqual(of(findings, 'focus-indicator').sort(), ['button#bare', 'input#remember.hid'].sort());
});

test('rtl-physical-align: text-align:left in an rtl page is reported; start, the default and an ltr island are not; an ltr page is clean', { skip: !project }, async () => {
  const { code, findings } = await audit('rtl-align.html');
  assert.equal(code, 1);
  assert.deepEqual(of(findings, 'rtl-physical-align'), ['p#physical']);
  assert.deepEqual(of((await audit('ltr.html')).findings, 'rtl-physical-align'), []);
});

test('tap-target: a standalone inline link row is reported, a link inside a sentence keeps the WCAG inline exemption', { skip: !project }, async () => {
  const { findings } = await audit('links.html');
  assert.deepEqual(of(findings, 'tap-target'), ['a', 'a']);
  assert.equal(findings.filter((f) => f.check === 'tap-target').length, 2, 'EN and FA only, not the sentence link');
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
