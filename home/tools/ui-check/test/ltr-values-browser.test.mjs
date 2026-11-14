// Purpose: Chromium tests (need UI_CHECK_PROJECT) for "only the typed value is left to right": the correct technique passes empty and filled, `dir="ltr"` with a
// translated placeholder fails `bidi-placeholder`, the probe leaves the page as it found it, the three text hints, and `same-as-default?` through `batch`.
// Exports: none.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditInPage } from '../lib/audit.mjs';
import { launch, loadChromium, openPage } from '../lib/browser.mjs';

const run = promisify(execFile);
const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const fixture = (name) => pathToFileURL(path.join(here, 'fixtures', name)).href;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-ltr-values-'));

async function ui(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** Run `responsive` on a fixture and return the exit code, the failing findings and the hints (report.json). */
async function audit(name, extra = [], widths = '320') {
  const out = tmp();
  const result = await ui('responsive', '--url', fixture(name), '--widths', widths, '--out', out, ...extra);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  return { code: result.code, findings: report.findings, hints: report.hints, md: fs.readFileSync(path.join(out, 'report.md'), 'utf8') };
}
const of = (list, check) => list.filter((f) => f.check === check).map((f) => f.element);
const NEW_CHECKS = ['bidi-field', 'bidi-field?', 'bidi-placeholder', 'bidi-placeholder?', 'ltr-run-in-rtl?', 'untranslated?'];
const fromNewChecks = (list) => list.filter((f) => NEW_CHECKS.includes(f.check));

test('the correct technique (:not(:placeholder-shown) rule, translated placeholders, a filled field, readonly, disabled, a textarea) passes at 320 and 1280 with no new finding or hint', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('ltr-value-ok.html', [], '320,1280');
  assert.equal(code, 0, JSON.stringify(findings));
  assert.deepEqual(fromNewChecks(findings), []);
  assert.deepEqual(fromNewChecks(hints), []);
});

test('dir="ltr" with a Persian placeholder fails bidi-placeholder; a digits-only placeholder with dir="ltr" does not; a filled email computing rtl fails bidi-field, an empty one is only the hint bidi-field?', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('ltr-value-bad.html');
  assert.equal(code, 1);
  assert.deepEqual(of(findings, 'bidi-placeholder').sort(), ['input#dirltr', 'input#telua'], 'tel inputs are ltr by the browser style, so their Persian placeholder is too');
  assert.deepEqual(of(findings, 'bidi-field'), ['input#filledmail']);
  const empty = findings.find((f) => f.check === 'bidi-field?' && f.element === 'input#emptymail');
  assert.match(empty.detail, /could not confirm from an empty field: run a state that types a value/);
  assert.deepEqual(of(hints, 'bidi-placeholder?'), ['input#leftph'], 'text-align: left on an rtl placeholder is a hint, not a failure');
});

test('a page that sets the direction from an input listener passes while its fields are empty (a hint at most); the same fields holding a value and computing rtl fail', { skip: !project }, async () => {
  const { code, findings } = await audit('ltr-script-direction.html');
  assert.equal(code, 0, JSON.stringify(findings));
  assert.deepEqual(of(findings, 'bidi-field'), []);
  assert.deepEqual(of(findings, 'bidi-field?').sort(), ['input#mail', 'input#phone'], 'the probe cannot confirm: the hint says to type a value');
  const typed = await ui('responsive', '--url', fixture('ltr-value-bad.html'), '--widths', '320', '--out', tmp());
  assert.equal(typed.code, 1, 'a value that really sits in the field and computes rtl still fails');
});

test('the probe touches text-like fields only: date, file, range, color, checkbox, radio, time and submit are never given a value; the audit returns and every value is as it was', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const page = await openPage(browser, { url: fixture('ltr-probe-types.html'), width: 320, height: 800 });
    const values = () => page.evaluate(() => [...document.querySelectorAll('input,textarea')].map((el) => [el.id, el.value, el.checked ?? null]));
    const before = await values();
    const facts = await page.evaluate(auditInPage, { minTarget: 24, minText: 12, smallViewport: 768, max: 50 });
    assert.deepEqual(await values(), before);
    const probed = facts.fields.filter((f) => f.probed).map((f) => f.element).sort();
    assert.deepEqual(probed, ['input#bogus', 'input#mail', 'textarea#note'], 'only the text-like fields were probed (an unknown type is a text field: el.type says so)');
    assert.deepEqual(facts.fields.filter((f) => !f.probed && f.element !== 'textarea#filled').map((f) => f.direction), Array(9).fill(null), 'nothing to judge on a field that is not text-like');
    assert.deepEqual(facts.texts.filter((t) => t.text.includes('hunter2')), [], "a textarea's own text is the user's data: not a page text, not saved for same-as-default?");
    await page.context().close();
  } finally {
    await browser.close();
  }
});

