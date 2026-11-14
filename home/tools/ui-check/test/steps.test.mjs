// Purpose: browser-free tests for steps validation, selector-count enforcement, the --steps/--bypass-csp flags and
// the bypass wiring in openPage (default off). Exports: none. Invariant: every steps rejection is a UsageError naming the step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from '../lib/args.mjs';
import { openPage } from '../lib/browser.mjs';
import { UsageError } from '../lib/errors.mjs';
import { loadSteps, runSteps, validateSteps } from '../lib/steps.mjs';
import { options as compareOptions, pageOptions } from '../commands/compare.mjs';
import { options as responsiveOptions, auditWidth } from '../commands/responsive.mjs';

const GOOD = [
  { action: 'fill', selector: '#email', value: 'a@b.c' }, { action: 'click', selector: 'button' }, { action: 'hover', selector: 'a' },
  { action: 'press', selector: '#email', key: 'Tab' }, { action: 'blur' }, { action: 'wait', ms: 10 }, { action: 'waitFor', selector: '.x' },
];

test('a good list validates and is returned unchanged', () => {
  assert.equal(validateSteps(GOOD), GOOD);
});

test('an unknown action, including inherited object keys, names the step', () => {
  assert.throws(() => validateSteps([{ action: 'blur' }, { action: 'dance' }]), (e) => e instanceof UsageError && /step 2.*dance/.test(e.message));
  assert.throws(() => validateSteps([{ action: 'constructor' }]), /step 1.*constructor/);
});

test('a missing or wrongly typed field names the step and the field', () => {
  assert.throws(() => validateSteps([{ action: 'fill', selector: '#a' }]), /step 1.*"value"/);
  assert.throws(() => validateSteps([{ action: 'click', selector: 5 }]), /step 1.*"selector" must be a string/);
  assert.throws(() => validateSteps([{ action: 'wait', ms: -1 }]), /step 1.*"ms"/);
  assert.throws(() => validateSteps({}), /JSON array/);
  assert.throws(() => validateSteps([null]), /step 1.*object/);
});

test('loadSteps reads a file and rejects bad JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify(GOOD));
  assert.deepEqual(loadSteps(file), GOOD);
  fs.writeFileSync(file, '{nope');
  assert.throws(() => loadSteps(file), (e) => e instanceof UsageError && /--steps/.test(e.message));
});

test('a selector matching zero or two elements is a UsageError naming the step', async () => {
  const pageWith = (n) => ({ locator: () => ({ count: async () => n }) });
  for (const n of [0, 2]) {
    await assert.rejects(runSteps(pageWith(n), [{ action: 'click', selector: '.a' }]), (e) => e instanceof UsageError && new RegExp(`step 1.*matched ${n}`).test(e.message));
  }
});

test('runSteps calls the matching locator method once', async () => {
  const calls = [];
  const el = { count: async () => 1, hover: async () => calls.push('hover'), fill: async (v) => calls.push(`fill:${v}`) };
  await runSteps({ locator: () => el }, [{ action: 'hover', selector: 'a' }, { action: 'fill', selector: 'i', value: 'x' }]);
  assert.deepEqual(calls, ['hover', 'fill:x']);
});

test('--bypass-csp and --steps parse on compare and responsive; bypass defaults to off', () => {
  for (const table of [compareOptions, responsiveOptions]) {
    assert.equal(parse([], table)['bypass-csp'], false);
    assert.equal(parse(['--bypass-csp'], table)['bypass-csp'], true);
    assert.equal(parse(['--steps', 's.json'], table).steps, 's.json');
  }
});

function recordingBrowser(log) {
  const page = {
    goto: async () => null, waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => {},
    addStyleTag: async () => log.push('freeze'), waitForFunction: async () => {},
    locator: () => ({ count: async () => 1, click: async () => log.push('step') }),
  };
  return { newContext: async (opts) => { log.push(opts); return { newPage: async () => page }; } };
}
const view = { url: 'http://x', width: 10, height: 10 };

test('openPage does not bypass CSP by default and only does so when asked', async () => {
  const off = []; await openPage(recordingBrowser(off), view);
  assert.equal(Object.hasOwn(off[0], 'bypassCSP'), false);
  const on = []; await openPage(recordingBrowser(on), { ...view, bypassCSP: true });
  assert.equal(on[0].bypassCSP, true);
});

