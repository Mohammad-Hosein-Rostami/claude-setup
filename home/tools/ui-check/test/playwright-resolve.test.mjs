// Purpose: browser-free tests for how ui-check finds Playwright: --project, then UI_CHECK_PROJECT, then the tool's own node_modules, then an
// error that lists every place tried and the exact fix. Exports: none. Fake Playwright packages live in temp folders; nothing is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageError } from '../lib/errors.mjs';
import { loadChromium, resolutionPlaces } from '../lib/playwright.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-pw-'));

/** A folder whose node_modules holds a fake `playwright` whose chromium is the marker string. */
function withPlaywright(name, marker) {
  const dir = path.join(root, name);
  const pkg = path.join(dir, 'node_modules', 'playwright');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), `module.exports = { chromium: ${JSON.stringify(marker)} };`);
  return dir;
}
const bare = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test('--project wins over UI_CHECK_PROJECT and the tool', () => {
  const found = loadChromium(withPlaywright('p1', 'from-project'), { env: { UI_CHECK_PROJECT: withPlaywright('e1', 'from-env') }, toolDir: withPlaywright('t1', 'from-tool') });
  assert.equal(found, 'from-project');
});

test('a --project without Playwright falls back to UI_CHECK_PROJECT (the bug: it used to exit 2)', () => {
  assert.equal(loadChromium(bare('p2'), { env: { UI_CHECK_PROJECT: withPlaywright('e2', 'from-env') }, toolDir: bare('t2') }), 'from-env');
});

test('then the tool\'s own node_modules', () => {
  assert.equal(loadChromium(bare('p3'), { env: {}, toolDir: withPlaywright('t3', 'from-tool') }), 'from-tool');
});

test('without --project the current directory is the first place, as before', () => {
  const cwd = process.cwd();
  process.chdir(withPlaywright('c4', 'from-cwd'));
  try {
    assert.equal(loadChromium(undefined, { env: { UI_CHECK_PROJECT: withPlaywright('e4', 'from-env') }, toolDir: bare('t4') }), 'from-cwd');
  } finally {
    process.chdir(cwd);
  }
});

test('nothing resolves: the error lists every place tried, in order, and the exact fix commands', () => {
  const project = bare('p5');
  const toolDir = bare('t5');
  assert.throws(() => loadChromium(project, { env: {}, toolDir }), (error) => {
    assert.ok(error instanceof UsageError);
    const text = error.message;
    const order = [`--project ${project}`, 'UI_CHECK_PROJECT (not set)', `the tool's own node_modules (${toolDir})`].map((part) => text.indexOf(part));
    assert.ok(order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2], text);
    assert.match(text, /UI_CHECK_PROJECT=<folder whose node_modules has playwright>/);
    assert.ok(text.includes(`npm install --no-save --prefix "${toolDir}" playwright`), text);
    assert.ok(text.includes('install chromium'), text);
    return true;
  });
});

test('a set UI_CHECK_PROJECT that has no Playwright is listed with its path; a place named twice is tried once', () => {
  const same = bare('p6');
  const places = resolutionPlaces(same, { UI_CHECK_PROJECT: same }, bare('t6'));
  assert.equal(places.length, 2);
  assert.match(places[0].label, /--project/);
  assert.match(resolutionPlaces(undefined, { UI_CHECK_PROJECT: same }, bare('t7'))[1].label, /UI_CHECK_PROJECT .*p6/);
});