test('the direction context is the element that holds the field: an rtl section in an ltr document is judged (field, placeholder, English text), an ltr island inside it is not', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('ltr-context.html');
  assert.equal(code, 1);
  assert.deepEqual(of(findings, 'bidi-field'), ['input#sectionmail']);
  assert.deepEqual(of(findings, 'bidi-placeholder'), ['input#sectionphone']);
  const english = hints.find((h) => h.check === 'untranslated?').detail;
  assert.match(english, /^1 text in English.*"Back to login"/);
});

test('untranslated? reads placeholders, aria-label, title, alt and a submit button value; a Persian twin, a hidden label, a lang="en" span and a Persian sentence with a brand are not reported', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const page = await openPage(browser, { url: fixture('untranslated-sources.html'), width: 320, height: 800 });
    const facts = await page.evaluate(auditInPage, { minTarget: 24, minText: 12, smallViewport: 768, max: 50 });
    const attributes = facts.attributeTexts.filter((t) => t.visible).map((t) => t.text).sort();
    assert.deepEqual(attributes, ['Company logo', 'Close dialog', 'Enter your phone number', 'Learn more about us', 'Send message', 'بستن', 'شماره موبایل', 'ارسال'].sort());
    await page.context().close();
  } finally {
    await browser.close();
  }
  const { hints } = await audit('untranslated-sources.html');
  const row = hints.find((h) => h.check === 'untranslated?');
  assert.match(row.detail, /^5 texts in English on a right-to-left page: "Enter your phone number", "Close dialog", "Learn more about us", "Company logo", "Send message"\./);
});

test('many English texts are one untranslated? row, so the raw i18n key and the other hints stay in report.md', { skip: !project }, async () => {
  const { hints, md } = await audit('ltr-crowd.html');
  assert.equal(of(hints, 'untranslated?').length, 1);
  assert.match(md, /raw-i18n-key[^\n]*auth\.login\.title/);
  assert.doesNotMatch(md, /more hints in report\.json/);
});

test('the probe: value, selection, focus and the page listeners are untouched; no input, change or selectionchange reaches the page', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const page = await openPage(browser, { url: fixture('ltr-value-bad.html'), width: 320, height: 600 });
    await page.evaluate(() => {
      const typed = document.createElement('input'); // a text-like type that keeps a selection (email does not)
      typed.id = 'typed';
      typed.type = 'tel';
      document.body.append(typed);
      window.seen = [];
      for (const type of ['input', 'change', 'select', 'focus', 'blur', 'selectionchange']) document.addEventListener(type, () => window.seen.push(type), true);
      typed.value = 'hello world';
      document.getElementById('dirltr').focus(); // an empty field holds focus while it is probed
      typed.setSelectionRange(2, 7, 'backward');
    });
    await page.waitForTimeout(150); // the selectionchange of the setup itself arrives later; only what the probe causes is measured
    await page.evaluate(() => { window.seen.length = 0; });
    const state = () => page.evaluate(() => ['emptymail', 'filledmail', 'dirltr', 'typed'].map((id) => { const el = document.getElementById(id); return [id, el.value, el.type === 'email' ? null : [el.selectionStart, el.selectionEnd, el.selectionDirection]]; }).concat([[document.activeElement.id]]));
    const before = await state();
    const facts = await page.evaluate(auditInPage, { minTarget: 24, minText: 12, smallViewport: 768, max: 50 });
    await page.waitForTimeout(250);
    assert.deepEqual(await state(), before, 'value, selection and the focused element are as they were');
    assert.deepEqual(await page.evaluate(() => window.seen), [], 'the page saw no event');
    assert.deepEqual(facts.fields.filter((f) => f.element === 'input#emptymail').map((f) => [f.probed, f.direction]), [[true, 'rtl']], 'the probe still read the filled direction');
    await page.context().close();
  } finally {
    await browser.close();
  }
});

