// Purpose: end-to-end smoke test of compare and responsive against static fixtures.
// Runs only when UI_CHECK_PROJECT points at a project with Playwright and Chromium installed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { flattenSpec } from '../lib/spec.mjs';

const run = promisify(execFile);
const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const fixture = (name, query = '') => `${pathToFileURL(path.join(here, 'fixtures', name)).href}${query}`;

async function ui(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }; // stderr explains an exit-2 setup error
  }
}

async function makeCache(dir) {
  const frame = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'frame.json'), 'utf8'));
  const browser = await launch(loadChromium(project));
  const page = await openPage(browser, { url: fixture('card.html'), width: 300, height: 120, scale: 2 });
  await page.locator('#card').screenshot({ path: path.join(dir, 'baseline.png'), animations: 'disabled', caret: 'hide' });
  await browser.close();
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(flattenSpec(frame)));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ scale: 2, width: 300, height: 120 }));
}

test('compare passes unchanged, fails a 4px padding change; responsive flags a 500px box at 320', { skip: !project }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-smoke-'));
  await makeCache(dir);
  const map = path.join(here, 'fixtures', 'map.json');
  const base = ['compare', '--root', '#card', '--cache', dir, '--map', map];
  const same = await ui(...base, '--url', fixture('card.html'), '--out', path.join(dir, 'a'));
  assert.equal(same.code, 0, same.stdout);
  const changed = await ui(...base, '--url', fixture('card.html', '?padl=20'), '--out', path.join(dir, 'b'));
  assert.equal(changed.code, 1, changed.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'b', 'report.md'), 'utf8'), /padding-left \| 20 \| 16 \| 4/);
  const narrow = await ui('responsive', '--url', fixture('wide.html'), '--widths', '320', '--out', path.join(dir, 'c'));
  assert.equal(narrow.code, 1, narrow.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'c', 'report.md'), 'utf8'), /hscroll/);
});
