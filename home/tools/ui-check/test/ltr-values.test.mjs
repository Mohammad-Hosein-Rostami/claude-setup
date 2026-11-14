// Purpose: browser-free tests for "only the typed value is left to right": the bidi-field judgement on the filled state, the `bidi-placeholder` finding and
// hint, the hints `ltr-run-in-rtl?`, `untranslated?` and `same-as-default?` (with the batch post-pass that adds it), and the `sameInAllLocales` states key. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bidiPlaceholderFindings, hasStrongRtl, isHint } from '../lib/bidi.mjs';
import { addSameAsDefaultHints, writeComparableTexts } from '../lib/same-as-default.mjs';
import { parseStates } from '../lib/states.mjs';
import { comparableTexts, ltrRunInRtlHints, parseAllowList, sameAsDefaultHints, untranslatedHints } from '../lib/translation-hints.mjs';
import { writeReport } from '../lib/report.mjs';

const PERSIAN = 'شماره موبایل';
const field = (extra = {}) => ({ element: 'input#phone', placeholder: PERSIAN, placeholderDirection: 'rtl', placeholderAlign: 'start', visible: true, ...extra });
const placeholders = (fields, docDirection = 'rtl') => bidiPlaceholderFindings({ docDirection, fields });

test('hasStrongRtl: Persian, Arabic and Hebrew letters count; digits (Latin, Arabic-Indic, Persian), symbols and Latin letters do not', () => {
  for (const text of [PERSIAN, 'مرحبا', 'שלום', '۰۹۱۲ شماره']) assert.equal(hasStrongRtl(text), true, text);
  for (const text of ['0912 345 6789', '٠٩١٢', '۰۹۱۲', '+98', 'name@example.com', '', undefined]) assert.equal(hasStrongRtl(text), false, String(text));
});

test('bidi-placeholder: a Persian placeholder that renders left to right in an rtl page is a finding that names the field and the fix', () => {
  const { findings, hints } = placeholders([field({ placeholderDirection: 'ltr' })]);
  assert.deepEqual(findings.map((f) => [f.check, f.element]), [['bidi-placeholder', 'input#phone']]);
  assert.match(findings[0].detail, /شماره موبایل.*left to right.*:not\(:placeholder-shown\)/);
  assert.deepEqual(hints, []);
  assert.equal(isHint(findings[0]), false, 'a finding fails the run');
});

test('bidi-placeholder: no finding for a rtl placeholder, digits only, an ltr document, an invisible field or a field with no placeholder shown', () => {
  assert.deepEqual(placeholders([field()]), { findings: [], hints: [] });
  assert.deepEqual(placeholders([field({ placeholder: '0912 345 6789', placeholderDirection: 'ltr' })]).findings, []);
  assert.deepEqual(placeholders([field({ placeholder: 'name@example.com', placeholderDirection: 'ltr' })]).findings, []);
  assert.deepEqual(placeholders([field({ placeholderDirection: 'ltr' })], 'ltr').findings, []);
  assert.deepEqual(placeholders([field({ placeholderDirection: 'ltr', visible: false })]).findings, []);
  assert.deepEqual(placeholders([field({ placeholderDirection: 'ltr', placeholder: '' })]).findings, [], 'a filled field has no placeholder showing');
});

test('bidi-placeholder?: an rtl placeholder aligned with physical left is a hint, never a finding; start and right are not reported', () => {
  const { findings, hints } = placeholders([field({ placeholderAlign: 'left' }), field({ element: 'input#b', placeholderAlign: '-webkit-left' }), field({ element: 'input#c', placeholderAlign: 'right' })]);
  assert.deepEqual(findings, []);
  assert.deepEqual(hints.map((h) => [h.check, h.element]), [['bidi-placeholder?', 'input#phone'], ['bidi-placeholder?', 'input#b']]);
});

test('bidi-placeholder: the number of findings and of hints is capped', () => {
  const many = Array.from({ length: 5 }, (_, i) => field({ element: `input#f${i}`, placeholderDirection: 'ltr' }));
  assert.equal(bidiPlaceholderFindings({ docDirection: 'rtl', fields: many }, 2).findings.length, 2);
});

const run = (text, extra = {}) => ({ element: 'p.note', text, visible: true, direction: 'rtl', isolated: false, ...extra });

