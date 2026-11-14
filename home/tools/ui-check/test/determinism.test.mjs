// Purpose: tests for the capture-determinism defaults in lib/browser.mjs: CPU rasterisation at launch and an explicit autofocus
// step in openPage. Exports: none. The launch-args and autofocus-step tests are browser-free; the Chromium tests need
// UI_CHECK_PROJECT (a project with Playwright and Chromium) and skip without it, like smoke.test.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAutofocus, loadChromium, launch, openPage, RENDER_ARGS } from '../lib/browser.mjs';

const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (mode) => `${pathToFileURL(path.join(here, 'fixtures', 'autofocus.html')).href}?mode=${mode}`;

async function focusedIdAfterOpen(mode) {
  const browser = await launch(loadChromium(project));
  try {
    const page = await openPage(browser, { url: fixture(mode), width: 200, height: 100 });
    return await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
  } finally {
    await browser.close();
  }
}

/** Run the in-page function of an `evaluate` call against a fake document, so the focus logic is tested without a browser. */
function runInFakeDocument(fakeDocument) {
  const page = {
    evaluate: async (fn) => {
      globalThis.document = fakeDocument;
      try { return await fn(); } finally { delete globalThis.document; }
    },
  };
  return applyAutofocus(page);
}

function fakeField(log) {
  return { focus: (options) => log.push(options) };
}

test('launch passes the software-raster args, so anti-aliased edges are identical between runs', async () => {
  let launchOptions;
  await launch({ launch: async (options) => { launchOptions = options; return {}; } });
  assert.deepEqual(launchOptions.args, RENDER_ARGS);
  assert.ok(launchOptions.args.includes('--use-angle=swiftshader'), JSON.stringify(launchOptions));
  assert.ok(launchOptions.args.includes('--disable-gpu-rasterization'), JSON.stringify(launchOptions));
});

test('applyAutofocus focuses the [autofocus] field when nothing holds focus', async () => {
  const log = [];
  const body = {};
  await runInFakeDocument({ body, activeElement: body, querySelector: (selector) => (selector === '[autofocus]' ? fakeField(log) : null) });
  assert.deepEqual(log, [{ preventScroll: true }]);
});

test('applyAutofocus keeps a field the page focused itself and tolerates a page without autofocus', async () => {
  const log = [];
  const body = {};
  await runInFakeDocument({ body, activeElement: {}, querySelector: () => fakeField(log) });
  assert.deepEqual(log, []);
  await runInFakeDocument({ body, activeElement: body, querySelector: () => null });
});

test('openPage focuses the autofocus field before the steps run', async () => {
  const log = [];
  const page = {
    goto: async () => null, waitForLoadState: async () => {}, waitForTimeout: async () => {}, addStyleTag: async () => {},
    waitForFunction: async () => {}, evaluate: async () => { log.push('evaluate'); },
    locator: () => ({ count: async () => 1, click: async () => log.push('step') }),
  };
  const browser = { newContext: async () => ({ newPage: async () => page }) };
  await openPage(browser, { url: 'http://x', width: 10, height: 10, steps: [{ action: 'click', selector: 'b' }] });
  assert.ok(log.indexOf('evaluate') < log.indexOf('step'), log.join(','));
});

test('the launched Chromium rasterises on the CPU', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const { gpu } = await (await browser.newBrowserCDPSession()).send('SystemInfo.getInfo');
    assert.equal(gpu.featureStatus.rasterization, 'disabled_software');
  } finally {
    await browser.close();
  }
});

test('openPage applies the autofocus field when Chromium skipped it', { skip: !project }, async () => {
  assert.equal(await focusedIdAfterOpen('lose'), 'first');
});

test('openPage leaves a field the page focused itself alone', { skip: !project }, async () => {
  assert.equal(await focusedIdAfterOpen('other'), 'other');
});
