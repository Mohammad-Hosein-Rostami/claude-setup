// Purpose: `compare` - element gate + pixel gate for one Figma frame vs the running page.
// Exports: options, pageOptions, compareOnce, loadMap, run. Invariants: viewport = frame size, DSF = scale; exit 0 pass / 1 fail; images stay on disk.
// The pixel gate is odiff plus the colour metric (lib/pixels.mjs); `--strict` is the strict rule (--max-diff 0, every pixel counted);
// broken eager images in the root are failing rows even without a map. Map skip entries {selector, skip, why} (padding, gap, hug width)
// show as SKIPPED rows; a render-bounds baseline is captured at the render bounds and its effect region judged on its own.
import fs from 'node:fs';
import path from 'node:path';
import { parse, need, toNumber } from '../lib/args.mjs';
import { loadChromium, launch, openPage } from '../lib/browser.mjs';
import { readCache } from '../lib/cache.mjs';
import { CONTEXT_OPTIONS, readContextFlags } from '../lib/context.mjs';
import { applySkips, brokenImageRows, compareElements, SKIP_PROPS } from '../lib/elements.mjs';
import { readPng } from '../lib/image.mjs';
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
  'no-autofocus': { type: 'boolean', default: false },
  'max-diff': { type: 'string', default: String(PIXEL.maxDiffPercent) },
  strict: { type: 'boolean', default: false }, // the strict pass rule (P3f): --max-diff 0 and the colour metric over every pixel
  ...CONTEXT_OPTIONS,
  out: { type: 'string' },
  project: { type: 'string' }, // default: current directory, then UI_CHECK_PROJECT, then the tool's own node_modules (lib/playwright.mjs)
};

const MIN_WHY_CHARS = 15;
const SKIP_KEYS = ['selector', 'skip', 'why'];

/** A map skip entry {selector, skip, why} (P3c): padding, gap and hug width only, always with a reason. @throws {UsageError} otherwise (exit 2) */
function readSkip(id, entry) {
  const unknown = entry && typeof entry === 'object' ? Object.keys(entry).filter((key) => !SKIP_KEYS.includes(key)) : [];
  if (!entry || typeof entry !== 'object' || typeof entry.selector !== 'string' || unknown.length > 0) throw new UsageError(`map.json ${id}: a selector string or {"selector", "skip", "why"}${unknown.length ? ` (unknown field ${unknown.join(', ')})` : ''}`);
  const props = Array.isArray(entry.skip) ? entry.skip : [];
  const wrong = props.filter((prop) => !Object.hasOwn(SKIP_PROPS, prop));
  if (props.length === 0 || wrong.length > 0) throw new UsageError(`map.json ${id}: skip lists only ${Object.keys(SKIP_PROPS).join(', ')} (never colour, font, x or y)${wrong.length ? `, got ${wrong.join(', ')}` : ''}`);
  if (typeof entry.why !== 'string' || entry.why.replace(/\s/g, '').length < MIN_WHY_CHARS) throw new UsageError(`map.json ${id}: a skip needs "why" (${MIN_WHY_CHARS}+ characters: the false positive the Figma data creates)`);
  return { props, why: entry.why.trim() };
}

/**
 * Read a map.json: Figma node id -> CSS selector, or -> {selector, skip, why} for a skip entry. Every id must exist in the spec.
 * @returns {{map: Record<string, string>, skips: Record<string, {props: string[], why: string}>}}
 * @throws {UsageError} on unknown ids, bad selectors or a bad skip entry
 */
export function loadMap(file, spec) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set(spec.nodes.map((n) => n.id));
  const bad = Object.entries(raw).filter(([id, entry]) => !ids.has(id) || (typeof entry !== 'string' && (entry === null || typeof entry !== 'object'))).map(([id]) => id);
  if (bad.length > 0) throw new UsageError(`map.json: unknown ids or non-string selectors: ${bad.join(', ')}`);
  const map = {};
  const skips = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') {
      map[id] = entry;
    } else {
      skips[id] = readSkip(id, entry);
      map[id] = entry.selector;
    }
  }
  return { map, skips };
}