test('ltr-run-in-rtl?: a phone with +, an email and a URL inside rtl text are hints that name the run; an isolated, ltr, hidden or code run is not', () => {
  const found = ltrRunInRtlHints({ texts: [run('تماس: +98 912 345 6789'), run('ایمیل a.b@example.com'), run('سایت https://example.com/x'), run('www.example.com را ببینید')] });
  assert.deepEqual(found.map((h) => h.check), Array(4).fill('ltr-run-in-rtl?'));
  assert.match(found[0].detail, /phone number with \+ "\+98 912 345 6789".*<bdi dir="ltr">/);
  assert.match(found[1].detail, /email address "a\.b@example\.com"/);
  assert.match(found[2].detail, /URL "https:\/\/example\.com\/x"/);
  const skipped = [run('تماس: +98 912 345 6789', { isolated: true }), run('+98 912 345 6789', { direction: 'ltr' }), run('+98 912 345 6789', { visible: false }), run('+98 912 345 6789', { inCode: true })];
  assert.deepEqual(ltrRunInRtlHints({ texts: skipped }), []);
});

test('ltr-run-in-rtl?: a plus in other text, a number without + and a short number are not a phone number; the cap limits the list', () => {
  const texts = ['C++ و Java', '912 345 6789', '+98', 'a + b = 3', 'ایمیل بدون نشانی'].map((t) => run(t));
  assert.deepEqual(ltrRunInRtlHints({ texts }), []);
  assert.equal(ltrRunInRtlHints({ texts: Array.from({ length: 4 }, () => run('+98 912 345 6789')) }, 3).length, 3);
});

const page = (text, extra = {}) => ({ element: 'li.option', text, visible: true, keepLatin: false, ...extra });
const untranslated = (texts, allow = [], docDirection = 'rtl') => untranslatedHints({ docDirection, texts }, allow);

test('untranslated?: a run of 2+ Latin words of 3+ letters on an rtl page is a hint (also option text); Persian, one word, short words and an ltr page are not', () => {
  const found = untranslated([page('Select your country'), page('United Arab Emirates', { element: 'select#c option' })]);
  assert.deepEqual(found.map((h) => [h.check, h.element]), [['untranslated?', 'li.option'], ['untranslated?', 'select#c option']]);
  assert.match(found[0].detail, /"Select your country" is English/);
  assert.deepEqual(untranslated([page('کشور خود را انتخاب کنید'), page('Google'), page('Go to it'), page('کد ۱۲۳۴'), page('OK')]), []);
  assert.deepEqual(untranslated([page('Select your country')], [], 'ltr'), []);
});

test('untranslated?: translate="no", dir="ltr", code, hidden text and allow-listed brands are not reported; a brand next to real English still is', () => {
  assert.deepEqual(untranslated([page('Select your country', { keepLatin: true }), page('Select your country', { visible: false })]), []);
  assert.deepEqual(untranslated([page('Sign in with Google Pay'), page('ICE Auth')], ['Google Pay', 'ICE']), []);
  assert.deepEqual(untranslated([page('ice auth google PAY')], ['Ice', 'google']).length, 0, 'terms match in any letter case');
  assert.equal(untranslated([page('Welcome back, ICE Auth user account')], ['ICE']).length, 1);
});

test('parseAllowList: comma text and arrays are trimmed and empty terms dropped', () => {
  assert.deepEqual(parseAllowList(' ICE , Google ,,'), ['ICE', 'Google']);
  assert.deepEqual(parseAllowList(['ICE', ' ']), ['ICE']);
  assert.deepEqual(parseAllowList(undefined), []);
});

test('comparableTexts: only texts of 2+ words, distinct, whitespace squashed, hidden texts left out', () => {
  const texts = [page('Create   your account'), page('Create your account'), page('Next'), page('1234 5678'), page('Secret words', { visible: false })];
  assert.deepEqual(comparableTexts(texts), ['Create your account']);
});

test('same-as-default?: the same 2+ word text in the first locale and in another is a hint; a different text, one word and an all-allow-listed text are not', () => {
  const facts = { reference: ['Create your account', 'Sign in', 'ICE Auth', 'Welcome back friend'], other: ['Create your account', 'Anmelden jetzt', 'ICE Auth', 'Welcome back friend'], referenceLocale: 'en', locale: 'de' };
  const found = sameAsDefaultHints(facts, ['ICE']);
  assert.deepEqual(found.map((h) => h.element), ['"Create your account"', '"Welcome back friend"']);
  assert.match(found[0].detail, /identical in en and de/);
  assert.equal(sameAsDefaultHints(facts, []).length, 3, 'without the allow-list ICE Auth counts');
});

