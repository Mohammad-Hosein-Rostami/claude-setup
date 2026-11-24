// Purpose: `first-paint` probe: load one page with a class of files held back (every script, or every font), record every frame
// from navigation until the page settles (an in-page sampler on every animation frame), and judge the screens a visitor saw, in order.
// Ported and cut from an earlier web app project's harness `harness/first-paint/` (capture.mjs holdRequests and trackRequests,
// fonts.mjs and sequence.mjs frame logs, in-page.js layout shifts): one generic hold by Playwright resource type instead of that
// project's asset paths, no font-gate timer, no gallery driver, no screenshots (the frames are DOM records, so the verdict stays numeric).
// Exports: HOLDS, HOLD_MS, SETTLE_DEADLINE_MS, MAX_FRAMES, measurePass, judgeFrames, frameLabel, samplerScript.
// Invariants: nothing is injected into the page except the read-only sampler (it never changes the DOM, focus, scroll or styles) and
// the opt-in storage seed: no freeze style, no transition-off style, reduced motion is NOT requested, because transitions and late
// swaps are what this probe looks for (the capture preset compare uses stays off here). A held request is answered only after
// HOLD_MS; the hold is released before the context closes, also when the load throws. Requests are held through Playwright's
// router, so the page must be http(s). judgeFrames is pure.
// A frame is one of four kinds:
//   blank    nothing a visitor could read or use: no visible text, form control, link, button, heading or image. Backgrounds
//            and shapes only, so a CSS or SVG spinner without a role is blank too (the harness: "the empty page, background only").
//   loader   the neutral loader: everything readable or usable that is visible sits inside an element with role="progressbar"
//            (MUI CircularProgress and LinearProgress have it); a "Loading..." label outside such an element makes a screen.
//   fallback (fonts hold only) a screen shown while one of its font faces is still loading: fallback or invisible text.
//   screen   anything else; two screens are the same when every visible content element has the same tag, own text and box.
// The rule (async-ui-states item 8, "the loader, then the one right screen"): the frames in order are blank and/or one loader,
// then the final screen, nothing in between, and no layout shift from the first frame that is not blank.
import { setTimeout as delay } from 'node:timers/promises';
import { assertDirection } from './browser.mjs';
import { UsageError } from './errors.mjs';

/** Hold name -> the Playwright resource type that is held back in that pass (scripts first, then fonts). */
export const HOLDS = Object.freeze({ scripts: 'script', fonts: 'font' });
export const HOLD_MS = 1500; // the harness: long enough to see what paints first, under a 3 s font block period
const STABLE_MS = 1000; // settled = no frame changed for this long ...
const QUIET_MS = 500; // ... and no request in flight for this long (the harness's capture.mjs) ...
const NETWORK_WAIT_MAX_MS = 5000; // ... unless the network never goes quiet (long polling, websockets), as in lib/browser.mjs
export const SETTLE_DEADLINE_MS = 15_000; // a page still changing after this does not settle (a violation, not an error)
const POLL_MS = 50;
const HTTP_ERROR_MIN = 400;
const BINDING = '__uiCheckFirstPaint';
const SEEDED_MARKER = '__ui-check-seeded';
export const MAX_FRAMES = 600; // more different frames than this: the page never stops changing (an endless animation)
const FRAME_TOLERANCE_MS = 20; // a layout shift in the frame that first shows content belongs to that frame (the harness's fonts.mjs)
const LOADER_SELECTOR = '[role=progressbar]';
// Elements that count as content even without own text (a field, a button, an image, a heading, a progress bar).
const CONTENT_SELECTOR = 'input:not([type=hidden]), select, textarea, button, a[href], img, picture, video, canvas, iframe, h1, h2, h3, h4, h5, h6, [role=progressbar]';
const MIN_BOX_PX = 1; // a 1x1 px box is visually hidden text (sr-only), not something a visitor sees
const MAX_TEXT_CHARS = 60; // own text kept per element in a frame record
const MAX_REASON_CHARS = 120;
const ALLOWED_BEFORE_FINAL = new Set(['', 'blank', 'loader', 'blank>loader']);
const SHIFT_DIGITS = 4;
const MS_PER_SECOND = 1000;

