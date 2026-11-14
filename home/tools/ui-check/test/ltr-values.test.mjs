// Purpose: browser-free tests for "only the typed value is left to right": the bidi-field judgement on the filled state, the `bidi-placeholder` finding and
// hint, the hints `ltr-run-in-rtl?`, `untranslated?` and `same-as-default?` (with the batch post-pass that adds it), and the `sameInAllLocales` states key. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bidiFieldFindings, bidiPlaceholderFindings, hasStrongRtl, isHint } from '../lib/bidi.mjs';
import { addSameAsDefaultHints, writeComparableTexts } from '../lib/same-as-default.mjs';
import { parseStates } from '../lib/states.mjs';
import { comparableTexts, ltrRunInRtlHints, parseAllowList, sameAsDefaultHints, untranslatedHints } from '../lib/translation-hints.mjs';
import { writeReport } from '../lib/report.mjs';

const PERSIAN = 'شماره موبایل';
const field = (extra = {}) => ({ element: 'input#phone', placeholder: PERSIAN, placeholderDirection: 'rtl', placeholderAlign: 'start', contextDirection: 'rtl', visible: true, ...extra });
const placeholders = (fields) => bidiPlaceholderFindings({ fields });

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
  assert.deepEqual(placeholders([field({ placeholderDirection: 'ltr', contextDirection: 'ltr' })]).findings, [], 'an ltr island or page is not judged');
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
  assert.equal(bidiPlaceholderFindings({ fields: many }, 2).findings.length, 2);
});

const mail = (extra = {}) => ({ element: 'input#mail', type: 'email', direction: 'rtl', contextDirection: 'rtl', probed: false, visible: true, ...extra });
const bidiFields = (fields) => bidiFieldFindings({ fields });

test('bidi-field: a field that really holds a value and computes rtl fails; the same field read through the empty-field probe is only the hint bidi-field? with the way to confirm it', () => {
  const [real] = bidiFields([mail()]);
  assert.equal(real.check, 'bidi-field');
  assert.equal(isHint(real), false);
  const [probed] = bidiFields([mail({ probed: true })]);
  assert.equal(probed.check, 'bidi-field?');
  assert.equal(isHint(probed), true, 'an empty field must not fail the run: a script may switch the direction from an input listener');
  assert.match(probed.detail, /could not confirm from an empty field: run a state that types a value/);
  assert.deepEqual(bidiFields([mail({ probed: true, direction: 'ltr' })]), [], 'a probe that computes ltr is a pass');
  assert.deepEqual(bidiFields([mail({ probed: true, direction: null })]), [], 'no probe result, no verdict');
  assert.deepEqual(bidiFields([mail({ probed: true, type: 'text', inputmode: '' })]), [], 'an empty plain text field has nothing to confirm');
});

test('bidi-field: the direction context is the element that holds the field, not the document: an rtl section is judged, an ltr island is not', () => {
  assert.equal(bidiFields([mail({ contextDirection: 'rtl' })]).length, 1, 'an rtl body or section inside an ltr document');
  assert.deepEqual(bidiFields([mail({ contextDirection: 'ltr' })]), [], 'an ltr island inside an rtl page');
  assert.deepEqual(placeholders([field({ placeholderDirection: 'ltr', contextDirection: 'rtl' })]).findings.map((f) => f.check), ['bidi-placeholder']);
});

const run = (text, extra = {}) => ({ element: 'p.note', text, visible: true, direction: 'rtl', isolated: false, ...extra });

test('ltr-run-in-rtl?: a phone with +, an email and a URL inside rtl text are hints that name the run; an isolated, ltr, hidden or code run is not', () => {
  const found = ltrRunInRtlHints({ texts: [run('تماس: +98 912 345 6789'), run('ایمیل 2.b@example.com'), run('سایت https://example.com/x/'), run('www.example.com/ را ببینید')] });
  assert.deepEqual(found.map((h) => h.check), Array(4).fill('ltr-run-in-rtl?'));
  assert.match(found[0].detail, /phone number "\+98 912 345 6789".*<bdi dir="ltr">/);
  assert.match(found[1].detail, /email address "2\.b@example\.com"/);
  assert.match(found[2].detail, /URL "https:\/\/example\.com\/x\/"/);
  const skipped = [run('تماس: +98 912 345 6789', { isolated: true }), run('+98 912 345 6789', { direction: 'ltr' }), run('+98 912 345 6789', { visible: false }), run('+98 912 345 6789', { inCode: true })];
  assert.deepEqual(ltrRunInRtlHints({ texts: skipped }), []);
});

test('ltr-run-in-rtl?: a plus in other text, a date, a short number and an email or URL with letters at both ends are not reported; the cap limits the list', () => {
  const texts = ['C++ و Java', '12 03 2024', '+98', 'a + b = 3', 'ایمیل بدون نشانی', 'تماس 021-12345678', 'ایمیل a.b@example.com', 'سایت https://example.com/docs', 'سایت https://example.com/docs.', 'www.example.com را ببینید'].map((t) => run(t));
  assert.deepEqual(ltrRunInRtlHints({ texts }), []);
  assert.equal(ltrRunInRtlHints({ texts: Array.from({ length: 4 }, () => run('+98 912 345 6789')) }, 3).length, 3);
});

