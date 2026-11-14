// Purpose: browser-free tests for the pure decision functions behind the `raw-i18n-key`, `focus-indicator`, `rtl-physical-align` and
// `target-size?` decisions (positive, negative, hidden element, ltr page). Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { focusIndicatorFindings, rawI18nKeyFindings, rtlPhysicalAlignFindings, targetSizeHints } from '../lib/rendered-checks.mjs';

const text = (value, extra = {}) => ({ element: 'p.hint', text: value, visible: true, ...extra });

test('raw-i18n-key: a whole text that looks like a dictionary key is reported, with the key in the detail', () => {
  const found = rawI18nKeyFindings({ texts: [text('reset.hint'), text('  signup.role_label.open  ')] });
  assert.deepEqual(found.map((f) => [f.check, f.element]), [['raw-i18n-key', 'p.hint'], ['raw-i18n-key', 'p.hint']]);
  assert.match(found[0].detail, /reset\.hint/);
  assert.match(found[1].detail, /signup\.role_label\.open/);
});

test('raw-i18n-key: normal copy, a key inside a sentence, a single word and upper case are not reported', () => {
  const texts = ['Reset your password', 'See reset.hint for details', 'password', 'Reset.Hint', 'reset.', '.hint', '1st.step', 'reset..hint', ''].map((t) => text(t));
  assert.deepEqual(rawI18nKeyFindings({ texts }), []);
});

test('raw-i18n-key: a hidden text node is ignored, and the cap limits the list', () => {
  assert.deepEqual(rawI18nKeyFindings({ texts: [text('reset.hint', { visible: false })] }), []);
  assert.equal(rawI18nKeyFindings({ texts: ['ab.cd', 'ef.gh', 'ij.kl'].map((t) => text(t)) }, 2).length, 2);
});

test('raw-i18n-key: not a key: versions, file names, host names, digit segments, abbreviations, code and collapsed text (reviewer raw.html cases)', () => {
  const notKeys = ['v1.2.3', 'v2.0', 'example.com', 'www.example.com', 'acme.io', 'package.json', 'node.js', 'report.final.pdf', 'fig.1', '3.14', '1.2.3', 'i.e', 'e.g', 'a.b.c', 'Auth.signIn.title'];
  assert.deepEqual(rawI18nKeyFindings({ texts: notKeys.map((t) => text(t)) }), []);
  assert.deepEqual(rawI18nKeyFindings({ texts: [text('user.name', { inCode: true }), text('hidden.key', { visible: false })] }), []);
  const keys = ['auth.sign_in.title', 'reset.hint', 'signup.role_label', 'errors.required'];
  assert.equal(rawI18nKeyFindings({ texts: keys.map((t) => text(t)) }).length, keys.length);
});

const block = (align, extra = {}) => ({ element: 'p.form-hint', tag: 'p', text: 'hint', textAlign: align, direction: 'rtl', visible: true, ...extra });

test('rtl-physical-align: text-align left in an rtl block is reported, right/start/center are not', () => {
  const found = rtlPhysicalAlignFindings({ blocks: [block('left'), block('-webkit-left')] });
  assert.equal(found.length, 2);
  assert.equal(found[0].check, 'rtl-physical-align');
  assert.match(found[0].detail, /text-align: left/);
  assert.match(found[0].detail, /start/);
  assert.deepEqual(rtlPhysicalAlignFindings({ blocks: ['right', 'start', 'center', 'justify', 'end'].map((a) => block(a)) }), []);
});

test('rtl-physical-align: an ltr block (ltr page or island), a hidden block and dir=auto text are not reported', () => {
  assert.deepEqual(rtlPhysicalAlignFindings({ blocks: [block('left', { direction: 'ltr' })] }), []);
  assert.deepEqual(rtlPhysicalAlignFindings({ blocks: [block('left', { visible: false })] }), []);
  assert.deepEqual(rtlPhysicalAlignFindings({ blocks: [block('left', { dirAuto: true })] }), []);
});

test('rtl-physical-align: pre, code, textarea, button and number-only table cells are skipped; a text cell is not', () => {
  for (const tag of ['pre', 'code', 'textarea', 'button']) assert.deepEqual(rtlPhysicalAlignFindings({ blocks: [block('left', { tag })] }), [], tag);
  for (const text of ['1,234', '12.5%', '+98 912 000', '\u06F1\u06F2\u06F3', '$ 1,000.00']) assert.deepEqual(rtlPhysicalAlignFindings({ blocks: [block('left', { tag: 'td', text })] }), [], text);
  assert.equal(rtlPhysicalAlignFindings({ blocks: [block('left', { tag: 'td', text: 'Total 12' })] }).length, 1);
  assert.equal(rtlPhysicalAlignFindings({ blocks: [block('left', { tag: 'p', text: '1,234' })] }).length, 1, 'only table cells get the number exemption');
});

const NONE = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', backgroundColor: 'rgb(255, 255, 255)',
  backgroundImage: 'none', textDecorationLine: 'none', transform: 'none', content: 'normal', width: '100px', height: '20px' };
