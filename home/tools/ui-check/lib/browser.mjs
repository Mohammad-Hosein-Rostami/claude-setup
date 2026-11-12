// Purpose: resolve Playwright from the target project and open deterministic pages.
// Exports: loadChromium, launch, openPage. Invariants: no browser download here; pages are frozen
// (fonts ready, animations off, caret hidden, reduced motion) before any measurement.
import { createRequire } from 'node:module';
import path from 'node:path';
import { UsageError } from './errors.mjs';

const PACKAGES = ['playwright', '@playwright/test', 'playwright-core'];
const NETWORK_IDLE_TIMEOUT_MS = 5000; // long-polling / websocket apps never go idle, so the wait is bounded
const SPA_SETTLE_MS = 1500; // SPAs often render after the load event
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

/** Launch headless Chromium; a missing browser binary becomes a UsageError with the fix command. */
export async function launch(chromium) {
  try {
    return await chromium.launch();
  } catch (error) {
    throw new UsageError(`cannot launch Chromium: ${error.message.split('\n')[0]} (run: npx playwright install chromium)`);
  }
}

/**
 * Open a page with deterministic rendering settings and wait until it is stable.
 * @param {object} browser Playwright browser
 * @param {{url: string, width: number, height: number, scale?: number}} opts viewport equals the Figma frame
 * @returns {Promise<object>} Playwright page (its context closes with the browser)
 */
export async function openPage(browser, { url, width, height, scale = 1 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error; // never idle is expected for some apps; anything else is real
  }
  await page.waitForTimeout(SPA_SETTLE_MS);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  return page;
}