/**
 * Runs in the page: what is on screen now. Must not reference anything outside itself (it is sent to the page as source).
 * @param {{content: string, loader: string, minBox: number, maxText: number}} config
 * @returns {{kind: 'blank'|'loader'|'screen', fontsLoading: boolean, path: string, heading: string, items: string[]}}
 */
function readFrame(config) {
  const fontsLoading = [...document.fonts].some((face) => face.status === 'loading');
  const frame = { fontsLoading, path: location.pathname + location.search, heading: '', items: [] };
  let loaderOnly = true;
  for (const element of document.body?.querySelectorAll('*') ?? []) {
    const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.data).join(' ');
    // Only a field's value and placeholder are text a visitor reads (li.value and button.value are not shown).
    const field = /^(input|textarea|select)$/.test(element.localName) ? `${element.value} ${element.getAttribute('placeholder') ?? ''}` : '';
    const text = `${own} ${field}`.replace(/\s+/g, ' ').trim();
    const content = !element.closest('svg') && (element.matches(config.content) || /[\p{L}\p{N}]/u.test(text));
    const box = element.getBoundingClientRect();
    const shown = content && box.width > config.minBox && box.height > config.minBox && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    if (!shown) continue;
    frame.items.push(`${element.localName} "${text.slice(0, config.maxText)}" ${[box.x + scrollX, box.y + scrollY, box.width, box.height].map(Math.round).join(',')}`);
    if (!element.closest(config.loader)) loaderOnly = false;
    if (!frame.heading && /^h[1-6]$/.test(element.localName)) frame.heading = text.slice(0, config.maxText);
  }
  const kind = frame.items.length === 0 ? 'blank' : loaderOnly ? 'loader' : 'screen';
  return { ...frame, kind, heading: frame.heading || (frame.items[0] ?? '') };
}

/**
 * Runs in the page before any page script: sends a frame record through the binding whenever readFrame's answer changes, and every
 * layout shift. Times are epoch ms (timeOrigin + now), so frames of a document that replaced another one stay in order.
 * @param {{binding: string}} config plus readFrame's config
 * @param {Function} read readFrame
 */