test('openPage runs steps before the freeze style', async () => {
  const log = [];
  await openPage(recordingBrowser(log), { ...view, steps: [{ action: 'click', selector: 'b' }] });
  assert.deepEqual(log.slice(1), ['step', 'freeze']);
});

test('unknown fields, ms above the cap and an empty --steps value are rejected', () => {
  assert.throws(() => validateSteps([{ action: 'click', selector: 'a', force: true }]), /step 1.*unknown field.*"force"/);
  assert.throws(() => validateSteps([{ action: 'wait', ms: 1e9 }]), /step 1.*"ms"/);
  assert.throws(() => loadSteps(''), (e) => e instanceof UsageError);
});

/** Stub locator recording each call; `fail` makes the named method reject with a multi-line Playwright-style error. */
function stubPage(calls, { fail, count = 1 } = {}) {
  const rec = (name) => async (...args) => {
    if (name === fail) throw new Error(`${name} timeout\nCall log: ...`);
    calls.push([name, ...args.filter((a) => typeof a === 'string')]);
  };
  const el = { count: async () => count };
  for (const name of ['click', 'check', 'uncheck', 'focus', 'hover', 'fill', 'press', 'selectOption', 'waitFor']) el[name] = rec(name);
  return { locator: () => el, evaluate: rec('blur'), waitForTimeout: async (ms) => calls.push(['wait', ms]) };
}

test('every action reaches the matching Playwright call with its arguments', async () => {
  const calls = [];
  await runSteps(stubPage(calls), [
    { action: 'click', selector: 'a' }, { action: 'press', selector: 'a', key: 'Tab' }, { action: 'select', selector: 's', value: 'v' },
    { action: 'check', selector: 'c' }, { action: 'uncheck', selector: 'c' }, { action: 'focus', selector: 'f' }, { action: 'waitFor', selector: 'w' },
    { action: 'blur' }, { action: 'wait', ms: 7 },
  ]);
  assert.deepEqual(calls.map((c) => c[0]), ['click', 'press', 'selectOption', 'check', 'uncheck', 'focus', 'waitFor', 'blur', 'wait']);
  assert.deepEqual(calls[1], ['press', 'Tab']);
  assert.deepEqual(calls[2], ['selectOption', 'v']);
  assert.deepEqual(calls[8], ['wait', 7]);
});

test('a Playwright failure becomes a UsageError naming the step and action, first line only', async () => {
  for (const [action, method] of [['click', 'click'], ['fill', 'fill'], ['press', 'press'], ['select', 'selectOption'], ['waitFor', 'waitFor']]) {
    const step = { action, selector: 'a', value: 'v', key: 'k' };
    const fields = { click: ['selector'], fill: ['selector', 'value'], press: ['selector', 'key'], select: ['selector', 'value'], waitFor: ['selector'] }[action];
    const clean = { action, ...Object.fromEntries(fields.map((f) => [f, step[f]])) };
    await assert.rejects(runSteps(stubPage([], { fail: method }), [{ action: 'blur' }, clean]),
      (e) => e instanceof UsageError && new RegExp(`step 2 \\(${action}\\): ${method} timeout$`).test(e.message));
  }
});

test('compare passes steps and the bypass flag to openPage options; default is off', () => {
  const meta = { width: 10.2, height: 20, scale: 2 };
  const steps = [{ action: 'blur' }];
  const on = pageOptions({ url: 'u', 'bypass-csp': true }, meta, steps);
  assert.deepEqual([on.steps, on.bypassCSP, on.width, on.scale], [steps, true, 11, 2]);
  assert.equal(pageOptions({ url: 'u', 'bypass-csp': false }, meta, []).bypassCSP, false);
});

test('responsive opens a page per width with the same steps and bypass flag', async () => {
  const opened = [];
  const page = { goto: async () => null, waitForLoadState: async () => {}, waitForTimeout: async () => {}, addStyleTag: async () => {},
    waitForFunction: async () => {}, evaluate: async () => ({ findings: [] }), screenshot: async () => {}, context: () => ({ close: async () => {} }),
    locator: () => ({ count: async () => 1, click: async () => opened.push('step') }) };
  const browser = { newContext: async (opts) => { opened.push(opts.viewport.width); return { newPage: async () => page }; } };
  const target = { url: 'u', height: 900, steps: [{ action: 'click', selector: 'b' }], bypassCSP: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-'));
  for (const width of [320, 768]) await auditWidth(browser, target, width, dir);
  assert.deepEqual(opened, [320, 'step', 768, 'step']);
});
