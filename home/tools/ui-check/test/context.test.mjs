// Purpose: browser-free tests for the page-context flags (--locale, --color-scheme, --storage, --cookie, --expect-dir), their
// validation, the openPage wiring, and the bidi-field detection. Exports: none.
// Invariant: every bad value is a UsageError that names the flag; nothing here launches a browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '../lib/args.mjs';
import { openPage } from '../lib/browser.mjs';
import { bidiFieldFindings } from '../lib/bidi.mjs';
import { readContextFlags, validateWidths } from '../lib/context.mjs';
import { UsageError } from '../lib/errors.mjs';
import { options as compareOptions, pageOptions } from '../commands/compare.mjs';
import { options as responsiveOptions } from '../commands/responsive.mjs';

const FLAGS = ['--locale', 'fa-IR', '--color-scheme', 'dark', '--storage', 'lang=fa', '--storage', 'k=a=b', '--cookie', 'sid=abc', '--expect-dir', 'rtl'];
const usage = (pattern) => (error) => error instanceof UsageError && pattern.test(error.message);

test('compare and responsive parse the five context flags; storage and cookie repeat', () => {
  for (const table of [compareOptions, responsiveOptions]) {
    const context = readContextFlags(parse(FLAGS, table));
    assert.deepEqual(context, {
      locale: 'fa-IR', colorScheme: 'dark', expectDir: 'rtl',
      storage: [{ name: 'lang', value: 'fa' }, { name: 'k', value: 'a=b' }], cookies: [{ name: 'sid', value: 'abc' }],
    });
  }
});

test('without flags nothing changes: no locale, light scheme, no entries, no direction check', () => {
  assert.deepEqual(readContextFlags(parse([], compareOptions)), { locale: undefined, colorScheme: 'light', storage: [], cookies: [], expectDir: undefined });
});

test('an unknown value is a usage error naming the flag, never a silent default', () => {
  const bad = (flags, pattern) => assert.throws(() => readContextFlags(parse(flags, compareOptions)), usage(pattern));
  bad(['--locale', 'not a locale'], /--locale/);
  bad(['--locale', ''], /--locale/);
  bad(['--locale', 'en_US'], /--locale/);
  bad(['--color-scheme', 'blue'], /--color-scheme.*light.*dark/);
  bad(['--expect-dir', 'up'], /--expect-dir.*ltr.*rtl/);
  bad(['--storage', 'novalue'], /--storage.*key=value/);
  bad(['--storage', '=v'], /--storage/);
  bad(['--storage', 'a=1', '--storage', 'a=2'], /--storage.*"a".*twice/);
  bad(['--cookie', 'bad name=1'], /--cookie.*name/);
  bad(['--cookie', 'a=x;y'], /--cookie.*value/);
});

test('a locale is stored in canonical form', () => {
  assert.equal(readContextFlags(parse(['--locale', 'fa-ir'], compareOptions)).locale, 'fa-IR');
});

test('validateWidths needs a non-empty list of integers >= 200', () => {
  assert.deepEqual(validateWidths([320, 1024], 'widths'), [320, 1024]);
  for (const bad of [[], [100], [320.5], ['320'], 'x']) assert.throws(() => validateWidths(bad, 'widths'), usage(/widths/));
});

test('compare pageOptions carries the context; a call without context flags keeps the old shape', () => {
  const meta = { width: 10, height: 20, scale: 1 };
  const on = pageOptions({ url: 'u', ...parse(FLAGS, compareOptions) }, meta, []);
  assert.deepEqual([on.locale, on.colorScheme, on.expectDir, on.storage.length, on.cookies.length], ['fa-IR', 'dark', 'rtl', 2, 1]);
  const off = pageOptions({ url: 'u' }, meta, []);
  assert.deepEqual([off.locale, off.colorScheme, off.expectDir, off.storage, off.cookies], [undefined, 'light', undefined, [], []]);
});