const pair = (after = {}) => ({ before: NONE, after: { ...NONE, ...after } });
const focusable = (own = {}, extra = {}) => ({ element: 'button.go', hidden: false, own: [pair(own)], related: [], ...extra });

test('focus-indicator: nothing changed on keyboard focus is reported', () => {
  const found = focusIndicatorFindings({ focusables: [focusable({})] });
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'focus-indicator');
  assert.equal(found[0].element, 'button.go');
  assert.match(found[0].detail, /no visible focus indicator/);
});

test('focus-indicator: any of outline, box-shadow, border, background colour or image, underline, transform or generated content changing counts', () => {
  const changes = [{ outlineStyle: 'auto' }, { outlineStyle: 'solid', outlineWidth: '2px' }, { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(0, 0, 255)' }, { boxShadow: 'rgb(0, 0, 255) 0px 0px 0px 2px' },
    { borderColor: 'rgb(0, 0, 255)', borderWidth: '1px' }, { borderWidth: '2px' }, { backgroundColor: 'rgb(0, 0, 255)' }, { backgroundImage: 'linear-gradient(red, blue)' },
    { textDecorationLine: 'underline' }, { transform: 'matrix(1.1, 0, 0, 1.1, 0, 0)' }, { content: '""' }];
  for (const change of changes) assert.deepEqual(focusIndicatorFindings({ focusables: [focusable(change)] }), [], JSON.stringify(change));
});

test('focus-indicator: a text colour change alone is not an indicator, even though the outline and border colours follow it; nor is the size of the element itself', () => {
  const colourOnly = focusable({ color: 'rgb(200, 0, 0)', outlineColor: 'rgb(200, 0, 0)', borderColor: 'rgb(200, 0, 0)', width: '120px' });
  assert.equal(focusIndicatorFindings({ focusables: [colourOnly] }).length, 1);
  assert.deepEqual(focusIndicatorFindings({ focusables: [focusable({ outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgb(200, 0, 0)' })] }), [], 'a drawn outline counts');
  assert.deepEqual(focusIndicatorFindings({ focusables: [focusable({ borderWidth: '2px', borderColor: 'rgb(200, 0, 0)' })] }), [], 'a drawn border counts');
});

test('focus-indicator: a change on a wrapper, label, sibling or pseudo-element (given as related) counts; a sibling that grows counts, the own size does not', () => {
  const wrapperBorder = { before: { ...NONE, borderWidth: '1px' }, after: { ...NONE, borderWidth: '1px', borderColor: 'rgb(0, 102, 204)' } };
  assert.deepEqual(focusIndicatorFindings({ focusables: [focusable({}, { related: [wrapperBorder] })] }), [], 'focus-within border colour on a bordered wrapper');
  for (const change of [{ boxShadow: '0 0 0 3px blue' }, { content: '""' }, { width: '100px', height: '22px' }, { width: '200px' }]) {
    assert.deepEqual(focusIndicatorFindings({ focusables: [focusable({}, { related: [pair(), pair(change)] })] }), [], JSON.stringify(change));
  }
  assert.equal(focusIndicatorFindings({ focusables: [focusable({}, { related: [pair(), pair()] })] }).length, 1);
});

test('focus-indicator: a visually hidden control is judged on its label and neighbours only; its own invisible outline does not count', () => {
  const styled = focusable({}, { element: 'input#remember', hidden: true, related: [pair({ boxShadow: '0 0 0 2px blue' })] });
  assert.deepEqual(focusIndicatorFindings({ focusables: [styled] }), []);
  const ownRingOnly = focusable({ outlineStyle: 'auto' }, { element: 'input#remember', hidden: true, related: [pair()] });
  const found = focusIndicatorFindings({ focusables: [ownRingOnly] });
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /visually hidden/);
});

test('focus-indicator: only the first 60 focusables count, the findings cap applies', () => {
  const many = Array.from({ length: 80 }, (_, i) => focusable({}, { element: `a#l${i}` }));
  assert.equal(focusIndicatorFindings({ focusables: many }).length, 60);
  assert.equal(focusIndicatorFindings({ focusables: many }, 5).length, 5);
});

const small = (extra = {}) => ({ element: 'a', width: 21, height: 18, siblingText: false, ...extra });

test('target-size?: a small inline link outside running text (nav, breadcrumb, language links) is a hint with its size', () => {
  const found = targetSizeHints({ targets: [small(), small({ width: 100, height: 10 })] }, 24);
  assert.equal(found.length, 2);
  assert.equal(found[0].check, 'target-size?');
  assert.match(found[0].detail, /^21x18 < 24x24/);
});

test('target-size?: a big enough link, and a link inside running text (WCAG inline exemption), give no hint', () => {
  assert.deepEqual(targetSizeHints({ targets: [small({ width: 24, height: 24 })] }, 24), []);
  assert.deepEqual(targetSizeHints({ targets: [small({ siblingText: true })] }, 24), []);
});

test('target-size?: the cap applies', () => {
  assert.equal(targetSizeHints({ targets: Array.from({ length: 9 }, () => small()) }, 24, 3).length, 3);
});
