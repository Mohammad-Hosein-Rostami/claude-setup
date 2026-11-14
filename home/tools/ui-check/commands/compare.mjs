// Purpose: `compare` - element gate + pixel gate for one Figma frame vs the running page.
// Exports: options, run. Invariants: viewport = frame size, DSF = scale; exit 0 pass / 1 fail; images stay on disk.
import fs from 'node:fs';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { compareElements } from '../lib/elements.mjs';
import { UsageError } from '../lib/errors.mjs';
import { loadSteps } from '../lib/steps.mjs';
import { measureInPage } from '../lib/measure.mjs';
import { pixelCheck } from '../lib/pixels.mjs';
import { writeReport } from '../lib/report.mjs';
import { PIXEL } from '../lib/tolerances.mjs';

export const options = {
  url: { type: 'string' },
  root: { type: 'string' },
  cache: { type: 'string' },
  map: { type: 'string' },
  steps: { type: 'string' },
  'bypass-csp': { type: 'boolean', default: false },
  'max-diff': { type: 'string', default: String(PIXEL.maxDiffPercent) },
  out: { type: 'string' },
  project: { type: 'string', default: process.cwd() },
};

function loadMap(file, spec) {
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set(spec.nodes.map((n) => n.id));
  const bad = Object.entries(map).filter(([id, sel]) => !ids.has(id) || typeof sel !== 'string').map(([id]) => id);
  if (bad.length > 0) throw new UsageError(`map.json: unknown ids or non-string selectors: ${bad.join(', ')}`);
  return map;
}

async function capture(page, root, outDir) {
  const actualFile = path.join(outDir, 'actual.png');
  await page.locator(root).first().screenshot({ path: actualFile, animations: 'disabled', caret: 'hide' });
  return actualFile;
}

async function elementCheck(page, root, spec, map) {
  const items = Object.entries(map).map(([id, selector]) => ({ id, selector }));
  const { rootFound, results } = await page.evaluate(measureInPage, { rootSelector: root, items });
  if (!rootFound) throw new UsageError(`root selector matched nothing: ${root}`);
  return compareElements(spec.nodes, map, results);
}

function summarise(pixels, elementRows, mapped) {
  const lines = [mapped ? `element check: ${elementRows.length === 0 ? 'pass' : `${elementRows.length} failing props`}` : 'element check: skipped (no --map)'];
  if (pixels.sizeMismatch) lines.push(`size mismatch: baseline ${pixels.sizeMismatch.baseline.join('x')} vs page ${pixels.sizeMismatch.actual.join('x')}`);
  lines.push(`pixel diff: ${pixels.diffPercent.toFixed(3)}% (${pixels.diffCount} px)`);
  const r = pixels.region;
  lines.push(r ? `diff region: x=${r.x} y=${r.y} w=${r.w} h=${r.h}` : 'diff region: none', pixels.diffCount ? 'diff image: diff.png' : 'diff image: none (exact match)');
  return lines;
}

/** Run compare. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url', 'root', 'cache');
  const maxDiff = toNumber(values['max-diff'], 'max-diff');
  const steps = values.steps ? loadSteps(values.steps) : [];
  const cache = readCache(values.cache);
  const map = values.map ? loadMap(values.map, cache.spec) : null;
  const outDir = values.out ?? path.join(cache.dir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch(loadChromium(values.project));
  try {
    const { scale, width, height } = cache.meta;
    const page = await openPage(browser, { url: values.url, width: Math.ceil(width), height: Math.ceil(height), scale, steps, bypassCSP: values['bypass-csp'] });
    if (await page.locator(values.root).count() === 0) throw new UsageError(`root selector matched nothing: ${values.root}`);
    const elementRows = map ? await elementCheck(page, values.root, cache.spec, map) : [];
    const actualFile = await capture(page, values.root, outDir);
    const pixels = await pixelCheck({ baselineFile: cache.baseline, actualFile, outDir, maxDiffPercent: maxDiff });
    const pass = elementRows.length === 0 && pixels.pass;
    const rows = elementRows.map((r) => [r.element, r.prop, r.is, r.should, r.delta]);
    const md = writeReport(outDir, {
      title: 'ui-check compare', verdict: pass ? 'PASS' : 'FAIL', summary: summarise(pixels, elementRows, Boolean(map)),
      head: ['element', 'prop', 'is', 'should', 'delta'], rows, data: { pixels, elementRows, maxDiffPercent: maxDiff },
    });
    console.log(`${pass ? 'PASS' : 'FAIL'} compare - report: ${md}`);
    return pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}