function stubBrowser(log, direction = 'ltr') {
  const page = {
    goto: async () => null, waitForLoadState: async () => {}, waitForTimeout: async () => {}, addStyleTag: async () => {},
    waitForFunction: async () => {}, evaluate: async () => direction,
  };
  const context = {
    newPage: async () => page,
    addInitScript: async (fn, arg) => log.push(['init', typeof fn, arg]),
    addCookies: async (cookies) => log.push(['cookies', cookies]),
  };
  return { newContext: async (opts) => { log.push(['context', opts]); return context; } };
}
const view = { url: 'http://localhost:3000/a/b', width: 10, height: 10 };

test('openPage sets the locale and scheme on the context; defaults keep light and no locale key', async () => {
  const log = [];
  await openPage(stubBrowser(log), { ...view, locale: 'fa-IR', colorScheme: 'dark' });
  assert.equal(log[0][1].locale, 'fa-IR');
  assert.equal(log[0][1].colorScheme, 'dark');
  const plain = [];
  await openPage(stubBrowser(plain), view);
  assert.equal(plain[0][1].colorScheme, 'light');
  assert.equal(Object.hasOwn(plain[0][1], 'locale'), false);
  assert.equal(plain.length, 1, 'no init script or cookie call without entries');
});

test('storage entries become one init script scoped to the --url origin; cookies use the --url', async () => {
  const log = [];
  await openPage(stubBrowser(log), { ...view, storage: [{ name: 'lang', value: 'fa' }], cookies: [{ name: 'sid', value: 'abc' }] });
  const init = log.find((entry) => entry[0] === 'init');
  assert.deepEqual(init[2], { origin: 'http://localhost:3000', entries: [['lang', 'fa']] });
  assert.deepEqual(log.find((entry) => entry[0] === 'cookies')[1], [{ name: 'sid', value: 'abc', url: view.url }]);
});

test('cookies need an http(s) --url', async () => {
  await assert.rejects(openPage(stubBrowser([]), { ...view, url: 'file:///x.html', cookies: [{ name: 'a', value: 'b' }] }), usage(/--cookie.*http/));
});

test('expectDir passes on a match and fails with a clear error on a mismatch', async () => {
  await openPage(stubBrowser([], 'rtl'), { ...view, expectDir: 'rtl' });
  await assert.rejects(openPage(stubBrowser([], 'ltr'), { ...view, expectDir: 'rtl' }), usage(/--expect-dir rtl.*computed direction is ltr/));
});

const tel = { element: 'input#phone', type: 'tel', inputmode: '', autocomplete: '', direction: 'rtl', visible: true };
const finding = (facts, docDirection = 'rtl') => bidiFieldFindings({ docDirection, fields: facts });

test('bidi-field: an rtl document with an rtl tel input is one finding that names the selector and the fix', () => {
  const [one, ...rest] = finding([tel]);
  assert.equal(rest.length, 0);
  assert.equal(one.check, 'bidi-field');
  assert.equal(one.element, 'input#phone');
  assert.match(one.detail, /input#phone.*dir="ltr".*alignment may stay at the start edge/);
});

test('bidi-field: type, inputmode and autocomplete each trigger it', () => {
  for (const patch of [{ type: 'email' }, { type: 'url' }, { type: 'number' }, { inputmode: 'numeric' }, { inputmode: 'decimal' }, { inputmode: 'tel' },
    { autocomplete: 'one-time-code' }, { autocomplete: 'section-a cc-number' }, { autocomplete: 'postal-code' }, { autocomplete: 'tel-national' }]) {
    assert.equal(finding([{ ...tel, type: 'text', ...patch }]).length, 1, JSON.stringify(patch));
  }
});

test('bidi-field: ltr field, ltr document, hidden or invisible input, and plain text give no finding', () => {
  assert.deepEqual(finding([{ ...tel, direction: 'ltr' }]), []);
  assert.deepEqual(finding([tel], 'ltr'), []);
  assert.deepEqual(finding([{ ...tel, type: 'hidden' }]), []);
  assert.deepEqual(finding([{ ...tel, visible: false }]), []);
  assert.deepEqual(finding([{ ...tel, type: 'text' }]), []);
});

test('bidi-field: the number of findings is capped', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...tel, element: `input#f${i}` }));
  assert.equal(bidiFieldFindings({ docDirection: 'rtl', fields: many }, 2).length, 2);
});
