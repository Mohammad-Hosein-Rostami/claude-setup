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
import { readDrawnFonts } from '../lib/drawn-fonts.mjs';
import { flattenSpec } from '../lib/spec.mjs';

const run = promisify(execFile);
const project = process.env.UI_CHECK_PROJECT;
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli.mjs');
const fixture = (name, query = '') => `${pathToFileURL(path.join(here, 'fixtures', name)).href}${query}`;
const ABSENT = 'absent'; // card.html?font=absent: the title asks for ABSENT_FAMILY, a family no machine has
const ABSENT_FAMILY = 'UiCheckAbsentFont';

async function ui(...args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, '--project', project]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }; // stderr explains an exit-2 setup error
  }
}

/** A cache of frame.json whose baseline is a capture of `url` (default: the card as built); `titleFamily` replaces the title's Figma font. */
async function makeCache(dir, url = fixture('card.html'), titleFamily = undefined) {
  const frame = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'frame.json'), 'utf8'));
  if (titleFamily !== undefined) frame.children.find((node) => node.id === '1:2').style.fontFamily = titleFamily;
  const browser = await launch(loadChromium(project));
  const page = await openPage(browser, { url, width: 300, height: 120, scale: 2 });
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

test('readDrawnFonts reads Inter for the card title with its web font loaded, and a fallback without it', { skip: !project }, async () => {
  const browser = await launch(loadChromium(project));
  try {
    const read = async (url) => readDrawnFonts(await openPage(browser, { url, width: 300, height: 120 }), '#card', [{ id: 't', selector: 'h1' }, { id: 'gone', selector: '#nope' }]);
    const loaded = await read(fixture('card.html'));
    assert.deepEqual(loaded.t, { fonts: [{ family: 'Inter', glyphs: 5 }] });
    assert.deepEqual(loaded.gone, { unknown: 'element not found for the font read' });
    const fallback = await read(fixture('card.html', `?font=${ABSENT}`));
    assert.equal(fallback.t.fonts.length, 1);
    assert.notEqual(fallback.t.fonts[0].family, ABSENT_FAMILY);
    assert.ok(fallback.t.fonts[0].glyphs > 0);
  } finally {
    await browser.close();
  }
});

// `card.html?font=absent` asks for a family no machine has installed (Inter itself may be installed somewhere, and Chromium then draws
// it even when the page's web font fails), with the Figma title set to that family: the computed font-family matches Figma while a
// fallback draws the title. The baseline is that same page, so pixels and CSS agree and only the drawn-font row can fail.
test('compare fails a page whose requested font is not drawn (a fallback), even when its pixels match the baseline', { skip: !project }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-smoke-font-'));
  const absent = fixture('card.html', `?font=${ABSENT}`);
  await makeCache(dir, absent, ABSENT_FAMILY);
  const result = await ui('compare', '--root', '#card', '--cache', dir, '--map', path.join(here, 'fixtures', 'map.json'), '--url', absent, '--out', path.join(dir, 'a'));
  assert.equal(result.code, 1, result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'a', 'report.json'), 'utf8'));
  assert.equal(report.pixels.diffCount, 0);
  assert.deepEqual(report.elementRows.map((r) => r.prop), ['font-family (drawn)']);
  const [row] = report.elementRows;
  assert.equal(row.should, ABSENT_FAMILY);
  assert.match(row.delta, new RegExp(`^requested ${ABSENT_FAMILY}, drawn (?!${ABSENT_FAMILY}\\b)\\S`));
  assert.doesNotMatch(row.is, new RegExp(ABSENT_FAMILY));
});