test('the probe does not run a framework value setter: an instance-level setter (as React installs on a controlled input) is never called, and its tracked value stays empty', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const page = await openPage(browser, { url: fixture('ltr-value-bad.html'), width: 320, height: 600 });
    await page.evaluate(() => {
      const el = document.getElementById('emptymail');
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      window.tracker = { calls: 0 };
      Object.defineProperty(el, 'value', { configurable: true, get: () => native.get.call(el), set: (v) => { window.tracker.calls += 1; native.set.call(el, v); } });
    });
    const facts = await page.evaluate(auditInPage, { minTarget: 24, minText: 12, smallViewport: 768, max: 50 });
    assert.equal(facts.fields.find((f) => f.element === 'input#emptymail').direction, 'rtl', 'the field was probed');
    assert.equal(await page.evaluate(() => window.tracker.calls), 0);
    await page.context().close();
  } finally {
    await browser.close();
  }
});

test('a field inside an open shadow root is judged, a contenteditable is ignored', { skip: !project }, async () => {
  const { findings, hints } = await audit('ltr-edge-fields.html');
  assert.deepEqual(of(findings, 'bidi-placeholder'), ['input#shadowphone']);
  assert.deepEqual(fromNewChecks(hints), []);
});

test('an ltr page gives no new finding and no new hint, whatever its text', { skip: !project }, async () => {
  const { code, findings, hints } = await audit('ltr.html');
  assert.equal(code, 0);
  assert.deepEqual(fromNewChecks(findings), []);
  assert.deepEqual(fromNewChecks(hints), []);
});

test('ltr-run-in-rtl? lists a bare phone, an email ending in a digit and a URL ending in a slash; bdi, dir="ltr", unicode-bidi: isolate, a plus alone and an email or URL with letters at both ends are not', { skip: !project }, async () => {
  const { code, hints } = await audit('ltr-run.html');
  assert.equal(code, 0, 'a hint never fails the run');
  assert.deepEqual(of(hints, 'ltr-run-in-rtl?').sort(), ['p#bare', 'p#mailnum', 'p#urlslash']);
});

test('untranslated? is one row naming English in a closed select, an open menu and a brand; Persian, translate="no", dir="ltr", code, hidden text and an allow-listed brand are not', { skip: !project }, async () => {
  const noList = await audit('untranslated.html');
  assert.equal(noList.code, 0);
  const [row, ...others] = noList.hints.filter((h) => h.check === 'untranslated?');
  assert.deepEqual(others, [], 'one row per page');
  assert.match(row.detail, /^3 texts in English on a right-to-left page: "Select your language", "Google Pay", "United Arab Emirates"\./);
  const allowed = await audit('untranslated.html', ['--same-in-all-locales', 'Google Pay, ICE']);
  assert.match(allowed.hints.find((h) => h.check === 'untranslated?').detail, /^2 texts .*"Select your language", "United Arab Emirates"\./);
});

test('batch same-as-default?: the same text in en and de is a hint on the de record only, with the brand allow-listed; every record passes; results.json stays plain', { skip: !project }, async () => {
  const dir = tmp();
  const statesFile = path.join(dir, 'states.json');
  const stateFor = (locale, page) => ({ surface: 'home', state: 'rest', locale, url: fixture(page), widths: [320] });
  fs.writeFileSync(statesFile, JSON.stringify({ defaults: { sameInAllLocales: ['ICE'] }, states: [stateFor('en', 'same-en.html'), stateFor('de', 'same-de.html')] }));
  const out = path.join(dir, 'out');
  const result = await ui('batch', '--states', statesFile, '--out', out, '--jobs', '1');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const records = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.deepEqual(records.map((r) => [r.locale, r.status, r.hints]), [['en', 'pass', 0], ['de', 'pass', 1]]);
  assert.equal(JSON.stringify(records).includes('Create your account'), false, 'the texts are not in results.json');
  const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(summary, /same-as-default\? de page: 1 text identical in en and de: "Create your account"/);
  assert.equal(summary.includes('ICE Auth'), false, 'the allow-listed brand is not reported');
  const resumed = await ui('batch', '--states', statesFile, '--out', out, '--jobs', '1', '--resume');
  assert.equal(resumed.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).map((r) => r.hints), [0, 1], 'a resumed run does not add the hint twice');
});
