// Purpose: resolve Playwright from the target project and open deterministic pages.
// Exports: loadChromium, launch, openPage, applyAutofocus, documentDirection, assertDirection, RENDER_ARGS. HTTP >= 400 is a UsageError (exit 2). Invariants: no browser
// download here; pages are frozen (fonts ready, animations off, caret hidden, reduced motion) before any measurement; Chromium
// rasterises on the CPU (SwiftShader) because GPU tile rasterisation gave 1-3 level edge noise between runs; an [autofocus] field is
// focused explicitly because Chromium skips autofocus in about one load in seven, which flips the focus ring between runs.
// Opt-in context (locale, colour scheme, localStorage and cookies for the --url origin, expected direction) is applied before the page
// loads; defaults (no locale, light, nothing set, no direction check) leave a run exactly as it was.
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

/** Computed `direction` of the document element, so a language switch can be proven to have happened. */
export function documentDirection(page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).direction);
}

/**
 * Fail unless the document's computed direction is `expected` (after load and steps).
 * @param {object} page Playwright page
 * @param {'ltr'|'rtl'} expected value of --expect-dir
 * @throws {UsageError} when the direction differs
 */
export async function assertDirection(page, expected) {
  const actual = await documentDirection(page);
  if (actual !== expected) throw new UsageError(`--expect-dir ${expected}: the computed direction is ${actual} (the language switch did not happen)`);
}

/** Origin string as the page sees it (`protocol//host`), also for file: URLs, where `location.origin` is not comparable. */
function pageOrigin(url) {
  const { protocol, host } = new URL(url);
  return `${protocol}//${host}`;
}

const SEEDED_MARKER = '__ui-check-seeded';

/**
 * Set localStorage entries before any page script runs, once per tab and only on the --url origin (a redirect elsewhere is left alone).
 * The init script runs again on every navigation, so a sessionStorage marker stops a reload from overwriting what the app stored since
 * (a language switch by click and reload must stick).
 */
async function seedStorage(context, url, storage) {
  const entries = storage.map(({ name, value }) => [name, value]);
  await context.addInitScript(({ origin, entries: pairs, marker }) => {
    if (`${location.protocol}//${location.host}` !== origin || sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, '1');
    for (const [key, value] of pairs) localStorage.setItem(key, value);
  }, { origin: pageOrigin(url), entries, marker: SEEDED_MARKER });
}

async function seedCookies(context, url, cookies) {
  if (!/^https?:/.test(url)) throw new UsageError(`--cookie needs an http(s) --url, got ${url}`);
  await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url })));
}

/**
 * Open a page with deterministic rendering settings and wait until it is stable.
 * @param {object} browser Playwright browser
 * @param {{url: string, width: number, height: number, scale?: number, steps?: object[], bypassCSP?: boolean, autofocus?: boolean,
 *   locale?: string, colorScheme?: 'light'|'dark', storage?: {name: string, value: string}[], cookies?: {name: string, value: string}[], expectDir?: 'ltr'|'rtl'}} opts
 *   viewport equals the Figma frame; steps (validated, see steps.mjs) run after the page settles and the autofocus field is focused, before the freeze style;
 *   bypassCSP (default false, test-only) lets the injected freeze style through a page CSP; autofocus (default true) focuses the page's `[autofocus]` field,
 *   false keeps the unfocused state for a Figma frame that shows it; locale sets navigator.language and Accept-Language; colorScheme defaults to light;
 *   storage and cookies are set for the url's origin before the page's scripts run (cookies need an http(s) url); expectDir fails the run when the
 *   computed direction of the document element differs after load and steps
 * @returns {Promise<object>} Playwright page (its context closes with the browser)
 * @throws {UsageError} on HTTP >= 400, a failed step, cookies on a non-http url, or a direction mismatch
 */
export async function openPage(browser, opts) {
  const { url, width, height, scale = 1, steps = [], bypassCSP = false, autofocus = true, locale, colorScheme = 'light', storage = [], cookies = [], expectDir } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    colorScheme,
    ...(locale === undefined ? {} : { locale }),
    ...(bypassCSP ? { bypassCSP: true } : {}),
  });
  if (storage.length > 0) await seedStorage(context, url, storage);
  if (cookies.length > 0) await seedCookies(context, url, cookies);
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
  if (autofocus) await applyAutofocus(page);
  if (steps.length > 0) await runSteps(page, steps);
  if (expectDir !== undefined) await assertDirection(page, expectDir);
  await freezeAndSettle(page);
  return page;
}

async function freezeAndSettle(page) {
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  try {
    // Lazy images below the fold never load without scrolling, so they are not waited on.
    await page.waitForFunction(() => [...document.images].every((img) => img.complete || img.loading === 'lazy'), undefined, { timeout: IMAGE_WAIT_TIMEOUT_MS });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
  }
}
