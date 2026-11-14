// Purpose: resolve Playwright from the target project and open deterministic pages.
// Exports: loadChromium, launch, openPage, applyAutofocus, RENDER_ARGS. HTTP >= 400 is a UsageError (exit 2). Invariants: no browser
// download here; pages are frozen (fonts ready, animations off, caret hidden, reduced motion) before any measurement; Chromium
// rasterises on the CPU (SwiftShader) because GPU tile rasterisation gave 1-3 level edge noise between runs; an [autofocus] field is
// focused explicitly because Chromium skips autofocus in about one load in seven, which flips the focus ring between runs.
import { createRequire } from 'node:module';
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { runSteps } from './steps.mjs';

const PACKAGES = ['playwright', '@playwright/test', 'playwright-core'];
const NETWORK_IDLE_TIMEOUT_MS = 5000; // long-polling / websocket apps never go idle, so the wait is bounded
const HTTP_ERROR_MIN = 400;
const IMAGE_WAIT_TIMEOUT_MS = 5000; // a slow or broken eager image must not abort the run
const SPA_SETTLE_MS = 1500; // SPAs often render after the load event
// SwiftShader alone still rasterises page tiles on the GPU path (Skia Graphite), whose edge pixels differ by 1-3 levels between runs
// depending on how each tile was redrawn; CPU rasterisation makes captures repeatable (8 of 8 identical in the measured case).
export const RENDER_ARGS = ['--use-angle=swiftshader', '--disable-gpu-rasterization'];
const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

/**
 * Find Playwright's chromium launcher using the target project's node_modules.
 * @param {string} project directory containing the project's package.json
 * @throws {UsageError} if no Playwright package resolves from there
 */
export function loadChromium(project) {
  const require = createRequire(path.join(path.resolve(project), 'package.json'));
  for (const name of PACKAGES) {
    let resolved;
    try {
      resolved = require.resolve(name);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    return require(resolved).chromium;
  }
  throw new UsageError(`Playwright not found from ${path.resolve(project)} (install @playwright/test there, or pass --project)`);
}

/** Launch headless Chromium with the deterministic rasteriser; a missing browser binary becomes a UsageError with the fix command. */
export async function launch(chromium) {
  try {
    return await chromium.launch({ args: RENDER_ARGS });
  } catch (error) {
    throw new UsageError(`cannot launch Chromium: ${error.message.split('\n')[0]} (run: npx playwright install chromium)`);
  }
}

/**
 * Focus the page's `[autofocus]` field when nothing holds focus (Chromium sometimes skips autofocus); a field the page focused is kept.
 * @param {object} page Playwright page
 * @returns {Promise<void>}
 */
export function applyAutofocus(page) {
  return page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector('[autofocus]')?.focus({ preventScroll: true });
  });
}

/**
 * Open a page with deterministic rendering settings and wait until it is stable.
 * @param {object} browser Playwright browser
 * @param {{url: string, width: number, height: number, scale?: number, steps?: object[], bypassCSP?: boolean}} opts viewport equals the Figma frame;
 *   steps (validated, see steps.mjs) run after the page settles and the autofocus field is focused, before the freeze style; bypassCSP (default false, test-only)
 *   lets the injected freeze style through a page CSP
 * @returns {Promise<object>} Playwright page (its context closes with the browser)
 */
export async function openPage(browser, { url, width, height, scale = 1, steps = [], bypassCSP = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    ...(bypassCSP ? { bypassCSP: true } : {}),
  });
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: 'load' });
  // file:// and about: navigations give a null response; HTTP error pages must not be audited as the app.
  if (response && response.status() >= HTTP_ERROR_MIN) throw new UsageError(`${url} returned HTTP ${response.status()}`);
  try {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error; // never idle is expected for some apps; anything else is real
  }
  await page.waitForTimeout(SPA_SETTLE_MS);
  await applyAutofocus(page);
  if (steps.length > 0) await runSteps(page, steps);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  try {
    // Lazy images below the fold never load without scrolling, so they are not waited on.
    await page.waitForFunction(() => [...document.images].every((img) => img.complete || img.loading === 'lazy'), undefined, { timeout: IMAGE_WAIT_TIMEOUT_MS });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
  return page;
}