const RENDER_MATCH_PX = 1; // the baseline is a render-bounds export when its size is the render bounds x scale, within this

/**
 * Render-bounds capture (r9-ui-states): when the baseline holds the node's absoluteRenderBounds (outside stroke, ring, shadow), capture the
 * same area and judge the part outside the node box as its own region. Null when the spec has no render bounds, they equal the box, or
 * the baseline holds the box only (then the effect region is not compared, and the report says so).
 */
function renderCapture(cache) {
  const { root } = cache.spec;
  const render = root?.render;
  if (!render || (render.x === 0 && render.y === 0 && render.w === root.w && render.h === root.h)) return null;
  const { scale } = cache.meta;
  const base = readPng(cache.baseline);
  const near = (a, b) => Math.abs(a - b) <= RENDER_MATCH_PX;
  if (!near(base.width, render.w * scale) || !near(base.height, render.h * scale)) return { render, nodeBox: null };
  return { render, nodeBox: { x: Math.round(-render.x * scale), y: Math.round(-render.y * scale), w: Math.round(root.w * scale), h: Math.round(root.h * scale) } };
}

async function capture(page, root, outDir, renderCap) {
  const actualFile = path.join(outDir, 'actual.png');
  const shot = { path: actualFile, animations: 'disabled', caret: 'hide' };
  if (!renderCap?.nodeBox) {
    await page.locator(root).first().screenshot(shot);
    return actualFile;
  }
  const box = await page.locator(root).first().boundingBox();
  const { render } = renderCap;
  await page.screenshot({ ...shot, clip: { x: box.x + render.x, y: box.y + render.y, width: render.w, height: render.h } });
  return actualFile;
}

/** Element rows of the mapped nodes (none without a map) plus a row per broken eager image in the root (G4, always). */
async function elementCheck(page, root, spec, map) {
  const items = Object.entries(map ?? {}).map(([id, selector]) => ({ id, selector }));
  const { rootFound, results, brokenImages } = await page.evaluate(measureInPage, { rootSelector: root, items });
  if (!rootFound) throw new UsageError(`root selector matched nothing: ${root}`);
  return [...(map ? compareElements(spec.nodes, map, results) : []), ...brokenImageRows(brokenImages)];
}

/** Figma TEXT boxes in device pixels of the capture (the colour metric leaves them out in a default run). */
const textBoxesOf = (spec, scale) => spec.nodes.filter((n) => n.type === 'TEXT').map((n) => ({ x: Math.floor(n.x * scale), y: Math.floor(n.y * scale), w: Math.ceil(n.w * scale), h: Math.ceil(n.h * scale) }));

function summarise(pixels, elementRows, mapped, renderCap) {
  const lines = [mapped ? `element check: ${elementRows.length === 0 ? 'pass' : `${elementRows.length} failing props`}` : 'element check: skipped (no --map)'];
  if (pixels.sizeMismatch) lines.push(`size mismatch: baseline ${pixels.sizeMismatch.baseline.join('x')} vs page ${pixels.sizeMismatch.actual.join('x')}`);
  if (renderCap && !renderCap.nodeBox) lines.push('effect region: not compared (the baseline holds the node box only; pull the render bounds)');
  lines.push(`pixel diff: ${pixels.diffPercent.toFixed(3)}% (${pixels.diffCount} px)`, `colour metric (channel > 2, ${pixels.drift.scope}): ${pixels.drift.percent.toFixed(3)}% (${pixels.drift.count} px)`);
  if (pixels.effect) lines.push(`effect region (outside the node box): ${pixels.effect.percent.toFixed(3)}% (${pixels.effect.count} px)`);
  const r = pixels.region;
  lines.push(r ? `diff region: x=${r.x} y=${r.y} w=${r.w} h=${r.h}` : 'diff region: none', pixels.diffCount ? 'diff image: diff.png' : 'diff image: none (exact match)');
  return lines;
}

