// Purpose: Chromium tests for the locale/direction work: bidi-field on a local fixture, --expect-dir pass and fail, --storage, --locale,
// --color-scheme, --cookie (over a local static server), and `batch` writing one record per state (compare and responsive).
// Exports: none. Runs only when UI_CHECK_PROJECT points at a project with Playwright and Chromium installed, like smoke.test.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { cacheDir } from '../lib/cache.mjs';
import { flattenSpec } from '../lib/spec.mjs';

const run = promisify(execFile);
const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const fixtureFile = (name) => path.join(here, 'fixtures', name);
const fixture = (name, query = '') => `${pathToFileURL(fixtureFile(name)).href}${query}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-locale-'));

async function ui(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function withPage(opts, fn) {
  const browser = await launch(loadChromium(project));
  try {
    return await fn(await openPage(browser, { width: 320, height: 400, ...opts }));
  } finally {
    await browser.close();
  }
}

test('responsive reports bidi-field for a tel input in an rtl document, and not for a field that sets dir=ltr or an ltr page', { skip: !project }, async () => {
  const dir = tmp();
  const bad = await ui('responsive', '--url', fixture('rtl.html'), '--widths', '320', '--out', path.join(dir, 'a'));
  assert.equal(bad.code, 1, bad.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'a', 'report.md'), 'utf8'), /bidi-field \| input#phone[\s\S]*bidi-field \| input#mail/);
  for (const name of ['rtl-ok.html', 'ltr.html']) {
    const clean = await ui('responsive', '--url', fixture(name), '--widths', '320', '--out', path.join(dir, name));
    assert.equal(clean.code, 0, `${name}: ${clean.stdout}${clean.stderr}`);
  }
});

test('--expect-dir rtl passes on an rtl page and fails with a clear error on an ltr page', { skip: !project }, async () => {
  const dir = tmp();
  const pass = await ui('responsive', '--url', fixture('rtl-ok.html'), '--widths', '320', '--expect-dir', 'rtl', '--out', path.join(dir, 'a'));
  assert.equal(pass.code, 0, pass.stdout + pass.stderr);
  const fail = await ui('responsive', '--url', fixture('ltr.html'), '--widths', '320', '--expect-dir', 'rtl', '--out', path.join(dir, 'b'));
  assert.equal(fail.code, 2);
  assert.match(fail.stderr, /--expect-dir rtl: the computed direction is ltr/);
});

test('--storage is set before page scripts run: the language switch flips the direction', { skip: !project }, async () => {
  const dir = tmp();
  const args = ['responsive', '--url', fixture('lang.html'), '--widths', '320', '--expect-dir', 'rtl'];
  const withStorage = await ui(...args, '--storage', 'lang=fa', '--out', path.join(dir, 'a'));
  assert.equal(withStorage.code, 0, withStorage.stdout + withStorage.stderr);
  const without = await ui(...args, '--out', path.join(dir, 'b'));
  assert.equal(without.code, 2, 'no storage = ltr page, so --expect-dir rtl must fail');
});

test('--locale reaches navigator.language, --color-scheme dark reaches the media query', { skip: !project }, async () => {
  const seen = await withPage({ url: fixture('lang.html'), locale: 'fa-IR', colorScheme: 'dark' }, (page) => page.evaluate(() => ({
    info: document.getElementById('info').textContent, dark: matchMedia('(prefers-color-scheme: dark)').matches,
  })));
  assert.match(seen.info, /^fa-IR\|/);
  assert.equal(seen.dark, true);
  const plain = await withPage({ url: fixture('lang.html') }, (page) => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches));
  assert.equal(plain, false);
});

test('--cookie reaches document.cookie for an http --url', { skip: !project }, async () => {
  const html = fs.readFileSync(fixtureFile('lang.html'));
  const server = http.createServer((_, res) => res.setHeader('content-type', 'text/html').end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const info = await withPage({ url, cookies: [{ name: 'sid', value: 'abc' }], storage: [{ name: 'lang', value: 'fa' }], expectDir: 'rtl' }, (page) => page.evaluate(() => document.getElementById('info').textContent));
    assert.match(info, /\|sid=abc$/);
  } finally {
    server.close();
  }
});

async function makeCache(key) {
  const dir = cacheDir(key, '1:1');
  fs.mkdirSync(dir, { recursive: true });
  const frame = JSON.parse(fs.readFileSync(fixtureFile('frame.json'), 'utf8'));
  await withPage({ url: fixture('card.html'), width: 300, height: 120, scale: 2 }, (page) => page.locator('#card').screenshot({ path: path.join(dir, 'baseline.png'), animations: 'disabled', caret: 'hide' }));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(flattenSpec(frame)));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ scale: 2, width: 300, height: 120 }));
}

test('batch writes one record per state x width, keeps going after a failure, and exits 1', { skip: !project }, async () => {
  const dir = tmp();
  const key = `ui-check-batch-test-${process.pid}`;
  await makeCache(key);
  try {
    const states = {
      defaults: { widths: [320] },
      states: [
        { surface: 'login', state: 'ltr', locale: 'en', url: fixture('ltr.html') },
        { surface: 'login', state: 'rtl-dropdown', locale: 'fa-IR', url: fixture('rtl.html'), expectDir: 'rtl', steps: [{ action: 'click', selector: '#menu' }, { action: 'waitFor', selector: '#list' }] },
        { surface: 'login', state: 'wrong-dir', locale: 'fa-IR', url: fixture('ltr.html'), expectDir: 'rtl' },
        { surface: 'home', state: 'card', url: fixture('card.html'), widths: [390], figma: { file: key, node: '1:1', map: fixtureFile('map.json'), root: '#card' } },
      ],
    };
    const file = path.join(dir, 'states.json');
    fs.writeFileSync(file, JSON.stringify(states));
    const result = await ui('batch', '--states', file, '--out', path.join(dir, 'out'));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const records = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'results.json'), 'utf8'));
    assert.deepEqual(records.map((r) => [r.surface, r.state, r.width, r.status]), [
      ['login', 'ltr', 320, 'pass'], ['login', 'rtl-dropdown', 320, 'fail'], ['login', 'wrong-dir', 320, 'fail'], ['home', 'card', null, 'pass'], ['home', 'card', 390, 'pass'],
    ]);
    assert.equal(records[1].findings[0].check, 'bidi-field');
    assert.match(records[2].findings[0].detail, /--expect-dir rtl/);
    assert.ok(fs.existsSync(records[0].evidence), 'evidence is the path of a report');
    assert.equal(fs.readFileSync(path.join(dir, 'out', 'summary.md'), 'utf8').split('\n').filter((l) => /^\| (login|home) /.test(l)).length, 5);
    const only = await ui('batch', '--states', file, '--only', 'home', '--out', path.join(dir, 'only'));
    assert.equal(only.code, 0, only.stdout + only.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'only', 'results.json'), 'utf8')).length, 2);
  } finally {
    fs.rmSync(cacheDir(key, '1:1'), { recursive: true, force: true });
    fs.rmdirSync(path.dirname(cacheDir(key, '1:1')));
  }
});
