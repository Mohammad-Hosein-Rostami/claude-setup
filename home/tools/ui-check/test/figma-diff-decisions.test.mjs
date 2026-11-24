// Purpose: browser-free tests for the `figma-diff --decisions` file (lib/figma-diff.mjs parseDecisions, classifyRow): an entry needs a
// written reason of 15+ characters (the ui-coverage rule) and no owner approval; an `owner` field of an older file is allowed and not
// read; a matching row takes the entry's class and its reason. Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLASSES, classifyRow, parseDecisions } from '../lib/figma-diff.mjs';

const REASON = 'the only entry to the e-mailed link flow';
const KEEP_EXTRA = { type: 'extra', build: 'Continue on another device', surface: 'register', class: 'keep', reason: REASON };
const EXTRA_ROW = { type: 'extra', figma: '', build: 'Continue on another device' };

test('a decision with a reason and no owner field loads and classes the matching row with its reason', () => {
  const decisions = parseDecisions([KEEP_EXTRA]);
  assert.deepEqual(classifyRow(EXTRA_ROW, 'register', decisions), { class: CLASSES.keep, reason: REASON });
});

test('an owner field of an older file is allowed and not read: the row reason is the entry reason only', () => {
  const decisions = parseDecisions([{ ...KEEP_EXTRA, owner: 'STATUS.md decision 2026-11-14 B15' }]);
  assert.deepEqual(classifyRow(EXTRA_ROW, 'register', decisions), { class: CLASSES.keep, reason: REASON });
});

test('a missing, blank or short reason (under 15 non-space characters) is a usage error naming the field', () => {
  for (const reason of [undefined, '   ', 'too short', 42]) {
    assert.throws(() => parseDecisions([{ ...KEEP_EXTRA, reason }]), { name: 'UsageError', message: /^decisions\[0\]\.reason: must say why, at least 15 characters/ }, String(reason));
  }
});

test('a row no decision matches keeps its default class, and an extra row says a decision needs its reason', () => {
  assert.deepEqual(classifyRow(EXTRA_ROW, 'signin', parseDecisions([KEEP_EXTRA])), { class: CLASSES.fix, reason: 'not in Figma: match Figma (remove it), or record a decision with its reason to keep it' });
});