/**
 * Build the openPage options for a compare run (kept separate so the steps/bypass wiring is testable).
 * @param {Record<string, unknown>} values parsed flags
 * @param {{width: number, height: number, scale: number}} meta cache meta.json
 * @param {object[]} steps validated steps
 * @param {object} [context] validated context (readContextFlags output); read from `values` when omitted
 * @returns {object} options for openPage
 */
export function pageOptions(values, { width, height, scale }, steps, context = readContextFlags(values)) {
  return { url: values.url, width: Math.ceil(width), height: Math.ceil(height), scale, steps, bypassCSP: values['bypass-csp'], autofocus: !values['no-autofocus'], ...context };
}

/**
 * Compare one page against a cached Figma frame on an already launched browser and write report.md/json, actual.png and diff.png.
 * @param {object} browser Playwright browser
 * @param {{pageOpts: object, root: string, cache: object, map: object|null, maxDiff: number, outDir: string, strict?: boolean, skips?: object, bands?: object[]}} job
 *   pageOpts as built by pageOptions; strict = the strict rule; skips = map skip entries (loadMap); bands = ignored bands {y, h} in CSS px (diagnostic states)
 * @returns {Promise<{pass: boolean, md: string, pixels: object, elementRows: object[]}>}
 * @throws {UsageError} when the root selector matches nothing or the page cannot be opened
 */
export async function compareOnce(browser, { pageOpts, root, cache, map, maxDiff, outDir, strict = false, skips = {}, bands = [] }) {
  fs.mkdirSync(outDir, { recursive: true });
  const page = await openPage(browser, pageOpts);
  if (await page.locator(root).count() === 0) throw new UsageError(`root selector matched nothing: ${root}`);
  const { rows: elementRows, skipped } = applySkips(await elementCheck(page, root, cache.spec, map), skips, strict);
  const renderCap = renderCapture(cache);
  const actualFile = await capture(page, root, outDir, renderCap);
  const { scale } = cache.meta;
  const deviceBands = bands.map((b) => ({ y: Math.floor(b.y * scale), h: Math.ceil(b.h * scale) }));
  const pixels = await pixelCheck({ baselineFile: cache.baseline, actualFile, outDir, maxDiffPercent: strict ? 0 : maxDiff, textBoxes: textBoxesOf(cache.spec, scale), strict, bands: deviceBands, nodeBox: renderCap?.nodeBox ?? null });
  const pass = elementRows.length === 0 && pixels.pass;
  const rows = [...elementRows, ...skipped].map((r) => [r.element, r.prop, r.is, r.should, r.delta]);
  const md = writeReport(outDir, {
    title: 'ui-check compare', verdict: pass ? 'PASS' : 'FAIL', summary: summarise(pixels, elementRows, Boolean(map), renderCap),
    head: ['element', 'prop', 'is', 'should', 'delta'], rows, data: { pixels, elementRows, skipped, maxDiffPercent: strict ? 0 : maxDiff, rule: strict ? 'strict' : 'default' },
  });
  return { pass, md, pixels, elementRows };
}

/** Run compare. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'url', 'root', 'cache');
  const maxDiff = toNumber(values['max-diff'], 'max-diff');
  const context = readContextFlags(values);
  const steps = values.steps !== undefined ? loadSteps(values.steps) : [];
  const cache = readCache(values.cache);
  const { map, skips } = values.map ? loadMap(values.map, cache.spec) : { map: null, skips: {} };
  const outDir = values.out ?? path.join(cache.dir, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  const browser = await launch(loadChromium(values.project));
  try {
    const pageOpts = pageOptions(values, cache.meta, steps, context);
    const { pass, md } = await compareOnce(browser, { pageOpts, root: values.root, cache, map, skips, maxDiff, outDir, strict: values.strict });
    console.log(`${pass ? 'PASS' : 'FAIL'} compare - report: ${md}`);
    return pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}