const record = (locale, evidence, extra = {}) => ({ surface: 'login', state: 'rest', locale, width: 320, status: 'pass', evidence, findings: [], hints: 0, ...extra });

/** A responsive report folder as `auditAll` writes it, plus the saved comparable texts. */
function reportFolder(root, name, pageTexts) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const head = ['width', 'check', 'element', 'detail'];
  writeReport(dir, { title: 'ui-check responsive', verdict: 'PASS', summary: ['widths: 320', 'findings: 0', 'hints: 0'], head, rows: [], hints: { head, rows: [] }, data: { findings: [], hints: [] } });
  writeComparableTexts(dir, 320, pageTexts.map((text) => ({ text, visible: true })));
  return path.join(dir, 'report.md');
}

test('batch same-as-default?: the second locale gets the hint in its record, report.json and report.md; the first locale is untouched; a second pass does not add twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-default-'));
  const en = reportFolder(root, 'en', ['Create your account', 'Already registered here']);
  const de = reportFolder(root, 'de', ['Create your account', 'Schon registriert hier']);
  const states = ['en', 'de'].map((locale) => ({ surface: 'login', state: 'rest', locale, sameInAllLocales: [] }));
  const once = addSameAsDefaultHints([record('en', en), record('de', de)], states);
  assert.deepEqual(once.map((r) => r.hints), [0, 1]);
  assert.deepEqual(once.map((r) => r.status), ['pass', 'pass'], 'a hint never fails a record');
  const json = JSON.parse(fs.readFileSync(path.join(path.dirname(de), 'report.json'), 'utf8'));
  assert.deepEqual(json.hints.map((h) => [h.width, h.check]), [[320, 'same-as-default?']]);
  assert.match(fs.readFileSync(de, 'utf8'), /## Hints[\s\S]*same-as-default\?[\s\S]*Create your account/);
  assert.match(fs.readFileSync(de, 'utf8'), /- hints: 1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(en), 'report.json'), 'utf8')).hints, []);
  const twice = addSameAsDefaultHints(once, states);
  assert.deepEqual(twice.map((r) => r.hints), [0, 1], 'idempotent');
});

test('batch same-as-default?: records without a texts file (compare, error) are skipped, and the allow-list of the compared state applies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-default-'));
  const en = reportFolder(root, 'en', ['ICE Auth', 'Create your account']);
  const de = reportFolder(root, 'de', ['ICE Auth', 'Konto erstellen jetzt']);
  const states = [{ surface: 'login', state: 'rest', locale: 'en', sameInAllLocales: [] }, { surface: 'login', state: 'rest', locale: 'de', sameInAllLocales: ['ICE'] }];
  const compare = record('en', path.join(root, 'compare', 'report.md'));
  const error = record('de', root);
  assert.deepEqual(addSameAsDefaultHints([compare, error], states), [compare, error]);
  assert.deepEqual(addSameAsDefaultHints([record('en', en), record('de', de)], states).map((r) => r.hints), [0, 0]);
});

const base = { surface: 's', state: 'rest', url: 'http://x/', widths: [320] };

test('states file: sameInAllLocales is an array of terms in defaults and per state; the state value replaces the default; bad shapes name the field', () => {
  const states = parseStates({ defaults: { sameInAllLocales: ['ICE'] }, states: [base, { ...base, state: 'a', sameInAllLocales: ['Google'] }] }, os.tmpdir());
  assert.deepEqual(states.map((s) => s.sameInAllLocales), [['ICE'], ['Google']]);
  assert.deepEqual(parseStates({ states: [base] }, os.tmpdir())[0].sameInAllLocales, []);
  assert.throws(() => parseStates({ states: [{ ...base, sameInAllLocales: 'ICE' }] }, os.tmpdir()), /states\[0\]\.sameInAllLocales: must be an array of non-empty strings/);
  assert.throws(() => parseStates({ defaults: { sameInAllLocales: [''] }, states: [base] }, os.tmpdir()), /defaults\.sameInAllLocales/);
});