function startSampler(config, read) {
  const send = (message) => window[config.binding](message);
  const epoch = (time) => performance.timeOrigin + time;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) send({ type: 'shift', value: entry.value, at: epoch(entry.startTime) });
  }).observe({ type: 'layout-shift', buffered: true });
  let lastKey = '';
  const sample = () => {
    const frame = read(config);
    const key = JSON.stringify([frame.kind, frame.fontsLoading, frame.path, frame.items]);
    if (key !== lastKey) send({ type: 'frame', at: epoch(performance.now()), ...frame });
    lastKey = key;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

/**
 * The init script source for one page: the sampler with its configuration.
 * @param {string} binding name of the exposed binding that receives the records
 * @returns {string} JavaScript for context.addInitScript({ content })
 */
export function samplerScript(binding) {
  const config = { binding, content: CONTENT_SELECTOR, loader: LOADER_SELECTOR, minBox: MIN_BOX_PX, maxText: MAX_TEXT_CHARS };
  return `(${startSampler})(${JSON.stringify(config)}, ${readFrame});`;
}

/**
 * The word a frame shows as in the screens list.
 * @param {{kind: string, fontsLoading: boolean}} frame a frame record
 * @param {'scripts'|'fonts'} hold the hold of the pass; only the fonts hold judges text shown while a font is loading
 * @returns {'blank'|'loader'|'fallback'|'screen'}
 */
export function frameLabel(frame, hold) {
  return hold === 'fonts' && frame.kind === 'screen' && frame.fontsLoading ? 'fallback' : frame.kind;
}

/** Consecutive frames that look the same, as one run: screens by their items, the other labels by the label alone. */
function collapse(frames, hold) {
  const runs = [];
  for (const frame of frames) {
    const label = frameLabel(frame, hold);
    const identity = label === 'screen' ? `screen ${JSON.stringify(frame.items)}` : label;
    if (runs.at(-1)?.identity !== identity) runs.push({ label, identity, frame });
  }
  return runs;
}

const clip = (text) => (text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text);

/** First element line where two screens differ, as `before -> after`. */
function firstDifference(items, finalItems) {
  const index = items.findIndex((item, at) => item !== finalItems[at]);
  const at = index === -1 ? items.length : index;
  return `${clip(items[at] ?? 'nothing')} -> ${clip(finalItems[at] ?? 'nothing')}`;
}

function describeRun(run, final) {
  if (run.label !== 'screen') return run.label === 'fallback' ? `fallback text "${clip(run.frame.heading)}"` : run.label;
  const name = `screen "${clip(run.frame.heading)}" ${run.frame.path}`;
  return run === final ? name : `${name} (differs from the final screen: ${firstDifference(run.frame.items, final.frame.items)})`;
}

function shiftFrom(shifts, from) {
  return shifts.filter((shift) => shift.at >= from).reduce((sum, shift) => sum + shift.value, 0);
}

/**
 * Judge one pass: the screens in order and the layout shift after the first frame that is not blank.
 * @param {{hold: 'scripts'|'fonts', frames: object[], shifts: {value: number, at: number}[], timedOut: boolean, overflow: boolean, settleMs: number}} record
 *   frames as the sampler sent them (any order), timedOut = the page did not settle within settleMs, overflow = more than MAX_FRAMES frames
 * @returns {{ok: boolean, screens: string[], shift: number, violations: string[]}} violations is empty when the pass passes
 */
export function judgeFrames({ hold, frames, shifts, timedOut, overflow, settleMs }) {
  const ordered = [...frames].sort((a, b) => a.at - b.at);
  const runs = collapse(ordered, hold);
  const final = runs.at(-1);
  const screens = runs.map((run) => describeRun(run, final));
  const firstVisible = ordered.find((frame) => frame.kind !== 'blank');
  const shift = firstVisible ? shiftFrom(shifts, firstVisible.at - FRAME_TOLERANCE_MS) : 0;
  const before = runs.slice(0, -1).map((run) => run.label).join('>');
  const violations = [];
  if (overflow) violations.push(`the page kept changing: more than ${MAX_FRAMES} different frames`);
  if (timedOut) violations.push(`the page did not settle within ${settleMs / MS_PER_SECOND} s`);
  if (final?.label !== 'screen') violations.push(`the page settled on ${final?.label ?? 'nothing'}, not on a screen`);
  if (!ALLOWED_BEFORE_FINAL.has(before)) violations.push(`frames in order: ${screens.join(' > ')}; want blank or one loader, then the final screen`);
  if (shift > 0) violations.push(`layout shift ${shift.toFixed(SHIFT_DIGITS)} after the first visible frame`);
  return { ok: violations.length === 0, screens, shift, violations };
}

/**
 * A fresh context with the state's viewport and page context; storage and cookies are set for the url's origin before any page script.
 * The storage seed runs once per tab (a sessionStorage marker), as in lib/browser.mjs, so a navigation keeps what the app stored.
 */
async function newProbeContext(browser, target) {
  const { url, width, height, locale, colorScheme = 'light', storage = [], cookies = [] } = target;
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, colorScheme, reducedMotion: 'no-preference', ...(locale === undefined ? {} : { locale }),
  });
  if (cookies.length > 0) await context.addCookies(cookies.map(({ name, value }) => ({ name, value, url })));
  if (storage.length === 0) return context;
  await context.addInitScript(({ origin, pairs, marker }) => {
    if (`${location.protocol}//${location.host}` !== origin || sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, '1');
    for (const [key, value] of pairs) localStorage.setItem(key, value);
  }, { origin: new URL(url).origin, pairs: storage.map(({ name, value }) => [name, value]), marker: SEEDED_MARKER });
  return context;
}

/** Collect the sampler's frame and shift records; `lastChangeAt` is the Node clock when the last frame arrived. */
async function recordFrames(context) {
  const record = { frames: [], shifts: [], overflow: false, lastChangeAt: Date.now() };
  await context.exposeBinding(BINDING, (_source, message) => {
    if (message.type === 'shift') {
      record.shifts.push(message);
      return;
    }
    record.lastChangeAt = Date.now();
    if (record.frames.length < MAX_FRAMES) record.frames.push(message);
    else record.overflow = true;
  });
  await context.addInitScript({ content: samplerScript(BINDING) });
  return record;
}

