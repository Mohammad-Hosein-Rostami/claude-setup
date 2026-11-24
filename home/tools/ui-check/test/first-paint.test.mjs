// Purpose: browser-free tests for lib/first-paint.mjs: the constants, frameLabel, every judgeFrames verdict and violation (overflow,
// timeout, final frame, frame order, layout shift with its 20 ms tolerance, clipped headings), and the samplerScript source run against
// a stub page (no Chromium). Exports: none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { frameLabel, HOLD_MS, HOLDS, judgeFrames, MAX_FRAMES, samplerScript, SETTLE_DEADLINE_MS } from '../lib/first-paint.mjs';
import { isolateEach } from './isolated-env.mjs';

isolateEach('first-paint');
const FINAL_ITEMS = ['h1 "Welcome" 0,0,200,40'];
const T0 = 1_000_000; // epoch ms of the first frame
const frame = (kind, at, extra = {}) => ({ kind, at, fontsLoading: false, path: '/', heading: '', items: kind === 'blank' ? [] : ['div "x" 0,0,1,1'], ...extra });
const screen = (at, extra = {}) => frame('screen', at, { heading: 'Welcome', items: FINAL_ITEMS, ...extra });
const judge = (frames, extra = {}) => judgeFrames({ hold: 'scripts', frames, shifts: [], timedOut: false, overflow: false, settleMs: SETTLE_DEADLINE_MS, ...extra });

test('constants: HOLDS maps each pass to its Playwright resource type and is frozen; the timings and the frame cap', () => {
  assert.deepEqual({ ...HOLDS }, { scripts: 'script', fonts: 'font' });
  assert.ok(Object.isFrozen(HOLDS));
  assert.deepEqual([HOLD_MS, SETTLE_DEADLINE_MS, MAX_FRAMES], [1500, 15_000, 600]);
});

test('frameLabel: only the fonts hold turns a screen with a loading font into fallback', () => {
  const loading = { kind: 'screen', fontsLoading: true };
  assert.equal(frameLabel(loading, 'fonts'), 'fallback');
  assert.equal(frameLabel(loading, 'scripts'), 'screen');
  assert.equal(frameLabel({ kind: 'screen', fontsLoading: false }, 'fonts'), 'screen');
  assert.equal(frameLabel({ kind: 'loader', fontsLoading: true }, 'fonts'), 'loader');
  assert.equal(frameLabel({ kind: 'blank', fontsLoading: true }, 'fonts'), 'blank');
});

test('judgeFrames: blank, then one loader, then the final screen passes; frames are sorted by time first', () => {
  const verdict = judge([screen(T0 + 30), frame('loader', T0 + 10), frame('blank', T0), frame('loader', T0 + 20)]);
  assert.deepEqual(verdict, { ok: true, screens: ['blank', 'loader', 'screen "Welcome" /'], shift: 0, violations: [] });
  assert.equal(judge([screen(T0)]).ok, true, 'the final screen alone passes');
});

test('judgeFrames: overflow and timedOut each add their own violation; the timeout names settleMs in seconds', () => {
  const both = judge([screen(T0)], { overflow: true, timedOut: true });
  assert.deepEqual(both.violations, ['the page kept changing: more than 600 different frames', 'the page did not settle within 15 s']);
  assert.equal(both.ok, false);
  assert.deepEqual(judge([screen(T0)], { timedOut: true, settleMs: 2500 }).violations, ['the page did not settle within 2.5 s']);
  assert.deepEqual(judge([screen(T0)], { settleMs: SETTLE_DEADLINE_MS * 2 }).violations, [], 'settleMs alone is no violation; timedOut is');
});

test('judgeFrames: a pass that settles on blank, a loader or no frame at all fails', () => {
  assert.deepEqual(judge([frame('blank', T0)]).violations, ['the page settled on blank, not on a screen']);
  assert.deepEqual(judge([frame('blank', T0), frame('loader', T0 + 1)]).violations, ['the page settled on loader, not on a screen']);
  assert.deepEqual(judge([]), { ok: false, screens: [], shift: 0, violations: ['the page settled on nothing, not on a screen'] });
});

test('judgeFrames: another screen before the final one fails and says the first element line that differs', () => {
  const early = screen(T0, { heading: 'Sign in', path: '/login', items: ['h1 "Sign in" 0,0,200,40'] });
  const verdict = judge([early, screen(T0 + 10)]);
  const first = 'screen "Sign in" /login (differs from the final screen: h1 "Sign in" 0,0,200,40 -> h1 "Welcome" 0,0,200,40)';
  assert.deepEqual(verdict.screens, [first, 'screen "Welcome" /']);
  assert.deepEqual(verdict.violations, [`frames in order: ${first} > screen "Welcome" /; want blank or one loader, then the final screen`]);
  const shorter = judge([screen(T0, { items: [] }), screen(T0 + 10)]);
  assert.match(shorter.screens[0], /\(differs from the final screen: nothing -> h1 "Welcome" 0,0,200,40\)$/);
});

test('judgeFrames: a loader, a blank and a loader again fails; a blank after a loader fails; two loaders in a row are one', () => {
  const back = judge([frame('loader', T0), frame('blank', T0 + 1), frame('loader', T0 + 2), screen(T0 + 3)]);
  assert.equal(back.ok, false);
  assert.match(back.violations[0], /^frames in order: loader > blank > loader > screen "Welcome" \/;/);
  assert.equal(judge([frame('loader', T0), frame('blank', T0 + 1), screen(T0 + 2)]).ok, false);
  assert.deepEqual(judge([frame('loader', T0), frame('loader', T0 + 1, { items: ['span "other" 0,0,9,9'] }), screen(T0 + 2)]).screens, ['loader', 'screen "Welcome" /']);
});