test('ltr-run-in-rtl?: a phone number always counts (with + or with spaces or brackets between its groups); an email or URL only when a digit or a symbol ends it', () => {
  const kinds = (text) => ltrRunInRtlHints({ texts: [run(text)] }).map((h) => h.detail.match(/^the (.*?) "/)[1]);
  assert.deepEqual(kinds('تماس 0912 345 6789'), ['phone number']);
  assert.deepEqual(kinds('تماس (021) 1234 5678'), ['phone number']);
  assert.deepEqual(kinds('سایت https://example.com/'), ['URL'], 'a trailing / is a symbol that moves');
  assert.deepEqual(kinds('سایت https://example.com/page2'), ['URL']);
  assert.deepEqual(kinds('ایمیل 2fast@example.com'), ['email address']);
  assert.deepEqual(kinds('سایت https://example.com/docs.'), [], 'the full stop is the sentence\'s');
});

const page = (text, extra = {}) => ({ element: 'li.option', text, visible: true, keepLatin: false, direction: 'rtl', ...extra });
const untranslated = (texts, allow = []) => untranslatedHints({ texts }, allow);

test('untranslated?: English text of any length in an rtl context is ONE hint with the count and the first 5 different texts, each cut to 40 characters', () => {
  const [one, ...none] = untranslated([page('Select your country'), page('Sign in', { element: 'a#login' }), page('Submit'), page('Sign in'), page('Back to login'), page('Cancel'), page('Continue'), page('x'.repeat(10) + ' ' + 'y'.repeat(50))]);
  assert.deepEqual(none, []);
  assert.equal(one.check, 'untranslated?');
  assert.equal(one.element, 'li.option and 1 more');
  assert.match(one.detail, /^8 texts in English on a right-to-left page: "Select your country", "Sign in", "Submit", "Back to login", "Cancel" and 2 more\. /);
  assert.match(untranslated([page('word '.repeat(20))])[0].detail, /"(word ){7}wo\.\.\."/, 'cut to 40 characters, "..." included');
  assert.equal(untranslated(Array.from({ length: 200 }, (_, i) => page(`Country number ${i}`))).length, 1, 'a 200-option list is one row');
});

test('untranslated?: Persian, a Persian sentence with a Latin brand, other scripts, numbers, an acronym, a brand-shaped word, an email, a URL, short words and an rtl-free context are not reported', () => {
  const quiet = ['کشور خود را انتخاب کنید', 'ورود با Google Pay', 'ثبت نام در ICE Platform', 'Привет hello', '1234 5678', 'PDF', 'SMS', 'iOS', 'YouTube', '5 MB', 'support@example.com', 'https://example.com/docs', 'OK', 'Go to it', 'Wi-Fi', '© 2026 ICE'];
  assert.deepEqual(untranslated(quiet.map((text) => page(text))), []);
  assert.deepEqual(untranslated([page('Select your country', { direction: 'ltr' })]), [], 'an ltr island or an ltr page');
});

test('untranslated?: translate="no", an other lang, dir="ltr", code, hidden text are not reported; text beside a brand or an email is still English', () => {
  assert.deepEqual(untranslated([page('Visual Studio Code', { keepLatin: true }), page('Select your country', { visible: false })]), []);
  assert.equal(untranslated([page('Contact support@example.com')]).length, 1);
  assert.equal(untranslated([page('Sign in with Google Pay')], ['ICE']).length, 1);
});

test('untranslated?: the allow-list matches whole words and phrases in any letter case, never a part of a word', () => {
  assert.deepEqual(untranslated([page('Google Pay'), page('ICE Auth')], ['Google Pay', 'ICE Auth']), []);
  assert.deepEqual(untranslated([page('Sign in with Google Pay')], ['Google Pay', 'Sign in with']), []);
  assert.deepEqual(untranslated([page('ice auth google PAY')], ['Ice Auth', 'google', 'pay']), [], 'any letter case');
  assert.equal(untranslated([page('Notice service')], ['ICE']).length, 1, '"ICE" is not "Notice"');
  assert.equal(untranslated([page('Invoice office')], ['ICE']).length, 1, '"ICE" is not "Invoice"');
  assert.equal(untranslated([page('Nice')], ['ICE']).length, 1, 'the end of a word is not the term');
  assert.equal(untranslated([page('Signs')], ['Sign']).length, 1, 'removing a part of a word would leave "s" and hide the text');
  assert.equal(untranslated([page('Sign in with ICE')], ['ICE']).length, 1, 'real English next to the brand stays');
  assert.equal(untranslated([page('Google Payments')], ['Google Pay']).length, 1, 'a phrase is not a prefix');
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
  assert.deepEqual(found.map((h) => [h.check, h.element]), [['same-as-default?', 'de page']], 'one row per record');
  assert.match(found[0].detail, /^2 texts identical in en and de: "Create your account", "Welcome back friend"\./);
  assert.match(sameAsDefaultHints(facts, [])[0].detail, /^3 texts /, 'without the allow-list ICE Auth counts');
  assert.deepEqual(sameAsDefaultHints({ ...facts, other: ['Anmelden jetzt'] }, []), []);
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