/** Answer every request of `resourceType` only after release(); every other request goes on at once. */
async function holdRequests(context, resourceType) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const held = [];
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() === resourceType) {
      held.push(route.request().url());
      await released;
    }
    await route.continue();
  });
  return { held, release };
}

/** Requests in flight on the page and the Node time of the last start or end of one. */
function trackNetwork(page) {
  const inFlight = new Set();
  const network = { lastActivityAt: Date.now(), pending: () => inFlight.size };
  const done = (request) => { inFlight.delete(request); network.lastActivityAt = Date.now(); };
  page.on('request', (request) => { inFlight.add(request); network.lastActivityAt = Date.now(); });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return network;
}

/** Wait until no frame changed for STABLE_MS and the network is quiet (or has had NETWORK_WAIT_MAX_MS); timedOut after SETTLE_DEADLINE_MS. */
async function waitUntilSettled(record, network) {
  const started = Date.now();
  for (;;) {
    const now = Date.now();
    const framesStill = now - record.lastChangeAt >= STABLE_MS;
    const quiet = (network.pending() === 0 && now - network.lastActivityAt >= QUIET_MS) || now - started >= NETWORK_WAIT_MAX_MS;
    if (record.overflow || (framesStill && quiet)) return { timedOut: false };
    if (now - started >= SETTLE_DEADLINE_MS) return { timedOut: true };
    await delay(POLL_MS);
  }
}

/** Navigate, keep the held files back for HOLD_MS, then release them (also when the navigation throws). */
async function loadHeld(page, url, hold) {
  try {
    const response = await page.goto(url, { waitUntil: 'commit' });
    if (response && response.status() >= HTTP_ERROR_MIN) throw new UsageError(`${url} returned HTTP ${response.status()}`);
    await page.waitForTimeout(HOLD_MS);
  } finally {
    hold.release();
  }
  await page.waitForLoadState('load', { timeout: SETTLE_DEADLINE_MS });
}

/**
 * Measure one pass of one page: hold `holdName`'s files, record the frames until the page settles, judge them.
 * @param {object} browser Playwright browser (launched by lib/browser.mjs launch)
 * @param {{url: string, width: number, height: number, locale?: string, colorScheme?: 'light'|'dark', storage?: object[], cookies?: object[], expectDir?: 'ltr'|'rtl'}} target
 *   url must be http(s); the context fields are the states file's (lib/states.mjs `context`)
 * @param {'scripts'|'fonts'} holdName key of HOLDS
 * @returns {Promise<{hold: string, ok: boolean, screens: string[], shift: number, violations: string[], heldFiles: string[], frames: object[], shifts: object[]}>}
 * @throws {UsageError} on a non-http(s) url, HTTP >= 400 or an expectDir mismatch; Error when no frame was recorded or the load never ends
 */
export async function measurePass(browser, target, holdName) {
  if (!/^https?:$/.test(new URL(target.url).protocol)) throw new UsageError(`first-paint needs an http(s) url (files are held through Playwright's request router), got ${target.url}`);
  const context = await newProbeContext(browser, target);
  try {
    const record = await recordFrames(context);
    const hold = await holdRequests(context, HOLDS[holdName]);
    const page = await context.newPage();
    const network = trackNetwork(page);
    await loadHeld(page, target.url, hold);
    const { timedOut } = await waitUntilSettled(record, network);
    if (target.expectDir !== undefined) await assertDirection(page, target.expectDir);
    if (record.frames.length === 0) throw new Error('no frame was recorded (the in-page sampler did not run)');
    const verdict = judgeFrames({ hold: holdName, frames: record.frames, shifts: record.shifts, timedOut, overflow: record.overflow, settleMs: SETTLE_DEADLINE_MS });
    return { hold: holdName, ...verdict, heldFiles: hold.held, frames: record.frames, shifts: record.shifts };
  } finally {
    await context.close();
  }
}
