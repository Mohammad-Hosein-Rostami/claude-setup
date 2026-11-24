// Purpose: browser-free tests for lib/tolerances.mjs: the three tables are frozen and hold the values standards/figma.md and
// docs/figma-pixel-perfect.md rely on (odiff threshold 0.1, default gate 0.5 %, the responsive widths, the WCAG 2.5.8 target). Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PIXEL, RESPONSIVE, TOLERANCE } from '../lib/tolerances.mjs';
import { isolateEach } from './isolated-env.mjs';

isolateEach('tolerances');

test('TOLERANCE, PIXEL and RESPONSIVE are frozen, so a check cannot change a shared tolerance', () => {
  for (const table of [TOLERANCE, PIXEL, RESPONSIVE]) assert.ok(Object.isFrozen(table));
  // ES modules run in strict mode, where writing a frozen property throws instead of failing silently.
  assert.throws(() => { PIXEL.threshold = 1; }, TypeError);
  assert.throws(() => { TOLERANCE.box = 5; }, TypeError);
  assert.throws(() => { RESPONSIVE.minTarget = 1; }, TypeError);
  assert.equal(PIXEL.threshold, 0.1);
});

test('PIXEL holds the odiff threshold 0.1 and the default 0.5 % gate the docs name', () => {
  assert.deepEqual({ ...PIXEL }, { threshold: 0.1, maxDiffPercent: 0.5 });
});

test('RESPONSIVE holds the eight widths, a 900 px height, the 24 px target and the 12 px text floor', () => {
  assert.deepEqual(RESPONSIVE.widths, [320, 360, 390, 768, 1024, 1280, 1440, 1920]);
  assert.equal(RESPONSIVE.height, 900);
  assert.equal(RESPONSIVE.minTarget, 24);
  assert.equal(RESPONSIVE.minText, 12);
  assert.equal(RESPONSIVE.smallViewport, 768);
  assert.equal(RESPONSIVE.maxFindingsPerCheck, 50);
});

test('TOLERANCE holds the element-check limits (CSS px, colour 0-255 per channel)', () => {
  assert.deepEqual({ ...TOLERANCE }, { box: 1, fontSize: 0.5, lineHeight: 0.5, letterSpacing: 0.1, radius: 0.5, spacing: 0.5, colorChannel: 1, colorAlpha: 0.02 });
});
