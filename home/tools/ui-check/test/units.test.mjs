// Purpose: browser-free unit tests for colour parsing, in-page measurement, gap derivation, columns verdict inputs,
// openPage guards, pixel gate, image helpers, cache/args validation and the CLI exit-2 mapping.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { comparableRows } from '../commands/columns.mjs';
import { toNumber } from '../lib/args.mjs';
import { openPage } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { compareElements, parseColor } from '../lib/elements.mjs';
import { UsageError } from '../lib/errors.mjs';
import { padTo, diffRegion } from '../lib/image.mjs';
import { measureInPage } from '../lib/measure.mjs';
import { pixelCheck } from '../lib/pixels.mjs';
import { flattenSpec } from '../lib/spec.mjs';

const { PNG } = pngjs;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-unit-'));

function solidPng(width, height, [r, g, b, a]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) png.data.set([r, g, b, a], i * 4);
  return png;
}

test('parseColor reads rgb syntaxes and returns null for unknown colour spaces', () => {
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3, 1]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5]);
  assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.equal(parseColor('oklch(0.5 0.2 30)'), null);
  assert.equal(parseColor('color(srgb 1 0 0)'), null);
});

test('compareElements does not fail a colour it cannot parse', () => {
  const nodes = [{ id: 'a', name: 'Box', type: 'FRAME', x: 0, y: 0, w: 10, h: 10, style: { background: 'rgb(255, 0, 0)' } }];
  const css = { backgroundColor: 'oklch(0.63 0.26 29)', radius: [0, 0, 0, 0], padding: [] };
  const rows = compareElements(nodes, { a: '#a' }, [{ id: 'a', found: true, box: { x: 0, y: 0, w: 10, h: 10 }, css }]);
  assert.deepEqual(rows, []);
});

function withFakeBrowser({ style, rect, pixel }, fn) {
  const calls = [];
  const el = { getBoundingClientRect: () => rect, matches: () => true, querySelector: () => null };
  const ctx = {
    clearRect() {}, fillRect() {}, set fillStyle(v) { calls.push(v); },
    getImageData: () => ({ data: pixel }),
  };
  globalThis.document = { querySelector: () => el, createElement: () => ({ getContext: () => ctx }) };
  globalThis.getComputedStyle = () => style;
  try {
    return fn(calls);
  } finally {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
}

const baseStyle = {
  fontSize: '16px', fontWeight: '400', lineHeight: 'normal', letterSpacing: 'normal', color: 'rgb(0, 0, 0)', backgroundColor: 'transparent',
  borderTopLeftRadius: '50%', borderTopRightRadius: '10px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px', rowGap: 'normal', columnGap: 'normal',
};

test('measureInPage resolves % radius against the box and converts modern colours through a canvas', () => {
  const rect = { x: 0, y: 0, width: 200, height: 120 };
  const style = { ...baseStyle, color: 'oklch(0.5 0.2 30)' };
  const out = withFakeBrowser({ style, rect, pixel: [255, 0, 0, 255] }, (calls) => {
    const res = measureInPage({ rootSelector: '#r', items: [{ id: 'a', selector: '#r' }] });
    assert.deepEqual(calls, ['oklch(0.5 0.2 30)']);
    return res;
  });
  const { css } = out.results[0];
  assert.equal(css.radius[0], 60); // 50% of min(200, 120)
  assert.equal(css.radius[1], 10);
  assert.equal(css.color, 'rgba(255, 0, 0, 1)');
  assert.equal(css.backgroundColor, 'transparent');
});

test('flattenSpec asserts no gap for a single-child auto-layout frame', () => {
  const child = { id: '2:1', name: 'c', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, children: [] };
  const frame = {
    id: '1:1', name: 'Row', type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 24,
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 }, children: [child],
  };
  assert.equal(flattenSpec(frame).nodes[0].style.gap, undefined);
});

