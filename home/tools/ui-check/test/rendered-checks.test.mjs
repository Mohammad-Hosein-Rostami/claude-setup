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
  assert.equal(rawI18nKeyFindings({ texts: ['a.b', 'c.d', 'e.f'].map((t) => text(t)) }, 2).length, 2);
});

const block = (align, extra = {}) => ({ element: 'p.form-hint', textAlign: align, direction: 'rtl', visible: true, ...extra });

test('rtl-physical-align: text-align left in an rtl document is reported, right/start/center are not', () => {
  const found = rtlPhysicalAlignFindings({ docDirection: 'rtl', blocks: [block('left')] });
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'rtl-physical-align');
  assert.match(found[0].detail, /text-align: left/);
  assert.match(found[0].detail, /start/);
  assert.deepEqual(rtlPhysicalAlignFindings({ docDirection: 'rtl', blocks: ['right', 'start', 'center', 'justify', 'end'].map((a) => block(a)) }), []);
});

test('rtl-physical-align: ltr page, hidden block, and a block that is itself ltr are not reported', () => {
  assert.deepEqual(rtlPhysicalAlignFindings({ docDirection: 'ltr', blocks: [block('left', { direction: 'ltr' })] }), []);
  assert.deepEqual(rtlPhysicalAlignFindings({ docDirection: 'rtl', blocks: [block('left', { visible: false })] }), []);
  assert.deepEqual(rtlPhysicalAlignFindings({ docDirection: 'rtl', blocks: [block('left', { direction: 'ltr' })] }), []);
});

const NONE = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '1px', backgroundColor: 'rgb(255, 255, 255)' };
const focusable = (after, extra = {}) => ({ element: 'button.go', hidden: false, before: NONE, after: { ...NONE, ...after }, related: [], ...extra });

test('focus-indicator: nothing changed on keyboard focus is reported', () => {
  const found = focusIndicatorFindings({ focusables: [focusable({})] });
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'focus-indicator');
  assert.equal(found[0].element, 'button.go');
  assert.match(found[0].detail, /outline, box-shadow, border and background/);
});

test('focus-indicator: any one of outline, box-shadow, border colour, border width or background changing counts as an indicator', () => {
  const changes = [{ outlineStyle: 'auto' }, { outlineWidth: '2px' }, { outlineColor: 'rgb(0, 0, 255)' }, { boxShadow: 'rgb(0, 0, 255) 0px 0px 0px 2px' },
    { borderColor: 'rgb(0, 0, 255)' }, { borderWidth: '2px' }, { backgroundColor: 'rgb(0, 0, 255)' }];
  for (const change of changes) assert.deepEqual(focusIndicatorFindings({ focusables: [focusable(change)] }), [], JSON.stringify(change));
});

test('focus-indicator: a visually hidden control (hidden input) is fine when its label or a neighbour changes, reported when nothing does', () => {
  const styled = focusable({}, { element: 'input#remember', hidden: true, related: [{ before: NONE, after: { ...NONE, boxShadow: '0 0 0 2px blue' } }] });
  assert.deepEqual(focusIndicatorFindings({ focusables: [styled] }), []);
  const bare = focusable({}, { element: 'input#remember', hidden: true, related: [{ before: NONE, after: NONE }] });
  const found = focusIndicatorFindings({ focusables: [bare] });
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /label|neighbour/);
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
