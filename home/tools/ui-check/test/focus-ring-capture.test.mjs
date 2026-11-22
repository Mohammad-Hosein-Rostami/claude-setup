// Purpose: browser-free tests for the focus-ring width: the pure measure `focusRingWidth` (outline, box-shadow ring, outline:none with a
// shadow ring, glow, always-on shadow) and `walkFocus` carrying it on each stop (a stub page replays the in-page probe). It is report-only:
// the hint decision and FOCUS_INDICATOR_FAILS are checked unchanged. Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { walkFocus } from '../lib/focus-audit.mjs';
import { FOCUS_INDICATOR_FAILS, focusIndicatorFindings, focusRingWidth } from '../lib/rendered-checks.mjs';

const NONE = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', backgroundColor: 'rgb(255, 255, 255)',
  backgroundImage: 'none', textDecorationLine: 'none', transform: 'none', content: 'normal', width: '100px', height: '20px' };
const pair = (after = {}, before = {}) => ({ before: { ...NONE, ...before }, after: { ...NONE, ...after } });
const stop = (own = {}, ownBefore = {}, extra = {}) => ({ element: 'button.go', hidden: false, own: [pair(own, ownBefore)], related: [], ...extra });

test('focus ring width: a drawn outline is its width; outline-style none is 0', () => {
  assert.equal(focusRingWidth(stop({ outlineStyle: 'solid', outlineWidth: '2px' })), 2);
  assert.equal(focusRingWidth(stop({ outlineStyle: 'none', outlineWidth: '2px' })), 0, 'Chromium keeps the width of a none outline; it is not drawn');
  assert.equal(focusRingWidth(stop()), 0);
});

test('focus ring width: outline:none with a box-shadow ring is measured, not 0', () => {
  const ring = 'rgb(0, 95, 204) 0px 0px 0px 3px';
  assert.equal(focusRingWidth(stop({ outlineStyle: 'none', boxShadow: ring })), 3);
  assert.equal(focusRingWidth(stop({ boxShadow: `rgb(0, 0, 0) 0px 1px 2px 0px, ${ring}` })), 3, 'the widest layer wins, and the comma inside rgb() does not split a layer');
  assert.equal(focusRingWidth(stop({ boxShadow: 'rgb(0, 95, 204) 0px 0px 0px 2px inset' })), 2, 'an inset ring counts');
  assert.equal(focusRingWidth(stop({ outlineStyle: 'solid', outlineWidth: '1px', boxShadow: ring })), 3, 'outline and ring: the larger');
});

test('focus ring width: a blur-only glow and a shadow that was there unfocused are not the focus ring', () => {
  assert.equal(focusRingWidth(stop({ boxShadow: 'rgba(0, 0, 0, 0.3) 0px 0px 8px 0px' })), 0);
  const card = 'rgba(0, 0, 0, 0.2) 0px 0px 0px 1px';
  assert.equal(focusRingWidth(stop({ boxShadow: card }, { boxShadow: card })), 0, 'always-on 1px hairline');
  assert.equal(focusRingWidth(stop({ boxShadow: `${card}, rgb(0, 95, 204) 0px 0px 0px 4px` }, { boxShadow: card })), 4, 'a layer added on focus');
});

test('focus ring width: a hidden control is measured on related elements only; a ring on a wrapper counts', () => {
  const ownOnly = stop({ outlineStyle: 'solid', outlineWidth: '2px' }, {}, { hidden: true });
  assert.equal(focusRingWidth(ownOnly), 0);
  const wrapper = stop({}, {}, { hidden: true, related: [pair({ boxShadow: 'rgb(0, 95, 204) 0px 0px 0px 3px' })] });
  assert.equal(focusRingWidth(wrapper), 3);
});

test('report-only: the width never changes what focus-indicator reports, and the fail switch stays off', () => {
  assert.equal(FOCUS_INDICATOR_FAILS, false);
  const withRing = stop({ boxShadow: 'rgb(0, 95, 204) 0px 0px 0px 3px' });
  assert.deepEqual(focusIndicatorFindings({ focusables: [withRing] }), []);
  assert.equal(focusIndicatorFindings({ focusables: [stop()] }).length, 1);
  assert.equal(focusRingWidth(stop()), 0, 'no indicator: width 0 and still only a hint-level finding');
});

/** A stub page: `snapshot` answers a count, each `read` answers the next scripted stop, then 'end'. */
function stubPage(stops) {
  const queue = [...stops];
  return {
    keyboard: { press: async () => {} },
    evaluate: async (_probe, { mode }) => (mode === 'snapshot' ? queue.length : (queue.shift() ?? 'end')),
  };
}

test('walkFocus puts ringWidth on each stop (outline, shadow ring, none)', async () => {
  const stops = [
    { element: 'a#outline', hidden: false, own: [pair({ outlineStyle: 'solid', outlineWidth: '2px' })], related: [] },
    { element: 'button#shadow', hidden: false, own: [pair({ boxShadow: 'rgb(0, 95, 204) 0px 0px 0px 3px' })], related: [] },
    { element: 'button#bare', hidden: false, own: [pair()], related: [] },
  ];
  const { facts, capped } = await walkFocus(stubPage(stops));
  assert.equal(capped, false);
  assert.deepEqual(facts.map((fact) => [fact.element, fact.ringWidth]), [['a#outline', 2], ['button#shadow', 3], ['button#bare', 0]]);
  assert.equal(focusIndicatorFindings({ focusables: facts }).length, 1, 'still one hint, for the bare button');
});