test('comparableRows counts only body rows with the header cell count', () => {
  const cell = { x: 0, w: 10 };
  assert.equal(comparableRows([[cell, cell], [cell]]).length, 0);
  assert.equal(comparableRows([[cell, cell], [cell], [cell, cell]]).length, 1);
});

function fakePage({ status, imageError }) {
  return {
    goto: async () => (status === undefined ? null : { status: () => status }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, addStyleTag: async () => {}, evaluate: async () => {},
    waitForFunction: async () => {
      if (imageError) throw Object.assign(new Error('t'), { name: imageError });
    },
  };
}
const fakeBrowser = (page) => ({ newContext: async () => ({ newPage: async () => page }) });
const view = { url: 'http://x', width: 10, height: 10 };

test('openPage rejects HTTP >= 400, accepts a null (file://) response', async () => {
  await assert.rejects(openPage(fakeBrowser(fakePage({ status: 404 })), view), (e) => e instanceof UsageError && /HTTP 404/.test(e.message));
  assert.ok(await openPage(fakeBrowser(fakePage({ status: 200 })), view));
  assert.ok(await openPage(fakeBrowser(fakePage({})), view));
});

test('openPage tolerates an image-wait timeout but not other errors', async () => {
  assert.ok(await openPage(fakeBrowser(fakePage({ status: 200, imageError: 'TimeoutError' })), view));
  await assert.rejects(openPage(fakeBrowser(fakePage({ status: 200, imageError: 'Error' })), view));
});

test('pixelCheck: match, pixel diff and size mismatch', async () => {
  const dir = tmp();
  const write = (name, png) => { const f = path.join(dir, name); fs.writeFileSync(f, PNG.sync.write(png)); return f; };
  const red = write('red.png', solidPng(4, 4, [255, 0, 0, 255]));
  const blue = write('blue.png', solidPng(4, 4, [0, 0, 255, 255]));
  const wide = write('wide.png', solidPng(6, 4, [255, 0, 0, 255]));
  const run = (actualFile) => pixelCheck({ baselineFile: red, actualFile, outDir: dir, maxDiffPercent: 0.5 });
  assert.equal((await run(red)).pass, true);
  const diff = await run(blue);
  assert.equal(diff.pass, false);
  assert.equal(diff.diffCount, 16);
  const mismatch = await run(wide);
  assert.equal(mismatch.pass, false);
  assert.deepEqual(mismatch.sizeMismatch, { baseline: [4, 4], actual: [6, 4] });
});

test('padTo pads transparently and diffRegion bounds the differing pixels', () => {
  const padded = padTo(solidPng(2, 2, [9, 9, 9, 255]), 4, 3);
  assert.deepEqual([padded.width, padded.height], [4, 3]);
  assert.equal(padded.data[(2 * 4 + 3) * 4 + 3], 0);
  const a = solidPng(4, 4, [0, 0, 0, 255]);
  const b = solidPng(4, 4, [0, 0, 0, 255]);
  b.data.set([255, 255, 255, 255], (1 * 4 + 2) * 4);
  assert.deepEqual(diffRegion(a, b), { x: 2, y: 1, w: 1, h: 1 });
  assert.equal(diffRegion(a, a), null);
});

test('readCache rejects a missing file and a bad meta.json', () => {
  const dir = tmp();
  assert.throws(() => readCache(dir), UsageError);
  fs.writeFileSync(path.join(dir, 'baseline.png'), '');
  fs.writeFileSync(path.join(dir, 'spec.json'), '{}');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ scale: 0, width: 10, height: 10 }));
  assert.throws(() => readCache(dir), /"scale" must be a positive number/);
});

test('toNumber rejects non-numbers and values below the minimum', () => {
  assert.equal(toNumber('5', 'x'), 5);
  assert.throws(() => toNumber('abc', 'x'), UsageError);
  assert.throws(() => toNumber('1', 'x', 2), UsageError);
});

test('cli exits 2 with a message on an unknown command and on missing flags', () => {
  for (const args of [['nope'], ['compare']]) {
    const res = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage\/setup error/);
  }
});
