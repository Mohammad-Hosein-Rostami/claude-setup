// Purpose: browser-free tests for the step failure messages added in v2: a timed-out click names the element covering the target (and hints at
// the label of a visually hidden input), and `focus` fails when the element did not take focus. Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeBlockedClick } from '../lib/click-cover.mjs';
import { UsageError } from '../lib/errors.mjs';
import { runSteps } from '../lib/steps.mjs';

const target = (extra = {}) => ({ tag: 'input', id: 'terms', type: 'checkbox', hiddenVisually: true, ...extra });
const cover = (extra = {}) => ({ tag: 'label', id: '', className: 'ds-check', coversTarget: false, ...extra });

test('a covering element is named by tag, id and class', () => {
  const text = describeBlockedClick({ target: target({ hiddenVisually: false, type: 'text' }), cover: cover({ id: 'veil', className: 'overlay big' }) });
  assert.match(text, /covered at its centre by <label id="veil" class="overlay big">/);
  assert.doesNotMatch(text, /label instead/);
});

test('a visually hidden input gets the hint to click its label', () => {
  assert.match(describeBlockedClick({ target: target(), cover: cover() }), /visually hidden.*click its label/);
  assert.match(describeBlockedClick({ target: target({ hiddenVisually: false }), cover: cover() }), /label instead/, 'a checkbox always gets the hint');
});

test('nothing at the centre, or the target itself on top, say so and still give the hidden-input hint', () => {
  assert.match(describeBlockedClick({ target: target(), cover: null }), /nothing is drawn at its centre/);
  const self = describeBlockedClick({ target: target({ hiddenVisually: false, type: 'text' }), cover: cover({ tag: 'input', coversTarget: true }) });
  assert.match(self, /target itself is on top/);
});

const pageWhere = (activeIsTarget) => ({ locator: () => ({ count: async () => 1, focus: async () => {}, evaluate: async () => activeIsTarget }) });

test('focus fails when the element is not document.activeElement afterwards', async () => {
  await assert.rejects(runSteps(pageWhere(false), [{ action: 'focus', selector: '#role' }]), (e) => e instanceof UsageError && /step 1 \(focus\).*did not take focus/.test(e.message));
  await runSteps(pageWhere(true), [{ action: 'focus', selector: '#role' }]);
});