test('judgeFrames: screens with the same items are one run even when the heading or path record differs', () => {
  assert.deepEqual(judge([screen(T0, { heading: 'Old' }), screen(T0 + 5)]).screens, ['screen "Old" /']);
});

test('judgeFrames: under the fonts hold a fallback frame before the screen fails; the same frames pass the scripts hold', () => {
  const frames = [screen(T0, { fontsLoading: true }), screen(T0 + 10)];
  const fonts = judgeFrames({ hold: 'fonts', frames, shifts: [], timedOut: false, overflow: false, settleMs: SETTLE_DEADLINE_MS });
  assert.deepEqual(fonts.screens, ['fallback text "Welcome"', 'screen "Welcome" /']);
  assert.equal(fonts.ok, false);
  assert.equal(judge(frames).ok, true);
});

test('judgeFrames: layout shift counts from 20 ms before the first visible frame, summed, and is a violation above 0', () => {
  const frames = [frame('blank', T0), screen(T0 + 100)];
  const shifts = [{ value: 0.5, at: T0 + 79 }, { value: 0.02, at: T0 + 80 }, { value: 0.03, at: T0 + 400 }];
  const verdict = judge(frames, { shifts });
  assert.ok(Math.abs(verdict.shift - 0.05) < 1e-12);
  assert.deepEqual(verdict.violations, ['layout shift 0.0500 after the first visible frame']);
  assert.equal(judge([frame('blank', T0)], { shifts }).shift, 0, 'no visible frame: no shift is counted');
  assert.equal(judge(frames, { shifts: [{ value: 0.9, at: T0 + 50 }] }).ok, true, 'a shift while the page was still blank is not counted');
});

test('judgeFrames: a heading over 120 characters is cut to 119 and an ellipsis', () => {
  const long = 'W'.repeat(130);
  assert.equal(judge([screen(T0, { heading: long })]).screens[0], `screen "${'W'.repeat(119)}…" /`);
});

/** Install stub page globals for one samplerScript run; returns what the sampler sent and a way to run one animation frame. */
function stubPage(elements, fonts = []) {
  const names = ['window', 'document', 'location', 'Node', 'scrollX', 'scrollY', 'requestAnimationFrame', 'PerformanceObserver'];
  const before = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const page = { sent: [], observed: [], next: null, fonts };
  const values = {
    window: { __probe: (message) => page.sent.push(message) },
    document: { get fonts() { return page.fonts; }, body: { querySelectorAll: () => elements } },
    location: { pathname: '/start', search: '?a=1' },
    Node: { TEXT_NODE: 3 },
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: (callback) => { page.next = callback; },
    PerformanceObserver: class { observe(options) { page.observed.push(options); } },
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  page.restore = () => before.forEach(([name, descriptor]) => (descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]));
  return page;
}

const element = ({ tag, text = '', box = [0, 0, 100, 20], inLoader = false, content = false }) => ({
  localName: tag,
  childNodes: text ? [{ nodeType: 3, data: text }] : [],
  matches: () => content,
  closest: (selector) => (selector === 'svg' ? null : inLoader ? {} : null),
  getBoundingClientRect: () => ({ x: box[0], y: box[1], width: box[2], height: box[3] }),
  checkVisibility: () => true,
  getAttribute: () => null,
});

test('samplerScript: the source sends a frame through the named binding, only when the frame changes, and observes layout shifts', () => {
  const loaderLabel = element({ tag: 'span', text: 'Loading', inLoader: true, box: [10, 20, 80, 16] });
  const srOnly = element({ tag: 'span', text: 'hidden', box: [0, 0, 1, 1] });
  const page = stubPage([loaderLabel, srOnly]);
  try {
    new Function(samplerScript('__probe'))(); // the script is self-contained source, as addInitScript runs it
    page.next();
    page.next();
    page.fonts = [{ status: 'loading' }];
    page.next();
  } finally {
    page.restore();
  }
  assert.deepEqual(page.observed, [{ type: 'layout-shift', buffered: true }]);
  assert.equal(page.sent.length, 2, 'an unchanged frame is not sent again');
  const { at, ...first } = page.sent[0];
  assert.equal(typeof at, 'number');
  assert.deepEqual(first, { type: 'frame', fontsLoading: false, path: '/start?a=1', heading: 'span "Loading" 10,20,80,16', items: ['span "Loading" 10,20,80,16'], kind: 'loader' });
  assert.equal(page.sent[1].fontsLoading, true);
});

test('samplerScript: a heading outside the loader makes a screen; no shown element makes a blank frame', () => {
  const page = stubPage([element({ tag: 'h1', text: 'Hello   world', content: true })]);
  try {
    new Function(samplerScript('__probe'))();
    page.next();
  } finally {
    page.restore();
  }
  assert.deepEqual([page.sent[0].kind, page.sent[0].heading], ['screen', 'Hello world']);
  const empty = stubPage([]);
  try {
    new Function(samplerScript('__probe'))();
    empty.next();
  } finally {
    empty.restore();
  }
  assert.deepEqual([empty.sent[0].kind, empty.sent[0].items, empty.sent[0].heading], ['blank', [], '']);
});
